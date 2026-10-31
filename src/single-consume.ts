// Single-account refresh consume gate for xAI and Kimi Coding (spec §4.5).
// The lock, Keychain, HTTP transport, clock and durable side effects are injectable.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CREDENTIALS_STALENESS_MS, withProperLockfile } from './cc-locks';
import { platformKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from './keychain';
import { ADAPTER_ACCOUNT_IDS } from './migration';
import { sharedSingleGrantCoords, resolveSingleGrantKeychain } from './single-grant-ownership';
import type { Store } from './store';
import { refreshKimiCodingCredential } from './oauth/kimi-coding-refresh';
import {
  refreshXaiCredential,
  type OAuthRefreshCredential,
  type OAuthRefreshResult,
  type OAuthRefreshTransport,
} from './oauth/xai-refresh';
import {
  adoptStashedSuccessor,
  credentialLineage,
  persistStash,
  resolveQlbHome,
  SingleStashFailure,
  type OAuthCredential as StashCredential,
  type SingleStashKeychain,
} from './single-stash';

export type SingleConsumeProvider = 'xai' | 'kimi-coding';
export type OAuthCredential = OAuthRefreshCredential;
export type SingleRefreshResult = OAuthRefreshResult;
export type CredentialSnapshot = Pick<OAuthCredential, 'access' | 'expires'>;

export class SingleConsumeFailure extends Error {
  constructor(readonly code: 'credential-unavailable' | 'refresh-dead' | 'refresh-failed' | 'persist-failed' | 'cas-conflict' | 'stash-unreadable' | 'successor-unpersisted' | 'generic-ownership-unreadable' | 'generic-ownership-marker' | 'dual-ownership') {
    super(code);
    this.name = 'SingleConsumeFailure';
  }
}

export interface SingleConsumeLock {
  withLock<T>(provider: SingleConsumeProvider, work: () => Promise<T>): Promise<T>;
}

export interface SingleConsumeDeps {
  keychain?: SingleStashKeychain;
  /** Production callers supply the ownership authority for the shared item. */
  store?: Pick<Store, 'getMigration' | 'getConfig' | 'getGrantGeneration' | 'runImmediate' | 'bumpGrantGeneration'>;
  /** P7a's journal directory; its presence is an ownership fact. */
  p7aJournalPath?: string;
  lock?: SingleConsumeLock;
  now?: () => number;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Gate refresh uses 60 s; the automatic loop supplies its 10-minute horizon. */
  dueWithinMs?: number;
  /** Executes the provider POST; never supplied by production tests without a fake. */
  refresh: (credential: OAuthCredential) => Promise<SingleRefreshResult>;
  /** Best-effort audit edge, called only after the replacement is durable. */
  onLineage?: (row: { provider: SingleConsumeProvider; fromFp: string; toFp: string }) => void;
  onDead?: (provider: SingleConsumeProvider) => void;
  /** Non-secret diagnostic sink. Diagnostics never change credential safety. */
  warn?: (message: string) => void;
}

export interface SingleConsumeResult {
  credential: OAuthCredential;
  outcome: 'refreshed' | 'winner';
}

interface StoredCredential { credential: OAuthCredential; bytes: string; }

const GATE_FRESHEN_MS = 60_000;

function credentialService(provider: SingleConsumeProvider): string {
  return qlbKeychainService(provider, 'default');
}

function parseCredential(raw: string): OAuthCredential {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new SingleConsumeFailure('credential-unavailable'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SingleConsumeFailure('credential-unavailable');
  const value = parsed as Record<string, unknown>;
  if (typeof value.access !== 'string' || !value.access || typeof value.refresh !== 'string' || !value.refresh
    || (value.expires !== undefined && typeof value.expires !== 'number')) {
    throw new SingleConsumeFailure('credential-unavailable');
  }
  // D-B55 preserves a legacy successor with unknown expiry. Normalize it to
  // immediately due so its next consume refreshes rather than stranding it.
  if (value.expires === undefined || !Number.isFinite(value.expires)) {
    return { ...value, expires: 0 } as OAuthCredential;
  }
  return value as OAuthCredential;
}

function contentFingerprint(bytes: string): string {
  return `sha256-full:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}

function readStoredCredential(provider: SingleConsumeProvider, keychain: Pick<SingleStashKeychain, 'getSync'>): StoredCredential {
  try {
    const bytes = keychain.getSync(credentialService(provider), QLB_KEYCHAIN_ACCOUNT);
    return { credential: parseCredential(bytes), bytes };
  } catch (error) {
    if (error instanceof SingleConsumeFailure) throw error;
    throw new SingleConsumeFailure('credential-unavailable');
  }
}

function warn(deps: Pick<SingleConsumeDeps, 'warn'>, message: string): void {
  try { deps.warn?.(message); } catch { /* Diagnostics cannot affect credential safety. */ }
}

/** Proper-lockfile directory protocol is cross-process; tests replace it with the in-memory lock. */
export function defaultSingleConsumeLock(home = resolveQlbHome()): SingleConsumeLock {
  return {
    withLock: (provider, work) => withProperLockfile(
      join(home, '.qlb', 'locks', `consume-${provider}-default.lock`),
      { timeoutMs: CREDENTIALS_STALENESS_MS, stalenessMs: CREDENTIALS_STALENESS_MS },
      work,
    ),
  };
}

/** Deterministic no-I/O lock for concurrent unit tests. */
export function createInMemorySingleConsumeLock(): SingleConsumeLock {
  const tails = new Map<SingleConsumeProvider, Promise<void>>();
  return {
    async withLock<T>(provider: SingleConsumeProvider, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(provider) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => { release = resolve; });
      tails.set(provider, previous.then(() => mine));
      await previous;
      try { return await work(); } finally { release(); }
    },
  };
}

/** N8: only a changed and still-valid access token lets a waiting caller skip its POST. */
function winnerFor(snapshot: CredentialSnapshot, reread: OAuthCredential, now: number): boolean {
  return reread.access !== snapshot.access && reread.expires > now;
}

/** Defers termination only while the remote grant has been spent but not made durable. */
async function deferTermination<T>(work: () => Promise<T>): Promise<T> {
  let received: NodeJS.Signals | undefined;
  const handler = (signal: NodeJS.Signals): void => { received ??= signal; };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  try { return await work(); } finally {
    process.off('SIGTERM', handler);
    process.off('SIGINT', handler);
    // Restore Node's conventional signal termination only after persist/stash.
    if (received) process.kill(process.pid, received);
  }
}

function notifyLineage(
  provider: SingleConsumeProvider,
  fromFp: string,
  successor: Pick<OAuthCredential, 'access' | 'refresh'>,
  deps: Pick<SingleConsumeDeps, 'onLineage' | 'warn'>,
): void {
  try {
    deps.onLineage?.({ provider, fromFp, toFp: credentialLineage(successor) });
  } catch {
    // Decision 3: an audit callback is never allowed to roll back or re-drive a durable grant.
    warn(deps, 'lineage callback failed');
  }
}

function notifyDead(provider: SingleConsumeProvider, deps: Pick<SingleConsumeDeps, 'onDead' | 'warn'>): void {
  try { deps.onDead?.(provider); } catch { warn(deps, 'dead callback failed'); }
}

function stashFailure(error: unknown): SingleConsumeFailure {
  if (error instanceof SingleStashFailure) return new SingleConsumeFailure(error.code);
  return new SingleConsumeFailure('stash-unreadable');
}

type SharedItemOwner = 'p7a' | 'generic';

function p7aJournalPath(provider: SingleConsumeProvider, deps: Pick<SingleConsumeDeps, 'home' | 'p7aJournalPath'>): string {
  return join(deps.p7aJournalPath ?? join(resolveQlbHome(deps.home), '.qlb', 'journal'), `pi-migrate-${provider}.json`);
}

/** Resolves the owner facts before a P13 write; malformed generic evidence fails closed. */
function sharedItemOwner(provider: SingleConsumeProvider, deps: Pick<SingleConsumeDeps, 'store' | 'home' | 'p7aJournalPath'>): SharedItemOwner {
  const row = deps.store?.getMigration(`pi-${provider}`);
  if (row?.state !== 'QLB_OWNED') return 'p7a';

  let detail: unknown;
  try { detail = JSON.parse(row.detail_json); } catch { throw new SingleConsumeFailure('generic-ownership-unreadable'); }
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new SingleConsumeFailure('generic-ownership-unreadable');
  const accounts = (detail as { accounts?: unknown }).accounts;
  const account = Array.isArray(accounts) ? accounts[0] : undefined;
  let coords;
  try { coords = resolveSingleGrantKeychain(provider, account); } catch { throw new SingleConsumeFailure('generic-ownership-unreadable'); }
  const shared = sharedSingleGrantCoords(provider);
  if (coords.service !== shared.service || coords.account !== shared.account) return 'p7a';

  const p7aOwned = deps.store?.getConfig(`pi.${provider}.state`) === 'migrated'
    || existsSync(p7aJournalPath(provider, deps));
  if (p7aOwned) throw new SingleConsumeFailure('dual-ownership');
  if (['intent', 'rollbackDecision', 'handback'].some((key) => Object.prototype.hasOwnProperty.call(detail, key))) {
    throw new SingleConsumeFailure('generic-ownership-marker');
  }
  return 'generic';
}

function genericWrite(
  provider: SingleConsumeProvider,
  credential: OAuthCredential,
  keychain: SingleStashKeychain,
  deps: Pick<SingleConsumeDeps, 'store' | 'home' | 'p7aJournalPath'>,
): OAuthCredential {
  const store = deps.store;
  if (!store) throw new SingleConsumeFailure('generic-ownership-unreadable');
  return store.runImmediate(() => {
    if (sharedItemOwner(provider, deps) !== 'generic') throw new SingleConsumeFailure('generic-ownership-unreadable');
    const accountId = ADAPTER_ACCOUNT_IDS[provider];
    const generation = store.getGrantGeneration(accountId);
    if (generation === null) throw new SingleConsumeFailure('generic-ownership-unreadable');
    const stamped = { ...credential, generation: generation + 1, writtenBy: 'single-consume' } as OAuthCredential;
    keychain.setSync(credentialService(provider), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(stamped));
    if (store.bumpGrantGeneration(accountId, generation) !== 1) throw new SingleConsumeFailure('cas-conflict');
    return stamped;
  });
}

/**
 * Consume one single-account refresh token. Every contender re-reads inside
 * the provider consume lock; the loser observes the persisted winner rather
 * than returning busy. That same lock covers every stash adoption/persistence
 * operation, as required by single-stash's reservation protocol.
 */
export async function consumeSingleCredential(
  provider: SingleConsumeProvider,
  snapshot: CredentialSnapshot,
  deps: SingleConsumeDeps,
): Promise<SingleConsumeResult> {
  const home = resolveQlbHome(deps.home);
  const keychain = deps.keychain ?? platformKeychain;
  const now = deps.now ?? Date.now;
  const lock = deps.lock ?? defaultSingleConsumeLock(home);
  const dueWithinMs = deps.dueWithinMs ?? GATE_FRESHEN_MS;
  return lock.withLock(provider, async () => {
    // A generic-held item may not spend a refresh token unless W2 admits it.
    sharedItemOwner(provider, deps);
    let current = readStoredCredential(provider, keychain);
    const adoptedFromFp = credentialLineage(current.credential);
    let adopted: StashCredential | null;
    try {
      adopted = await adoptStashedSuccessor(provider, current.credential as StashCredential, keychain, {
        home,
        warn: deps.warn,
        installPrimary: (credential) => {
          if (sharedItemOwner(provider, deps) === 'generic') genericWrite(provider, credential as OAuthCredential, keychain, deps);
          else keychain.setSync(credentialService(provider), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(credential));
        },
      });
    } catch (error) {
      throw stashFailure(error);
    }
    if (adopted) {
      // Single-stash has installed the primary before it returns. An unknown
      // expiry is still a newer rotated grant (D-B55), so keep it rather than
      // risking another POST. Newly issued credentials always have an expiry.
      const adoptedBytes = JSON.stringify(adopted);
      if (typeof adopted.expires !== 'number' || !Number.isFinite(adopted.expires)) {
        notifyLineage(provider, adoptedFromFp, adopted, deps);
        return { credential: adopted as OAuthCredential, outcome: 'winner' };
      }
      current = { credential: parseCredential(adoptedBytes), bytes: adoptedBytes };
      notifyLineage(provider, adoptedFromFp, current.credential, deps);
    }
    if (winnerFor(snapshot, current.credential, now()) || current.credential.expires - now() > dueWithinMs) {
      return { credential: current.credential, outcome: 'winner' };
    }

    const consumedFp = credentialLineage(current.credential);
    const consumedContentFingerprint = contentFingerprint(current.bytes);
    // The handler is installed before the POST and stays in place until the
    // response is either primary-persisted or durably stashed.
    return deferTermination(async () => {
      const refreshed = await deps.refresh(current.credential);
      if (refreshed.kind === 'dead') {
        notifyDead(provider, deps);
        throw new SingleConsumeFailure('refresh-dead');
      }
      if (refreshed.kind !== 'success') throw new SingleConsumeFailure('refresh-failed');

      // Any exception after a successful POST must first make the issued pair durable.
      let afterPost: StoredCredential;
      try { afterPost = readStoredCredential(provider, keychain); } catch (error) {
        await persistStash(provider, refreshed.credential as StashCredential, consumedFp, keychain, { home, now: deps.now });
        throw error;
      }
      if (contentFingerprint(afterPost.bytes) !== consumedContentFingerprint) {
        await persistStash(provider, refreshed.credential as StashCredential, consumedFp, keychain, { home, now: deps.now });
        if (winnerFor(snapshot, afterPost.credential, now())) return { credential: afterPost.credential, outcome: 'winner' };
        throw new SingleConsumeFailure('cas-conflict');
      }

      let persisted: OAuthCredential;
      try {
        persisted = sharedItemOwner(provider, deps) === 'generic'
          ? genericWrite(provider, refreshed.credential, keychain, deps)
          : (() => {
            keychain.setSync(credentialService(provider), QLB_KEYCHAIN_ACCOUNT, JSON.stringify(refreshed.credential));
            return refreshed.credential;
          })();
      } catch (error) {
        await persistStash(provider, refreshed.credential as StashCredential, consumedFp, keychain, { home, now: deps.now });
        if (error instanceof SingleConsumeFailure) throw error;
        throw new SingleConsumeFailure('persist-failed');
      }
      notifyLineage(provider, consumedFp, persisted, deps);
      return { credential: persisted, outcome: 'refreshed' };
    });
  });
}

async function fetchTransport(request: { url: string; method: 'POST'; headers: Record<string, string>; body: string }): Promise<{ status: number; body: unknown }> {
  const response = await fetch(request.url, {
    method: request.method, headers: request.headers, body: request.body, signal: AbortSignal.timeout(30_000),
  });
  let body: unknown = null;
  try { body = await response.json(); } catch { /* the classifier fails closed on malformed JSON */ }
  return { status: response.status, body };
}

function singleCredentialFromResult(result: SingleConsumeResult): OAuthCredential { return result.credential; }

type XaiConsumeOptions = Omit<SingleConsumeDeps, 'refresh'> & { transport?: OAuthRefreshTransport };
type KimiConsumeOptions = Omit<SingleConsumeDeps, 'refresh'> & { transport?: OAuthRefreshTransport; sleep?: (ms: number) => Promise<void> };

function isSnapshot(value: CredentialSnapshot | XaiConsumeOptions | KimiConsumeOptions): value is CredentialSnapshot {
  return 'access' in value && typeof value.access === 'string' && 'expires' in value && typeof value.expires === 'number';
}

/** The one-argument options form is retained for existing injected callers. */
export function consumeXaiCredential(deps?: XaiConsumeOptions): Promise<OAuthCredential>;
export function consumeXaiCredential(snapshot: CredentialSnapshot, deps?: XaiConsumeOptions): Promise<OAuthCredential>;
export async function consumeXaiCredential(
  snapshotOrDeps: CredentialSnapshot | XaiConsumeOptions = {},
  suppliedDeps: XaiConsumeOptions = {},
): Promise<OAuthCredential> {
  const snapshot = isSnapshot(snapshotOrDeps) ? snapshotOrDeps : undefined;
  const deps = isSnapshot(snapshotOrDeps) ? suppliedDeps : snapshotOrDeps;
  const keychain = deps.keychain ?? platformKeychain;
  const observed = snapshot ?? readStoredCredential('xai', keychain).credential;
  return singleCredentialFromResult(await consumeSingleCredential('xai', observed, {
    ...deps,
    keychain,
    refresh: (credential) => refreshXaiCredential(credential, { transport: deps.transport ?? { request: fetchTransport }, now: deps.now }),
  }));
}

/** The one-argument options form is retained for existing injected callers. */
export function consumeKimiCodingCredential(deps?: KimiConsumeOptions): Promise<OAuthCredential>;
export function consumeKimiCodingCredential(snapshot: CredentialSnapshot, deps?: KimiConsumeOptions): Promise<OAuthCredential>;
export async function consumeKimiCodingCredential(
  snapshotOrDeps: CredentialSnapshot | KimiConsumeOptions = {},
  suppliedDeps: KimiConsumeOptions = {},
): Promise<OAuthCredential> {
  const snapshot = isSnapshot(snapshotOrDeps) ? snapshotOrDeps : undefined;
  const deps = isSnapshot(snapshotOrDeps) ? suppliedDeps : snapshotOrDeps;
  const keychain = deps.keychain ?? platformKeychain;
  const observed = snapshot ?? readStoredCredential('kimi-coding', keychain).credential;
  const env = deps.env ?? process.env;
  return singleCredentialFromResult(await consumeSingleCredential('kimi-coding', observed, {
    ...deps,
    keychain,
    refresh: (credential) => refreshKimiCodingCredential(credential, {
      transport: deps.transport ?? { request: fetchTransport }, now: deps.now, sleep: deps.sleep,
      oauthHost: env.KIMI_CODE_OAUTH_HOST ?? env.KIMI_OAUTH_HOST,
    }),
  }));
}
