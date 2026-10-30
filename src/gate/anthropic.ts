import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { accessTokenFingerprint, isOAuthTokenExpired, parseCredentialBlob, type HttpRequestDescription } from '../anthropic-oauth';
import { readLiveClaudeCredentials, type ClaudeCredentialsOptions } from '../cc-credentials';
import { claudePaths } from '../cc-paths';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../cc-slots';
import {
  liveIdentity,
  ProbeVerdictMemo,
  credentialLineage,
  refreshActiveLogin,
  type ActiveFetchRecord,
  type RefreshActiveLoginDeps,
  type RefreshActiveLoginInput,
  type RefreshHttpResponse,
  type RefreshOutcome,
} from '../cc-resync';
import { platformKeychain } from '../keychain';
import { GateFailure, GateRefused, type GateContext, type GateCredential, type ProviderGate } from '../pi-gate';
import { openStore, openStoreConnection, type Store } from '../store';
import { MIN_INTERVAL_S } from '../poll-policy';

export interface AnthropicGateDeps {
  store?: Store;
  slots?: ClaudeSlots;
  live?: ClaudeCredentialsOptions;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  readLiveIdentity?: () => ReturnType<typeof liveIdentity>;
  postRefresh?: (request: HttpRequestDescription) => Promise<RefreshHttpResponse>;
  verdicts?: ProbeVerdictMemo;
  autoLog?: (line: string) => void;
  refresh?: (deps: RefreshActiveLoginDeps, input: RefreshActiveLoginInput) => Promise<RefreshOutcome>;
  withCredentialLocks?: RefreshActiveLoginDeps['withCredentialLocks'];
  /** Test seam for the fixed-string warning emitted only when release fails. */
  warn?: (message: string) => void;
}

export interface Forced401Claim {
  claimId: string;
  previous: string | null;
}

interface Forced401Config {
  fp: string;
  at: number;
  claimId: string;
}

interface GateResources {
  store: Store;
  slots: ClaudeSlots;
  live: ClaudeCredentialsOptions;
  env: NodeJS.ProcessEnv;
  close(): void;
}

function identityMatchesSlot(
  identity: ReturnType<typeof liveIdentity>,
  slot: { accountId: string; email?: string | null; orgUuid?: string | null },
): boolean {
  return identity !== null && identity.accountId === slot.accountId
    && identity.email === slot.email && identity.orgUuid === (slot.orgUuid ?? '');
}

function safeIdentity(read: () => ReturnType<typeof liveIdentity>): ReturnType<typeof liveIdentity> {
  try { return read(); } catch { return null; }
}

function credentialParts(credentials: string): { token: string; expiresAt?: number } | null {
  const oauth = parseCredentialBlob(credentials)?.oauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
  const expiresAt = oauth.expiresAt;
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt)
    ? { token: oauth.accessToken, expiresAt }
    : { token: oauth.accessToken };
}

export async function sendRefresh(request: HttpRequestDescription): Promise<RefreshHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method, headers: request.headers, body: request.body, signal: AbortSignal.timeout(request.timeoutMs),
  });
  return { status: response.status, body: await response.text() };
}

function resources(deps: AnthropicGateDeps, context: GateContext): GateResources {
  const env = deps.env ?? context.env;
  const ownedStore = deps.store === undefined;
  const store = deps.store ?? openStore(context.dbPath);
  const repository = deps.slots === undefined ? SqliteClaudeSlotRepository.open(context.dbPath) : undefined;
  const live = deps.live ?? { backend: platformKeychain, paths: claudePaths({ env }), env };
  const slots = deps.slots ?? new ClaudeSlots({
    backend: live.backend,
    repository: repository!,
    stashDir: join(dirname(context.dbPath), 'unclaimed'),
    now: deps.now,
  });
  return {
    store,
    slots,
    live,
    env,
    close: () => {
      repository?.close();
      if (ownedStore) store.close();
    },
  };
}

function forced401Config(value: string | null): Forced401Config | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    return typeof row.fp === 'string' && typeof row.at === 'number' && Number.isFinite(row.at)
      && typeof row.claimId === 'string'
      ? { fp: row.fp, at: row.at, claimId: row.claimId }
      : null;
  } catch {
    return null;
  }
}

/** Atomically reserve one forced recovery without retaining credential bytes. */
export function claimForced401(store: Store, accountId: string, fp: string, now: number): Forced401Claim | null {
  void accountId; // The active Anthropic login is singleton; the config key is its durable claim.
  const db = openStoreConnection(store.dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get('pi.anthropic.forced401') as { value?: unknown } | undefined;
    const previous = typeof row?.value === 'string' ? row.value : null;
    const current = forced401Config(previous);
    if (current === null && previous !== null) {
      db.exec('COMMIT');
      return null;
    }
    if (current && (current.fp === fp || now - current.at < MIN_INTERVAL_S * 1000)) {
      db.exec('COMMIT');
      return null;
    }
    const claimId = randomUUID();
    db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
      'pi.anthropic.forced401', JSON.stringify({ fp, at: now, claimId }),
    );
    db.exec('COMMIT');
    return { claimId, previous };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve claim failure */ }
    throw error;
  } finally {
    db.close();
  }
}

/** Return a no-POST claim only while no newer claimant has replaced it. */
export function releaseForced401(store: Store, claimId: string, previous: string | null): void {
  const db = openStoreConnection(store.dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get('pi.anthropic.forced401') as { value?: unknown } | undefined;
    const current = forced401Config(typeof row?.value === 'string' ? row.value : null);
    if (current?.claimId === claimId) {
      if (previous === null) db.prepare('DELETE FROM config WHERE key = ?').run('pi.anthropic.forced401');
      else db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run('pi.anthropic.forced401', previous);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve release failure */ }
    throw error;
  } finally {
    db.close();
  }
}

/** Whether the closed refresh result spent (or attempted to spend) a grant. */
export function startedPost(outcome: RefreshOutcome): boolean {
  switch (outcome.outcome) {
    case 'posted':
    case 'posted-slot-unwritten':
    case 'posted-live-unwritten':
    case 'stashed':
    case 'unpersisted':
      return true;
    case 'restored':
    case 'adopted':
    case 'deferred':
    case 'refused':
      return false;
    case 'dead':
      return outcome.struckFp !== null;
    case 'failed':
      return outcome.reason === 'refresh-failed' || outcome.reason === 'invalid_client';
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

function served(accountId: string, working: string, source: GateCredential['source']): GateCredential {
  const credential = credentialParts(working);
  if (!credential) throw new GateFailure('no-credentials');
  return { accountId, token: credential.token, source, ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }) };
}

function mapRefreshOutcome(
  outcome: RefreshOutcome,
  accountId: string,
  autoLog: (line: string) => void,
  now: () => number,
): GateCredential {
  const refreshed = (working: string, source: GateCredential['source']): GateCredential => {
    const credential = served(accountId, working, source);
    if (credential.expiresAt === undefined || credential.expiresAt - now() <= 60_000) {
      throw new GateFailure('credential-expiry-unusable');
    }
    return credential;
  };
  switch (outcome.outcome) {
    case 'posted': return refreshed(outcome.working, 'refreshed');
    case 'posted-slot-unwritten': return refreshed(outcome.working, 'refreshed');
    case 'restored': return refreshed(outcome.working, 'restored');
    case 'adopted': return refreshed(outcome.working, 'adopted');
    case 'posted-live-unwritten':
      try { autoLog(`claude:live-write-failed provider=anthropic account=${accountId} at=${now()}`); } catch { /* diagnostics never change fail-closed handling */ }
      throw new GateFailure('token-expired');
    case 'stashed':
    case 'unpersisted': throw new GateFailure('token-expired');
    case 'failed':
      switch (outcome.reason) {
        case 'refresh-failed': throw new GateFailure('refresh-failed');
        case 'invalid_client': throw new GateFailure('invalid-client');
        case 'foreign-credential': throw new GateFailure('foreign-credential');
        default: {
          const exhaustive: never = outcome;
          return exhaustive;
        }
      }
    case 'dead': throw new GateFailure('relogin-needed');
    case 'deferred':
      switch (outcome.deferReason) {
        case 'locks-held':
        case 'budget-exhausted': throw new GateRefused('locks-held');
        case 'identity-mismatch': throw new GateRefused('identity-mismatch');
        default: throw new GateFailure(`refresh-deferred-${outcome.deferReason}`);
      }
    case 'refused':
      switch (outcome.reason) {
        case 'store-unmirrored': throw new GateFailure('store-unmirrored');
        case 'cswap-process-alive': throw new GateRefused('cswap-process-alive');
        case 'cswap-process-check-failed': throw new GateRefused('cswap-process-check-failed');
        default: {
          const exhaustive: never = outcome;
          return exhaustive;
        }
      }
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

/** Resolve a single active Anthropic credential without any usage or profile I/O. */
export function createAnthropicGate(deps: AnthropicGateDeps = {}, initialContext?: GateContext): ProviderGate {
  let context = initialContext;
  return {
    context: (next) => { context = next; },
    read: async () => {
      if (!context) throw new GateFailure('gate-context-unset');
      const configured = resources(deps, context);
      const now = deps.now ?? Date.now;
      try {
        const active = configured.store.getActiveLogin('anthropic');
        if (!active?.accountId) throw new GateFailure('active-login-unset');
        const accountId = active.accountId;
        const slot = configured.slots.getSlot(accountId);
        if (!slot) throw new GateFailure('active-slot-missing');

        const paths = configured.live.paths ?? claudePaths(configured.live);
        const readIdentity = deps.readLiveIdentity ?? (() => liveIdentity(paths.globalConfigPath, configured.live.readText));
        const initialIdentity = safeIdentity(readIdentity);
        if (!identityMatchesSlot(initialIdentity, slot)) throw new GateRefused('identity-mismatch');

        let live: string;
        try { live = await readLiveClaudeCredentials(configured.live); }
        catch { throw new GateFailure('keychain-unavailable'); }
        const parts = credentialParts(live);
        if (!parts) throw new GateFailure('no-credentials');

        const currentActive = configured.store.getActiveLogin('anthropic');
        const finalIdentity = safeIdentity(readIdentity);
        if (currentActive?.accountId !== active.accountId || !identityMatchesSlot(finalIdentity, slot)) {
          throw new GateRefused('identity-mismatch');
        }
        const autoLog = deps.autoLog ?? context.autoLog;
        const refresh = async (forceRecord?: ActiveFetchRecord): Promise<RefreshOutcome> => {
          const outcome = await (deps.refresh ?? refreshActiveLogin)({
            slots: configured.slots,
            store: configured.store,
            live: configured.live,
            readLiveIdentity: readIdentity,
            postRefresh: deps.postRefresh ?? sendRefresh,
            now,
            verdicts: deps.verdicts ?? new ProbeVerdictMemo(),
            env: configured.env,
            by: 'qlb-gate',
            autoLog,
            withCredentialLocks: deps.withCredentialLocks,
          }, {
            accountId,
            email: slot.email ?? '',
            orgUuid: slot.orgUuid ?? '',
            creds: live,
            ...(forceRecord === undefined ? {} : { forceRecord }),
            degraded: false,
          });
          const activeAfterRefresh = configured.store.getActiveLogin('anthropic');
          if (activeAfterRefresh?.accountId !== accountId) throw new GateRefused('active-login-stale');
          return outcome;
        };

        const retryAfter401Fp = context.retryAfter401Fp;
        if (retryAfter401Fp !== undefined) {
          // A changed access generation, a divergent served lineage, and a
          // quarantined slot must never consume a grant because of a stale 401.
          if (accessTokenFingerprint(live) !== retryAfter401Fp
            || credentialLineage(live) !== slot.fingerprint || slot.dead) {
            return served(accountId, live, 'live');
          }
          const claim = claimForced401(configured.store, accountId, retryAfter401Fp, now());
          if (!claim) return served(accountId, live, 'live');
          let outcome: RefreshOutcome | undefined;
          try {
            outcome = await refresh({ error: 'http-401' });
            return mapRefreshOutcome(outcome, accountId, autoLog, now);
          } finally {
            if (outcome === undefined || !startedPost(outcome)) {
              try { releaseForced401(configured.store, claim.claimId, claim.previous); }
              catch { (deps.warn ?? console.warn)('Claude forced-401 claim release failed'); }
            }
          }
        }

        if (parts.expiresAt !== undefined && !isOAuthTokenExpired(parts.expiresAt, now())) {
          return served(accountId, live, 'live');
        }
        return mapRefreshOutcome(await refresh(), accountId, autoLog, now);
      } finally {
        configured.close();
      }
    },
  };
}

/** Module gate state is per CLI process; runPiGate supplies the context once before read(). */
const gate = createAnthropicGate();
export default gate;
