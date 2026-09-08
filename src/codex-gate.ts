import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as http from 'node:http';
import { config } from './config';
import { promisify } from 'node:util';

import type { Store } from './store';

const execFileAsync = promisify(execFile);

export const CODEX_GATE_CONFIG_KEY = 'codex_gate_result';
export const CODEX_BACKEND_URL = 'https://chatgpt.com/backend-api/codex/responses';
const AUTH_PATH = config.codexAuthJsonPath;

export type GateVerdict = 'GO' | 'NO-GO';
export type GateStepId = 'G0' | 'G1' | 'G2' | 'G3' | 'G4';

export interface GateStepResult {
  step: GateStepId;
  passed: boolean;
  skipped?: boolean;
  detail: string;
}

export interface CodexGateHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface G0Capture {
  ok: boolean;
  bodyShape?: {
    model?: unknown;
    hasInput?: boolean;
    hasInstructions?: boolean;
    stream?: unknown;
    store?: unknown;
    keys?: string[];
  };
  headersRedacted?: Record<string, string>;
  path?: string;
  limitation?: string;
  rawPrompt?: string;
}

export interface CodexGateResult {
  verdict: GateVerdict;
  timestamp: number;
  codexVersion: string | null;
  steps: GateStepResult[];
  path?: 'path1' | 'path2';
}

export interface CodexAuth {
  accessToken: string;
  accountId: string;
}

export interface CodexGateDeps {
  whichCodex(): Promise<string | null>;
  getCodexVersion(): Promise<string | null>;
  captureG0(): Promise<G0Capture>;
  /** Mockable HTTP layer — tests inject this and MUST NOT hit real backends. */
  sendCodexRequest(body: unknown, label: string): Promise<CodexGateHttpResponse>;
  attemptG2?(): Promise<{ passed: boolean; detail: string; skipped?: boolean }>;
  now?(): number;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJwtPayload(token: string): JsonObject | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return isObject(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function stringClaim(payload: JsonObject | undefined, name: string): string | undefined {
  if (!payload) return undefined;
  const direct = payload[name];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  for (const value of Object.values(payload)) {
    if (!isObject(value)) continue;
    const nested = value[name];
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return undefined;
}

export async function readCodexAuthFromDisk(
  path: string = AUTH_PATH,
): Promise<CodexAuth | null> {
  try {
    const auth = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isObject(auth) || !isObject(auth.tokens)) return null;
    const accessToken = auth.tokens.access_token;
    if (typeof accessToken !== 'string' || accessToken.trim().length === 0) return null;
    const idToken = auth.tokens.id_token;
    const payload = typeof idToken === 'string' ? parseJwtPayload(idToken) : undefined;
    const accountId =
      stringClaim(payload, 'chatgpt_account_id') ??
      (typeof auth.tokens.account_id === 'string' ? auth.tokens.account_id : 'codex-default');
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

function redactHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    const val = Array.isArray(v) ? v.join(',') : String(v);
    out[k] = /auth|token|key|cookie/i.test(k) ? '[redacted]' : val;
  }
  return out;
}

function summarizeBody(raw: string): G0Capture['bodyShape'] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) return { keys: [] };
    return {
      model: parsed.model,
      hasInput: Object.prototype.hasOwnProperty.call(parsed, 'input'),
      hasInstructions: Object.prototype.hasOwnProperty.call(parsed, 'instructions'),
      stream: parsed.stream,
      store: parsed.store,
      keys: Object.keys(parsed),
    };
  } catch {
    return { keys: [] };
  }
}

function defaultG1Body(capture: G0Capture): JsonObject {
  const model =
    typeof capture.bodyShape?.model === 'string' && capture.bodyShape.model.length > 0
      ? capture.bodyShape.model
      : 'gpt-5.4';
  return {
    model,
    instructions: 'reply with the single word pong',
    input: 'reply with the single word pong',
    stream: true,
    store: false,
  };
}

function isSuccessfulCodexResponse(res: CodexGateHttpResponse): boolean {
  if (res.status < 200 || res.status >= 300) return false;
  const body = res.body ?? '';
  if (body.includes('event:') || body.includes('data:')) return true;
  try {
    const parsed = JSON.parse(body) as unknown;
    return isObject(parsed);
  } catch {
    return body.trim().length > 0;
  }
}

function extractEventTypes(body: string): string[] {
  const types: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('event:')) types.push(line.slice(6).trim());
  }
  return types;
}

export function defaultG1BodyFromCapture(capture: G0Capture): JsonObject {
  return defaultG1Body(capture);
}

/**
 * G0–G4 Codex CLI compatibility gate (§4.9.2a).
 * Tests MUST inject sendCodexRequest (and typically captureG0) so no real
 * ChatGPT/Codex/Anthropic traffic is generated by the automated suite.
 * The real command `qlb gate codex` uses createDefaultCodexGateDeps().
 */
export async function runCodexGate(
  store: Store,
  deps: CodexGateDeps,
): Promise<CodexGateResult> {
  const now = deps.now ?? Date.now;
  const timestamp = now();
  const steps: GateStepResult[] = [];
  const codexVersion = await deps.getCodexVersion();

  const g0 = await deps.captureG0();
  const g0Pass =
    g0.ok &&
    !!g0.bodyShape &&
    g0.bodyShape.model != null &&
    (g0.bodyShape.hasInput === true || g0.bodyShape.hasInstructions === true) &&
    g0.bodyShape.stream === true;
  steps.push({
    step: 'G0',
    passed: g0Pass,
    skipped: !g0.ok && !!g0.limitation,
    detail: g0.ok
      ? `captured path=${g0.path ?? 'unknown'} keys=${(g0.bodyShape?.keys ?? []).join(',')}`
      : (g0.limitation ?? 'G0 capture failed'),
  });

  const body = defaultG1Body(g0);
  const g1Responses: CodexGateHttpResponse[] = [];
  let g1Passed = 0;
  const g1Errors: string[] = [];
  for (let i = 0; i < 3; i++) {
    try {
      const res = await deps.sendCodexRequest(body, `G1-${i + 1}`);
      g1Responses.push(res);
      if (isSuccessfulCodexResponse(res)) g1Passed += 1;
      else g1Errors.push(`G1-${i + 1} status=${res.status}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      g1Errors.push(`G1-${i + 1} ${msg}`);
    }
  }
  const g1Ok = g1Passed === 3;
  steps.push({
    step: 'G1',
    passed: g1Ok,
    detail: g1Ok
      ? '3/3 successful (200-range, valid SSE/JSON)'
      : `passed ${g1Passed}/3; ${g1Errors.join('; ')}`,
  });

  let g2: GateStepResult;
  if (deps.attemptG2) {
    const r = await deps.attemptG2();
    g2 = {
      step: 'G2',
      passed: r.passed,
      skipped: r.skipped,
      detail: r.detail,
    };
  } else {
    g2 = {
      step: 'G2',
      passed: false,
      skipped: true,
      detail:
        'G2 skipped: a real tool-call round-trip needs a live Codex CLI session ' +
        '(e.g. `codex exec "run: echo qlb-gate-ok"`) so the CLI can execute a shell ' +
        'tool and feed the result back. A single HTTP request cannot complete that ' +
        'loop. Smoke-test manually; not faked as success here.',
    };
  }
  steps.push(g2);

  // G3 (chatgpt_base_url path) only if G1/G2 fail. Not implemented this pass.
  const g1g2Failed = !g1Ok && !(g2.passed || g2.skipped);
  if (g1g2Failed) {
    steps.push({
      step: 'G3',
      passed: false,
      skipped: true,
      detail:
        'G3 skipped this pass: chatgpt_base_url fallback path exists per spec §4.9.2a ' +
        'but is not implemented/tested here. Follow-up if Path 1 stays NO-GO.',
    });
  } else {
    steps.push({
      step: 'G3',
      passed: true,
      skipped: true,
      detail: g1Ok
        ? 'G3 not required (G1 passed Path 1)'
        : 'G3 not required (G2 skipped, not a Path-1 failure)',
    });
  }

  let g4Passed = false;
  let g4Detail: string;
  if (!g1Ok || g1Responses.length === 0) {
    g4Detail = 'G4 skipped: no successful G1 responses to compare';
  } else {
    const eventSets = g1Responses.map((r) => extractEventTypes(r.body));
    const withEvents = eventSets.filter((e) => e.length > 0);
    if (withEvents.length >= 2) {
      const first = withEvents[0].join(',');
      g4Passed = withEvents.every((e) => e.join(',') === first);
      g4Detail = g4Passed
        ? `structural parity: event types ${first}`
        : `event-type mismatch across G1 responses: ${withEvents.map((e) => e.join('>')).join(' vs ')}`;
    } else if (g1Responses.every((r) => isSuccessfulCodexResponse(r))) {
      g4Passed = true;
      g4Detail =
        'best-effort G4: G1 bodies are valid SSE/JSON and consistent in success shape; ' +
        'no Codex CLI direct-response capture was available for a stricter compare';
    } else {
      g4Detail = 'G4 could not establish structural parity';
    }
  }
  steps.push({
    step: 'G4',
    passed: g4Passed,
    skipped: !g1Ok,
    detail: g4Detail,
  });

  const verdict: GateVerdict = g1Ok ? 'GO' : 'NO-GO';
  const result: CodexGateResult = {
    verdict,
    timestamp,
    codexVersion,
    steps,
    path: g1Ok ? 'path1' : undefined,
  };
  store.setConfig(CODEX_GATE_CONFIG_KEY, JSON.stringify(result));
  return result;
}

async function whichCodexDefault(): Promise<string | null> {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileAsync(finder, ['codex'], { encoding: 'utf8' });
    const found = stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
    return found.length > 0 ? found : null;
  } catch {
    return null;
  }
}

async function getCodexVersionDefault(): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync('codex', ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const text = (stdout || stderr).trim();
    return text.length > 0 ? text.split('\n')[0] : null;
  } catch {
    return null;
  }
}

/**
 * G0: stand up a loopback capture server and point `codex exec` at it via `-c`
 * overrides + `--ignore-user-config` so ~/.codex/config.toml is never written.
 * Auth file is not modified. If capture fails, return an honest limitation.
 */
export async function captureG0Default(): Promise<G0Capture> {
  const bin = await whichCodexDefault();
  if (!bin) {
    return {
      ok: false,
      limitation: 'codex CLI not found on PATH; G0 cannot capture a real request shape',
    };
  }

  const box: { current: G0Capture | null } = { current: null };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string) => {
      chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      box.current = {
        ok: true,
        path: req.url,
        headersRedacted: redactHeaders(req.headers),
        bodyShape: summarizeBody(raw),
        rawPrompt: 'reply with the single word pong',
      };
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'qlb_g0_capture' }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    return { ok: false, limitation: 'G0 capture server failed to bind loopback' };
  }
  const base = `http://127.0.0.1:${addr.port}/v1`;

  try {
    await execFileAsync(
      bin,
      [
        'exec',
        '--ignore-user-config',
        '--skip-git-repo-check',
        '--ephemeral',
        '-c',
        'model_provider="qlb"',
        '-c',
        'model_providers.qlb.name="QLB"',
        '-c',
        `model_providers.qlb.base_url="${base}"`,
        '-c',
        'model_providers.qlb.wire_api="responses"',
        'reply with the single word pong',
      ],
      { encoding: 'utf8', timeout: 25_000 },
    );
  } catch {
    // Expected: capture server returns 401, or timeout. Capture may still have landed.
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  if (box.current) return box.current;
  return {
    ok: false,
    limitation:
      'codex exec did not hit the local capture server (custom-provider override may be ignored). ' +
      'G1 will use a default Responses-shaped body (model/input/instructions/stream:true/store:false).',
    bodyShape: {
      model: 'gpt-5.4',
      hasInput: true,
      hasInstructions: true,
      stream: true,
      store: false,
      keys: ['model', 'instructions', 'input', 'stream', 'store'],
    },
  };
}

export async function sendCodexRequestDefault(
  body: unknown,
  _label: string,
): Promise<CodexGateHttpResponse> {
  const auth = await readCodexAuthFromDisk();
  if (!auth) {
    throw new Error(`no valid Codex credentials in ${AUTH_PATH} (read-only)`);
  }
  const res = await fetch(CODEX_BACKEND_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      'chatgpt-account-id': auth.accountId,
      originator: 'codex_cli_rs',
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const text = await res.text();
  return { status: res.status, headers, body: text };
}

export function createDefaultCodexGateDeps(): CodexGateDeps {
  return {
    whichCodex: whichCodexDefault,
    getCodexVersion: getCodexVersionDefault,
    captureG0: captureG0Default,
    sendCodexRequest: sendCodexRequestDefault,
  };
}
