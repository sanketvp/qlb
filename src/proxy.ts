import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { dirname } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

import {
  applyCodexEffort,
  harnessForPath,
  resolvePolicy,
  unmappedErrorBody,
} from './policy';
import { resolveFromSnapshots, snapshotsFromStore } from './resolve';
import { config } from './config';
import {
  attemptWithNativeResyncRetry,
  nativeResyncAuditEntry,
  type ResyncResult,
} from './native-resync';
import type { Store } from './store';
import type { BucketReading } from './types';

export const PROXY_BIND_HOST = '127.0.0.1';
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_PROXY_INFO_PATH = config.proxyInfoPath;

const ALLOWED_PATHS = new Set([
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/responses',
  '/backend-api/codex/responses',
  '/qlb/health',
]);

const DEFAULT_UPSTREAMS = {
  anthropicBase: 'https://api.anthropic.com',
  codexBase: 'https://chatgpt.com',
};

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const AUTH_FAIL_WINDOW_MS = 60_000;
const AUTH_FAIL_LIMIT = 10;

export interface ProxyInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
}

export type GetCredentialForAccount = (accountId: string) => Promise<string>;

/** Runtime source: `createOwnedCredentialSource` in `./credentials`. Tests inject a mock. */
export type ResyncFromNative = (accountId: string, provider: string) => Promise<ResyncResult>;

export interface ProxyOptions {
  store: Store;
  /** Tests MUST pass a temp path. Default is ~/.qlb/proxy.json. */
  infoPath?: string;
  idleTimeoutMs?: number;
  getCredentialForAccount: GetCredentialForAccount;
  /**
   * Optional. When set, an upstream 401 triggers exactly one native-resync
   * attempt and, if the credential actually drifted, one retry of the same
   * request. Tests inject a mock; production wires `bindDetectAndResync`.
   */
  resyncFromNative?: ResyncFromNative;
  upstreams?: {
    anthropicBase?: string;
    codexBase?: string;
  };
  onIdle?: () => void;
}

export function tokensEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function extractClientToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)/i.exec(auth);
    if (m) return m[1];
  }
  const key = req.headers['x-api-key'];
  if (typeof key === 'string' && key.length > 0) return key;
  if (Array.isArray(key) && typeof key[0] === 'string') return key[0];
  return undefined;
}

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function hostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
  ]);
  return allowed.has(host);
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  if (!req.readableEnded) req.resume();
  if (res.headersSent) return;
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

function atomicWrite0600(path: string, contents: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, contents, { encoding: 'utf8' });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows cannot honor Unix modes.
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

function parseJsonObject(buf: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(buf.toString('utf8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer | string) => {
      const buf = typeof c === 'string' ? Buffer.from(c) : c;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseResetAt(headers: Record<string, string>, bucket: string, now: number): number | undefined {
  const at = headers[`x-codex-${bucket}-reset-at`];
  if (at) {
    const asNum = Number(at);
    if (Number.isFinite(asNum) && asNum > 1_000_000_000_000) return asNum;
    if (Number.isFinite(asNum) && asNum > 1_000_000_000) return asNum * 1000;
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) return parsed;
  }
  const after = headers[`x-codex-${bucket}-reset-after-seconds`];
  if (after) {
    const sec = Number(after);
    if (Number.isFinite(sec)) return now + sec * 1000;
  }
  return undefined;
}

/**
 * Extract quota gauges from proxied response headers into snapshot-cache
 * readings. Codex: x-codex-* (authoritative). Anthropic: ratelimit headers
 * when present (advisory). Never inspects response bodies.
 */
export function parseUsageHeaders(
  headers: IncomingHttpHeaders | Record<string, string>,
  now: number = Date.now(),
): Record<string, BucketReading> {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    lower[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v);
  }

  const out: Record<string, BucketReading> = {};
  for (const [k, v] of Object.entries(lower)) {
    const m = /^x-codex-(.+)-used-percent$/.exec(k);
    if (!m) continue;
    const bucket = m[1];
    const usedPct = Number(v);
    if (!Number.isFinite(usedPct)) continue;
    const reading: BucketReading = {
      usedPct,
      source: 'headers',
      confidence: 'authoritative',
      fetchedAt: now,
    };
    const resetAt = parseResetAt(lower, bucket, now);
    if (resetAt != null) reading.resetAt = resetAt;
    out[bucket] = reading;
  }

  const reqLim = Number(lower['anthropic-ratelimit-requests-limit']);
  const reqRem = Number(lower['anthropic-ratelimit-requests-remaining']);
  if (Number.isFinite(reqLim) && Number.isFinite(reqRem) && reqLim > 0) {
    out.requests = {
      usedPct: ((reqLim - reqRem) / reqLim) * 100,
      used: reqLim - reqRem,
      limit: reqLim,
      remaining: reqRem,
      source: 'headers',
      confidence: 'advisory',
      fetchedAt: now,
    };
  }

  return out;
}

function upstreamUrl(
  harness: 'claude-code' | 'codex',
  pathname: string,
  bases: { anthropicBase: string; codexBase: string },
): string {
  if (harness === 'claude-code') {
    return `${bases.anthropicBase.replace(/\/$/, '')}${pathname}`;
  }
  // Translate Codex CLI /v1/responses → chatgpt backend path.
  const path =
    pathname === '/v1/responses' ? '/backend-api/codex/responses' : pathname;
  return `${bases.codexBase.replace(/\/$/, '')}${path}`;
}

function hopByHop(): Set<string> {
  return new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'transfer-encoding',
    'upgrade',
    'host',
    'content-length',
  ]);
}

function forwardHeaders(
  clientHeaders: IncomingHttpHeaders,
  extra: Record<string, string>,
  contentLength: number,
): http.OutgoingHttpHeaders {
  const skip = hopByHop();
  skip.add('authorization');
  skip.add('x-api-key');
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    if (v == null) continue;
    const lk = k.toLowerCase();
    if (skip.has(lk)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v;
  }
  out['content-length'] = contentLength;
  return out;
}

function discardIncoming(res: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    if (res.readableEnded) {
      resolve();
      return;
    }
    res.resume();
    res.on('end', () => resolve());
    res.on('close', () => resolve());
    res.on('error', () => resolve());
  });
}

function requestUpstream(
  urlStr: string,
  method: string,
  headers: http.OutgoingHttpHeaders,
  body: Buffer,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers,
      },
      (res) => resolve(res),
    );
    req.on('error', reject);
    req.end(body);
  });
}

function sessionId(req: IncomingMessage, harness: string, virtualModel: string): string {
  const raw = req.headers['x-qlb-session'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header === 'string' && header.trim().length > 0) return header.trim();
  return `anon:${harness}:${virtualModel}`;
}

export class LoopbackProxy {
  readonly infoPath: string;
  readonly idleTimeoutMs: number;
  private readonly store: Store;
  private readonly getCredential: GetCredentialForAccount;
  private readonly resyncFromNative?: ResyncFromNative;
  private readonly upstreams: { anthropicBase: string; codexBase: string };
  private readonly onIdle?: () => void;
  private readonly token: string;
  private readonly startedAt: number;
  private server: http.Server | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;
  private stopped = false;
  private info: ProxyInfo | null = null;
  private authFailTs: number[] = [];
  private sessionHeaderWarned = false;

  constructor(opts: ProxyOptions) {
    this.store = opts.store;
    this.infoPath = opts.infoPath ?? DEFAULT_PROXY_INFO_PATH;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.getCredential = opts.getCredentialForAccount;
    this.resyncFromNative = opts.resyncFromNative;
    this.upstreams = {
      anthropicBase: opts.upstreams?.anthropicBase ?? DEFAULT_UPSTREAMS.anthropicBase,
      codexBase: opts.upstreams?.codexBase ?? DEFAULT_UPSTREAMS.codexBase,
    };
    this.onIdle = opts.onIdle;
    this.token = randomBytes(32).toString('hex');
    this.startedAt = Date.now();
  }

  get proxyInfo(): ProxyInfo {
    if (!this.info) throw new Error('proxy not started');
    return this.info;
  }

  address(): AddressInfo {
    const addr = this.server?.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('proxy not listening');
    }
    return addr;
  }

  async start(): Promise<ProxyInfo> {
    if (this.server) return this.proxyInfo;
    this.stopped = false;
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      // Hardcoded loopback. Never bind 0.0.0.0 / :: .
      this.server!.listen(0, PROXY_BIND_HOST, () => resolve());
    });

    const addr = this.address();
    if (addr.address !== PROXY_BIND_HOST) {
      await this.stop();
      throw new Error(`refusing non-loopback bind: ${addr.address}`);
    }

    this.info = {
      port: addr.port,
      token: this.token,
      pid: process.pid,
      startedAt: this.startedAt,
    };
    atomicWrite0600(this.infoPath, JSON.stringify(this.info));
    this.armIdle();
    return this.info;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearIdle();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    try {
      if (existsSync(this.infoPath)) unlinkSync(this.infoPath);
    } catch {
      // best-effort
    }
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.stopped || this.inFlight > 0) return;
    this.idleTimer = setTimeout(() => {
      void this.idleExit();
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async idleExit(): Promise<void> {
    if (this.inFlight > 0 || this.stopped) return;
    await this.stop();
    this.onIdle?.();
  }

  private noteAuthFail(): 'ok' | 'limited' {
    const now = Date.now();
    this.authFailTs = this.authFailTs.filter((t) => t > now - AUTH_FAIL_WINDOW_MS);
    if (this.authFailTs.length >= AUTH_FAIL_LIMIT) return 'limited';
    this.authFailTs.push(now);
    return 'ok';
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.clearIdle();
    this.inFlight += 1;
    try {
      await this.handleInner(req, res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Structured metadata only — never request/response bodies.
      try {
        this.store.recordDecision({
          harness: null,
          requested_model: '',
          mode: 'proxy_error',
          reason: msg,
          snapshot_json: JSON.stringify({ status: 500 }),
        });
      } catch {
        // store errors must not crash the proxy
      }
      sendJson(req, res, 500, { error: 'qlb_proxy_error' });
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0) this.armIdle();
    }
  }

  private async handleInner(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. Auth FIRST — before Host, path, or body.
    const provided = extractClientToken(req);
    if (!provided || !tokensEqual(this.token, provided)) {
      const limited = this.noteAuthFail() === 'limited';
      try {
        this.store.recordDecision({
          harness: null,
          requested_model: '',
          mode: 'proxy_auth_reject',
          reason: provided ? 'invalid' : 'missing',
          snapshot_json: JSON.stringify({ status: limited ? 429 : 401 }),
        });
      } catch {
        // ignore
      }
      // eslint-disable-next-line no-console
      console.error(`qlb-proxy: proxy_auth_reject reason=${provided ? 'invalid' : 'missing'}`);
      if (limited) {
        sendJson(req, res, 429, { error: 'qlb_unauthorized' });
        return;
      }
      sendJson(req, res, 401, { error: 'qlb_unauthorized' });
      return;
    }

    const remote = req.socket.remoteAddress;
    if (!isLoopbackAddress(remote)) {
      sendJson(req, res, 403, { error: 'qlb_forbidden' });
      return;
    }

    const port = this.info?.port ?? this.address().port;
    const hostHdr = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
    if (!hostAllowed(hostHdr, port)) {
      sendJson(req, res, 403, { error: 'qlb_forbidden' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${PROXY_BIND_HOST}:${port}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/qlb/health') {
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (!ALLOWED_PATHS.has(pathname) || req.method !== 'POST') {
      sendJson(req, res, 404, { error: 'qlb_not_found' });
      return;
    }

    const harness = harnessForPath(pathname);
    if (!harness) {
      sendJson(req, res, 404, { error: 'qlb_not_found' });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(req, res, 413, { error: 'qlb_body_too_large' });
      return;
    }

    const body = parseJsonObject(raw);
    if (!body) {
      sendJson(req, res, 400, unmappedErrorBody(harness, ''));
      return;
    }

    const virtualModel = typeof body.model === 'string' ? body.model : '';
    const policy = resolvePolicy(this.store, harness, virtualModel);
    if (!policy) {
      try {
        this.store.recordDecision({
          harness,
          requested_model: virtualModel,
          mode: 'policy_unmapped',
          reason: 'unmapped virtual model',
          snapshot_json: JSON.stringify({ status: 400 }),
        });
      } catch {
        // ignore
      }
      sendJson(req, res, 400, unmappedErrorBody(harness, virtualModel));
      return;
    }

    const sid = sessionId(req, harness, virtualModel);
    if (sid.startsWith('anon:') && !this.sessionHeaderWarned) {
      this.sessionHeaderWarned = true;
      // eslint-disable-next-line no-console
      console.error('qlb-proxy: session_header_missing; using anon:<harness>:<virtualModel>');
    }

    const snapshots = snapshotsFromStore(this.store);
    const decision = resolveFromSnapshots({
      model: policy.realModel,
      fallback: policy.fallback,
      session: sid,
      harness,
      effort: policy.effort,
      snapshots,
      store: this.store,
    });

    if (!decision.ok) {
      if (decision.error === 'PINNED_UNAVAILABLE') {
        sendJson(req, res, 503, {
          error: 'PINNED_UNAVAILABLE',
          accountId: decision.accountId,
          reason: decision.reason,
        });
        return;
      }
      sendJson(req, res, 503, {
        error: 'EXHAUSTED',
        earliestReset: decision.earliestReset,
      });
      return;
    }

    let credential: string;
    try {
      credential = await this.getCredential(decision.accountId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(req, res, 502, { error: 'qlb_credential_unavailable', message: msg });
      return;
    }

    const rewrite = { ...body, model: decision.servedModel };
    let effortRaised = false;
    if (harness === 'codex') {
      effortRaised = applyCodexEffort(rewrite, policy.effort);
    }
    const forwardBody = Buffer.from(JSON.stringify(rewrite));

    const extra: Record<string, string> = {
      authorization: `Bearer ${credential}`,
    };
    if (harness === 'claude-code') {
      extra['anthropic-beta'] = 'oauth-2025-04-20';
    } else {
      extra['chatgpt-account-id'] = decision.accountId;
      extra.originator = 'codex_cli_rs';
    }

    const target = upstreamUrl(harness, pathname, this.upstreams);
    const t0 = Date.now();
    const requestOnce = async (): Promise<IncomingMessage> => {
      extra.authorization = `Bearer ${await this.getCredential(decision.accountId)}`;
      return requestUpstream(
        target,
        'POST',
        forwardHeaders(req.headers, extra, forwardBody.length),
        forwardBody,
      );
    };
    let upRes: IncomingMessage;
    try {
      if (this.resyncFromNative) {
        const provider =
          this.store.getAccount(decision.accountId)?.provider ?? 'unknown';
        const wrapped = await attemptWithNativeResyncRetry({
          attempt: requestOnce,
          isAuthFailure: (res) => res.statusCode === 401,
          resync: () => this.resyncFromNative!(decision.accountId, provider),
          onResync: (result) => {
            try {
              this.store.recordDecision({
                session: sid,
                harness,
                requested_model: policy.realModel,
                effort: policy.effort,
                served_model: decision.servedModel,
                account_id: decision.accountId,
                mode: 'native_resync',
                reason: result.reason,
                snapshot_json: JSON.stringify(
                  nativeResyncAuditEntry({ provider, accountId: decision.accountId, result }),
                ),
              });
            } catch {
              // store errors must not crash the proxy
            }
          },
          discardFirst: discardIncoming,
        });
        upRes = wrapped.result;
      } else {
        extra.authorization = `Bearer ${credential}`;
        upRes = await requestUpstream(
          target,
          'POST',
          forwardHeaders(req.headers, extra, forwardBody.length),
          forwardBody,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.recordDecision({
        session: sid,
        harness,
        requested_model: policy.realModel,
        effort: policy.effort,
        served_model: decision.servedModel,
        account_id: decision.accountId,
        mode: 'proxy_upstream_error',
        reason: msg,
        snapshot_json: JSON.stringify({ status: 502, ms: Date.now() - t0 }),
      });
      sendJson(req, res, 502, { error: 'qlb_upstream_unreachable' });
      return;
    }

    const now = Date.now();
    const readings = parseUsageHeaders(upRes.headers, now);
    for (const [bucket, reading] of Object.entries(readings)) {
      this.store.upsertSnapshot(decision.accountId, bucket, reading);
    }

    this.store.recordDecision({
      session: sid,
      harness,
      requested_model: policy.realModel,
      effort: policy.effort,
      served_model: decision.servedModel,
      account_id: decision.accountId,
      mode: 'proxy',
      reason: `proxied ${upRes.statusCode ?? 0} ${now - t0}ms via ${decision.accountId}`,
      snapshot_json: JSON.stringify({
        status: upRes.statusCode ?? 0,
        ms: now - t0,
        accountId: decision.accountId,
        buckets: Object.keys(readings),
      }),
    });

    const skip = hopByHop();
    const outHeaders: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (v == null) continue;
      if (skip.has(k.toLowerCase())) continue;
      outHeaders[k] = v;
    }
    if (effortRaised) outHeaders['x-qlb-effort-raised'] = '1';

    res.writeHead(upRes.statusCode ?? 502, outHeaders);
    upRes.pipe(res);
    await new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
    });
  }
}
