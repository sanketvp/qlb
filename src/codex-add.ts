import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CodexAuthLockCompromised, withCodexAuthLock, type CodexAuthLockOptions, type HeldCodexAuthLock } from './cc-locks';
import { codexFingerprint, parseCodexAuth, readCodexAuthStable, type CodexAuthDocument, type CodexAuthStableResult } from './codex-auth';
import { isCredentialNotFound } from './credential-backends';
import { planImportActiveCodex } from './codex-slots';
import { codexAdmission, ensureCodexSlotAccount, rekeyCodexAccounts, type RekeySummary } from './codex-rekey';
import { recordRestoreBaseline } from './codex-restore-baseline';
import { QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, type KeychainBackend } from './keychain';
import type { Store } from './store';

const PROVIDER = 'openai-codex';

/**
 * Codex source reference: openai/codex `rust-v0.164.0`,
 * `codex-rs/cli/src/cli_login.rs:129-130,148-149,192`.
 */
export const CODEX_FILE_CREDENTIAL_STORE_CONFIG = 'cli_auth_credentials_store = "file"\n';

export class CodexAddError extends Error {
  constructor(message: string, readonly exitCode: 1 | 3 = 1, readonly retryable = false) {
    super(message);
    this.name = 'CodexAddError';
  }
}

export interface CodexAddInput {
  home: string;
  nativeAuthPath: string;
  replace?: string;
}

export interface CodexLoginOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Receives the login child so cleanup can stop it before removing CODEX_HOME. */
  onSpawn?: (child: ChildProcess) => void;
}

type SqlStore = Pick<Store, 'dbPath'>;
type AddKeychain = Pick<KeychainBackend, 'getSync' | 'setSync' | 'deleteSync'>;

/** All process, filesystem, clock, credential, and signal effects are seams. */
export interface CodexAddDeps {
  store: SqlStore;
  keychain: AddKeychain;
  env: NodeJS.ProcessEnv;
  now: () => number;
  createTemp: (home: string) => string;
  writeConfig: (path: string, contents: string) => void;
  removeTemp: (path: string) => void;
  hashFile: (path: string) => string;
  login: (options: CodexLoginOptions) => Promise<number>;
  readAuth: (path: string) => Promise<CodexAuthStableResult>;
  /** Installs process-exit and signal cleanup; returns an unregister function. */
  installCleanup: (cleanup: () => Promise<void>) => () => void;
  /** Test seam for the short SQLite transaction. */
  withDb: <T>(store: SqlStore, fn: (db: DatabaseSync) => T) => T;
  /** Holds the Codex auth lock around the slot/Keychain read-decide-write. */
  withAuthLock: <T>(options: CodexAuthLockOptions, fn: (held: HeldCodexAuthLock) => Promise<T> | T) => Promise<T>;
}

export interface CodexAddResult {
  slotId: string;
  /** False means a same-identity slot was re-bound with --replace. */
  added: boolean;
  rekey: RekeySummary;
}

interface ExistingSlot {
  fingerprint: string | null;
}

function storedCredentialMatchesFingerprint(value: string | undefined, fingerprint: string): boolean {
  if (value === undefined) return false;
  const parsed = parseCodexAuth(value);
  return parsed.ok && codexFingerprint(parsed.doc) === fingerprint;
}

function unsafePredecessorError(accountId: string): CodexAddError {
  return new CodexAddError(
    `Codex replacement could not safely preserve predecessor for ${accountId}; retry codex add --replace`,
    3,
    true,
  );
}

function withDatabase<T>(store: SqlStore, fn: (db: DatabaseSync) => T): T {
  if (store.dbPath === ':memory:') return fn((store as unknown as { db: DatabaseSync }).db);
  const db = new DatabaseSync(store.dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

function plan(doc: CodexAuthDocument): { slotId: string; chatgptUserId: string; accountId: string } {
  try {
    return planImportActiveCodex(doc);
  } catch {
    throw new CodexAddError('temporary Codex login has no S29 identity');
  }
}

function stableDocument(result: CodexAuthStableResult): CodexAuthDocument {
  if (result.status !== 'ok') throw new CodexAddError(`temporary Codex auth.json is ${result.status}`);
  return result.doc;
}

function persist(
  doc: CodexAuthDocument,
  input: CodexAddInput,
  deps: CodexAddDeps,
  assertAuthLockHeld: () => void,
): CodexAddResult {
  const identity = plan(doc);
  const fingerprint = codexFingerprint(doc);
  const service = qlbKeychainService(PROVIDER, identity.slotId);
  const withDb = deps.withDb;
  let priorCredential: string | undefined;
  let priorPrevious: string | undefined;
  let writtenCredential: string | undefined;
  let writtenPrevious: string | undefined;
  let wroteCredential = false;
  let wrotePrevious = false;
  let exists = false;

  return withDb(deps.store, (db) => {
      assertAuthLockHeld();
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.prepare('SELECT fingerprint FROM codex_slots WHERE account_id = ?')
          .get(identity.slotId) as ExistingSlot | undefined;
        exists = existing !== undefined;
        if (existing && input.replace === undefined) {
          throw new CodexAddError(`Codex slot already exists: ${identity.slotId}`, 3);
        }
        if (input.replace !== undefined && (!existing || input.replace !== identity.slotId)) {
          throw new CodexAddError('Codex replacement identity differs; add as a new account and delete the old slot', 3);
        }
        const refusal = codexAdmission(db, { slotId: identity.slotId, bareAccountId: identity.accountId });
        if (refusal) throw new CodexAddError(refusal.message, 3);
        const now = deps.now();
        const summary = rekeyCodexAccounts(db, {
          dbPath: deps.store.dbPath,
          now,
          prospective: { accountId: identity.slotId, chatgptAccountId: identity.accountId },
        });

        // Snapshot both values before the first write. A failed replacement must
        // leave the current/predecessor pair exactly as it found it.
        try {
          priorCredential = deps.keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT);
        } catch (error) {
          // An existing slot must have its current credential; preserve the
          // prior fail-closed behavior for that inconsistent state.
          if (existing?.fingerprint || !isCredentialNotFound(error)) throw error;
          priorCredential = undefined;
        }
        try {
          priorPrevious = deps.keychain.getSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT);
        } catch (error) {
          if (!isCredentialNotFound(error)) throw error;
          priorPrevious = undefined;
        }
        // A retry after an interrupted replacement must not turn the new
        // current value into :prev and thereby discard the old credential.
        if (existing?.fingerprint && !storedCredentialMatchesFingerprint(priorCredential, existing.fingerprint)) {
          throw unsafePredecessorError(identity.slotId);
        }

        // Set this before every write: a backend can throw after modifying an
        // item, and compensation must cover that ambiguous outcome too.
        if (existing?.fingerprint) {
          writtenPrevious = priorCredential!;
          wrotePrevious = true;
          assertAuthLockHeld();
          deps.keychain.setSync(`${service}:prev`, QLB_KEYCHAIN_ACCOUNT, writtenPrevious);
        }
        writtenCredential = JSON.stringify(doc);
        wroteCredential = true;
        assertAuthLockHeld();
        deps.keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, writtenCredential);

        assertAuthLockHeld();
        db.prepare(`INSERT INTO codex_slots (
          account_id, chatgpt_user_id, chatgpt_account_id, fingerprint, prev_fingerprint,
          last_refresh, dead, pending_adopt, added_at, last_active_at, source, healed_at
        ) VALUES (?, ?, ?, ?, NULL, ?, 0, 0, ?, NULL, 'qlb-add', NULL)
        ON CONFLICT(account_id) DO UPDATE SET
          chatgpt_user_id = excluded.chatgpt_user_id,
          chatgpt_account_id = excluded.chatgpt_account_id,
          prev_fingerprint = codex_slots.fingerprint,
          fingerprint = excluded.fingerprint,
          last_refresh = excluded.last_refresh,
          dead = 0, dead_reason = NULL, dead_at = NULL, healed_at = excluded.added_at,
          pending_adopt = 0, archived_at = NULL`).run(
          identity.slotId, identity.chatgptUserId, identity.accountId, fingerprint, doc.last_refresh ?? null, now,
        );
        assertAuthLockHeld();
        ensureCodexSlotAccount(db, identity.slotId, now);
        assertAuthLockHeld();
        db.prepare(`INSERT INTO lineage_log (ts, provider, account_id, from_fp, to_fp, cause, by, evidence)
          VALUES (?, ?, ?, ?, ?, ?, 'qlb-cli', ?)`)
          .run(now, PROVIDER, identity.slotId, existing?.fingerprint ?? null, fingerprint, exists ? 'replace' : 'add', exists ? 'replace' : 'add');
        if (exists) {
          assertAuthLockHeld();
          db.prepare(`INSERT INTO relogin_events (ts, provider, account_id, kind, detail, evidence)
            VALUES (?, ?, ?, 'identity-replaced', NULL, 'identity')`)
            .run(now, PROVIDER, identity.slotId);
        }
        if (summary.backupTaken) {
          recordRestoreBaseline(db, {
            saveKind: exists ? 'add-replace' : 'add',
            backupPath: summary.backupTaken,
            keychain: deps.keychain as KeychainBackend,
          });
        }
        assertAuthLockHeld();
        db.exec('COMMIT');
        return { slotId: identity.slotId, added: !exists, rekey: summary };
      } catch (error) {
        // Compensate before ROLLBACK releases BEGIN IMMEDIATE. Each write is
        // conditional so an ambiguous write failure cannot overwrite a value
        // that was not written by this attempt.
        let compensationSafe = true;
        if (wroteCredential) {
          compensationSafe = restoreCredentialIfUnchanged(deps.keychain, service, priorCredential, writtenCredential!) && compensationSafe;
        }
        if (wrotePrevious) {
          compensationSafe = restoreCredentialIfUnchanged(deps.keychain, `${service}:prev`, priorPrevious, writtenPrevious!) && compensationSafe;
        }
        try { db.exec('ROLLBACK'); } catch { /* retain the original failure */ }
        if (error instanceof CodexAuthLockCompromised && !compensationSafe) {
          throw unsafePredecessorError(identity.slotId);
        }
        throw error;
      }
    });
}

function restoreCredentialIfUnchanged(
  keychain: AddKeychain,
  service: string,
  priorValue: string | undefined,
  writtenValue: string,
): boolean {
  try {
    let currentValue: string | undefined;
    try {
      currentValue = keychain.getSync(service, QLB_KEYCHAIN_ACCOUNT);
    } catch (error) {
      if (!isCredentialNotFound(error)) throw error;
    }
    // This is deliberately independent of the lost auth lock: it is a CAS
    // restoring only bytes this attempt can prove it wrote.
    if (currentValue !== writtenValue) return false;
    if (priorValue === undefined) keychain.deleteSync(service, QLB_KEYCHAIN_ACCOUNT);
    else keychain.setSync(service, QLB_KEYCHAIN_ACCOUNT, priorValue);
    return true;
  } catch {
    return false;
  }
}

/**
 * Adds one Codex account through an isolated file-store login. It never points
 * Codex at the native home, and it never invokes logout.
 */
export async function addCodexAccount(input: CodexAddInput, deps: CodexAddDeps): Promise<CodexAddResult> {
  const before = deps.hashFile(input.nativeAuthPath);
  const temporaryHome = deps.createTemp(input.home);
  let loginChild: ChildProcess | undefined;
  let cleaned = false;
  let cleaning: Promise<void> | undefined;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    if (cleaning) return cleaning;
    cleaning = (async () => {
      if (loginChild && loginChild.exitCode === null && loginChild.signalCode === null) {
        await stopLoginChild(loginChild);
      }
      // Do not declare cleanup complete until the child cannot recreate its
      // isolated credential directory and removal has actually happened.
      deps.removeTemp(temporaryHome);
      cleaned = true;
    })();
    try {
      await cleaning;
    } finally {
      if (!cleaned) cleaning = undefined;
    }
  };
  const unregister = deps.installCleanup(cleanup);

  try {
    deps.writeConfig(join(temporaryHome, 'config.toml'), CODEX_FILE_CREDENTIAL_STORE_CONFIG);
    const status = await deps.login({
      command: 'codex', args: ['login'], cwd: temporaryHome, env: { ...deps.env, CODEX_HOME: temporaryHome },
      onSpawn: (child) => { loginChild = child; },
    });
    if (cleaning) throw new CodexAddError('codex login interrupted');
    if (status !== 0) throw new CodexAddError('codex login failed');

    const doc = stableDocument(await deps.readAuth(join(temporaryHome, 'auth.json')));
    if (deps.hashFile(input.nativeAuthPath) !== before) {
      throw new CodexAddError('native Codex auth.json changed during isolated login', 3);
    }
    // Both native-file checks precede irreversible Keychain/SQLite changes.
    if (deps.hashFile(input.nativeAuthPath) !== before) {
      throw new CodexAddError('native Codex auth.json changed during isolated login', 3);
    }
    if (cleaning) throw new CodexAddError('codex login interrupted');
    // The isolated login deliberately runs outside this non-reentrant lock.
    // Once its native-file checks pass, lock order is Codex auth → SQLite /
    // Keychain so replacement cannot race import-active's re-validation.
    return deps.withAuthLock({ home: input.home, env: deps.env }, (held) =>
      persist(doc, input, deps, () => held.assertNotCompromised()),
    );
  } finally {
    unregister();
    await cleanup();
  }
}

function createTemporaryHome(home: string): string {
  const root = join(home, '.qlb', 'tmp');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const path = mkdtempSync(join(root, 'codex-add-'));
  chmodSync(path, 0o700);
  return path;
}

function writeTemporaryConfig(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function hashNativeAuth(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function stopLoginChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined || !child.spawnfile) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener('exit', settle);
      child.removeListener('close', settle);
      child.removeListener('error', settle);
      resolve();
    };
    child.once('exit', settle);
    child.once('close', settle);
    child.once('error', settle);
    try {
      child.kill('SIGTERM');
    } catch {
      settle();
      return;
    }
    if (settled) return;
    timer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      } catch { /* settle below even if SIGKILL cannot be sent */ }
      settle();
    }, 5_000);
  });
}

function runCodexLogin(options: CodexLoginOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: 'inherit' });
    options.onSpawn?.(child);
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

function installProcessCleanup(cleanup: () => Promise<void>): () => void {
  let handlingSignal = false;
  const onExit = (): void => { void cleanup().catch(() => undefined); };
  const unregister = (): void => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('exit', onExit);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (handlingSignal) return;
    handlingSignal = true;
    // Removing our listeners restores Node's default signal disposition before
    // re-raising it, after the child has stopped and CODEX_HOME is gone.
    unregister();
    void cleanup().finally(() => { process.kill(process.pid, signal); });
  };
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.once('exit', onExit);
  return unregister;
}

/** Production effects for the executing command; unit tests provide all seams. */
export function productionCodexAddDeps(
  store: SqlStore,
  keychain: AddKeychain,
  env: NodeJS.ProcessEnv = process.env,
): CodexAddDeps {
  return {
    store,
    keychain,
    env,
    now: Date.now,
    createTemp: createTemporaryHome,
    writeConfig: writeTemporaryConfig,
    removeTemp: (path) => rmSync(path, { recursive: true, force: true }),
    hashFile: hashNativeAuth,
    login: runCodexLogin,
    readAuth: readCodexAuthStable,
    installCleanup: installProcessCleanup,
    withDb: withDatabase,
    withAuthLock: withCodexAuthLock,
  };
}
