import { dirname, join } from 'node:path';

import { isOAuthTokenExpired, parseCredentialBlob, type HttpRequestDescription } from '../anthropic-oauth';
import { readLiveClaudeCredentials, type ClaudeCredentialsOptions } from '../cc-credentials';
import { claudePaths } from '../cc-paths';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../cc-slots';
import {
  liveIdentity,
  ProbeVerdictMemo,
  refreshActiveLogin,
  type RefreshActiveLoginDeps,
  type RefreshActiveLoginInput,
  type RefreshHttpResponse,
  type RefreshOutcome,
} from '../cc-resync';
import { platformKeychain } from '../keychain';
import { GateFailure, GateRefused, type GateContext, type GateCredential, type ProviderGate } from '../pi-gate';
import { openStore, type Store } from '../store';

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
        const slot = configured.slots.getSlot(active.accountId);
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
        if (parts.expiresAt !== undefined && !isOAuthTokenExpired(parts.expiresAt, now())) {
          return served(active.accountId, live, 'live');
        }

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
          autoLog: deps.autoLog ?? context.autoLog,
          withCredentialLocks: deps.withCredentialLocks,
        }, {
          accountId: active.accountId,
          email: slot.email ?? '',
          orgUuid: slot.orgUuid ?? '',
          creds: live,
          degraded: false,
        });
        const activeAfterRefresh = configured.store.getActiveLogin('anthropic');
        if (activeAfterRefresh?.accountId !== active.accountId) throw new GateRefused('active-login-stale');
        return mapRefreshOutcome(outcome, active.accountId, deps.autoLog ?? context.autoLog, now);
      } finally {
        configured.close();
      }
    },
  };
}

/** Module gate state is per CLI process; runPiGate supplies the context once before read(). */
const gate = createAnthropicGate();
export default gate;
