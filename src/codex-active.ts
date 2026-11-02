import { createHash } from 'node:crypto';

import { accessExpiry, needsRefresh, type CodexAuthDocument } from './codex-auth';
import { codexIdentityParts, holderSets, readCodexSwitchHistory, renewers, type CodexProcess } from './codex-sessions';
import type { CodexRecoveryFenceState, CodexSwitchDeps } from './codex-switch';

const NEAR_EXPIRY_MS = 5 * 60_000;

/** Dependencies for the active Codex renewer. All external effects are injected. */
export type CodexActiveDeps = Pick<CodexSwitchDeps,
  'store' | 'readLive' | 'cswapProcesses' | 'now' | 'attempt' | 'authLockOptions'
> & {
  dbPath: string;
  slots: NonNullable<CodexSwitchDeps['slots']>;
  keychain: NonNullable<CodexSwitchDeps['keychain']>;
  authPath: string;
  list: () => Promise<CodexProcess[]>;
  transport: NonNullable<CodexSwitchDeps['transport']>;
  journalDir: string;
  lockTimeoutMs?: number;
  withLocks?: <T>(accountId: string, fn: (assertHeld: () => void) => Promise<T> | T) => Promise<T>;
  sleep?: (ms: number) => Promise<void>;
  autoLog?: (line: string) => void;
  /** Production signal deferral seam; it is not a test barrier. */
  signalWindow?: { enter(): void; exit(): void };
  hooks?: CodexActiveHooks;
};

export interface CodexActiveHooks {
  afterCheck?: () => void | Promise<void>;
  afterLock?: () => void | Promise<void>;
  afterObserve?: () => void | Promise<void>;
  beforeSend?: () => void | Promise<void>;
  afterPost?: () => void | Promise<void>;
  beforeRename?: () => void | Promise<void>;
  afterRename?: () => void | Promise<void>;
  beforeVerify?: () => void | Promise<void>;
}

export type CodexActiveInput =
  | { trigger: 'unauthorized'; accessFp: string; mode?: 'refresh' | 'reconcile' }
  | { trigger: 'proactive-expiry' | 'scheduled'; mode?: 'refresh' | 'reconcile' };

export type CodexActiveRefusalReason =
  | 'active-login-unset'
  | 'active-slot-missing'
  | 'cswap-process-alive'
  | 'cswap-process-check-failed'
  | 'codex-process-check-failed'
  | 'codex-logged-out'
  | 'codex-auth-unreadable'
  | 'wiped'
  | 'republish-failed'
  | 'unknown-live-identity'
  | 'stash-unverifiable'
  | 'slot-split'
  | 'switch-in-flight';

export type CodexActiveAction = 'noop' | 'adopt' | 'republish-slot';
export type CodexLiveWriteCause = 'post' | 'republish';
export type CodexLiveReadFailure = 'unstable' | 'missing' | 'wiped' | 'unreadable';
export type CodexRepublishResult = 'ok' | 'unwritten' | 'external' | 'unverified';

/** The closed result union returned by the active Codex refresh workflow. */
export type CodexActiveOutcome =
  | { status: 'posted'; document: CodexAuthDocument }
  | { status: 'republished'; document: CodexAuthDocument }
  | { status: 'adopted'; document: CodexAuthDocument }
  | { status: 'noop'; document: CodexAuthDocument }
  | { status: 'rotated'; document: CodexAuthDocument }
  | { status: 'held'; pids: number[]; document: CodexAuthDocument; action: CodexActiveAction }
  | { status: 'codex-won'; adopted: boolean; pids: number[]; document: CodexAuthDocument }
  | { status: 'dead'; reason: string }
  | { status: 'superseded'; document: CodexAuthDocument }
  | { status: 'transient'; reason?: string }
  | { status: 'posted-live-unwritten'; document: CodexAuthDocument; cause: CodexLiveWriteCause }
  | { status: 'posted-live-external'; document: CodexAuthDocument; action: CodexActiveAction; cause: CodexLiveWriteCause }
  | { status: 'posted-live-unverified'; document: CodexAuthDocument; read: CodexLiveReadFailure; cause: CodexLiveWriteCause }
  | { status: 'stashed'; stashId?: string }
  | { status: 'unpersisted' }
  | { status: 'deferred'; reason: 'codex-writing' | 'locks-held' }
  | { status: 'drift'; accountId: string | null; republish?: CodexRepublishResult }
  | { status: 'fenced'; reason: string; message: string; accounts: Extract<CodexRecoveryFenceState, { state: 'fenced' }>['accounts'] }
  | { status: 'refused'; reason: CodexActiveRefusalReason };

/** A process-list failure, deliberately without the underlying error or any credential document. */
export class CodexProcessCheckFailed extends Error {
  constructor() {
    super('Codex process check failed');
    this.name = 'CodexProcessCheckFailed';
  }
}

/** Converts process discovery failures into the typed, credential-free active-refresh failure. */
export function listOrFail(list: () => Promise<CodexProcess[]>): () => Promise<CodexProcess[]> {
  return async () => {
    try {
      return await list();
    } catch {
      throw new CodexProcessCheckFailed();
    }
  };
}

export type CodexActiveExpiry = {
  state: 'usable' | 'near-expiry' | 'expired' | 'unknown';
  expiresAt: number | null;
  leftMs: number | null;
};

/** Classifies a live token for the active renewer without retaining its value. */
export function classifyActiveCodexExpiry(doc: CodexAuthDocument, now: number): CodexActiveExpiry {
  const expiresAt = accessExpiry(doc);
  if (expiresAt === null) return { state: 'unknown', expiresAt: null, leftMs: null };
  const leftMs = expiresAt - now;
  if (leftMs <= 0) return { state: 'expired', expiresAt, leftMs };
  if (leftMs <= NEAR_EXPIRY_MS) return { state: 'near-expiry', expiresAt, leftMs };
  return { state: 'usable', expiresAt, leftMs };
}

/** Returns processes capable of renewing an active identity, conservatively treating every listed process as a renewer when history has no holder identity evidence. */
export async function activeCodexRenewers(
  deps: Pick<CodexActiveDeps, 'dbPath' | 'journalDir' | 'list'>,
  accountId: string,
): Promise<CodexProcess[]> {
  const history = readCodexSwitchHistory(deps.dbPath, { journalDir: deps.journalDir });
  const processes = await listOrFail(deps.list)();
  if (!holderSets(history.rows, history.observations).some((set) => set.identities.length > 0)) return processes;
  return renewers(codexIdentityParts(accountId), processes, history.rows, history.observations);
}

/** Adapter used by C10 so both pre- and post-request holder checks use active eras. */
export function holdersFor(
  deps: Pick<CodexActiveDeps, 'dbPath' | 'journalDir' | 'list'>,
  accountId: string,
): (document: CodexAuthDocument) => Promise<CodexProcess[]> {
  return async (_document) => activeCodexRenewers(deps, accountId);
}

/** A non-reversible, value-free access-token identifier for 401 attribution. */
export function accessFingerprint(doc: CodexAuthDocument): string {
  return `sha256-at:${createHash('sha256').update(doc.tokens.access_token, 'utf8').digest('hex')}`;
}

/** Whether the active document needs a refresh for this trigger. */
export function isDueForRefresh(
  doc: CodexAuthDocument,
  now: number,
  trigger: CodexActiveInput['trigger'],
): boolean {
  return trigger === 'unauthorized' || needsRefresh(doc, now);
}
