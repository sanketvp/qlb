import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { isCredentialNotFound } from './credential-backends';
import { platformKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, type KeychainBackend } from './keychain';

const BASELINE_KEY = 'codex.rekey.baseline';
const SAVE_KINDS = new Set(['import-new', 'add', 'add-replace', 'existing-mark', 'existing-adopt']);

type SaveKind = 'import-new' | 'add' | 'add-replace' | 'existing-mark' | 'existing-adopt';
type Digest = Record<string, string>;
type KeychainDigest = Record<string, string>;

interface RestoreBaseline {
  v: 1;
  backupPath: string;
  saveKind: SaveKind;
  userVersion: number;
  digest: Digest;
  keychain: KeychainDigest;
}

interface BaselineOptions {
  saveKind: SaveKind;
  backupPath: string;
  keychain: KeychainBackend;
}

interface CheckOptions {
  keychain?: KeychainBackend;
}

interface KeychainItem {
  service: string;
  account: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function rows(db: DatabaseSync, sql: string): unknown[] {
  // Deliberately do not substitute an alternate query: a missing compared table
  // or column makes the restore check unsafe and must stop the caller.
  return db.prepare(sql).all() as unknown[];
}

function digestRows(db: DatabaseSync, sql: string): string {
  return sha256(canonicalJson(rows(db, sql)));
}

function configDigest(db: DatabaseSync): string {
  const compared = rows(db, `SELECT key, value FROM config
    WHERE key LIKE 'pi.%' OR key LIKE 'keychain.%' OR key = 'slots.generation'
      OR key LIKE 'single.%' OR key = 'migrations.recovery_pending'
    ORDER BY key`) as Array<{ key: string; value: string | null }>;
  const heartbeat = /^pi\.[^.]+\.(lastServedAt|lastServedFingerprint)$/;
  return sha256(canonicalJson(compared.filter((row) => !heartbeat.test(row.key)
    && row.key !== 'pi.anthropic.lastServedBy')));
}

/** The exact D-B82 compared set, keyed by its operator-facing reason name. */
export function comparedSetDigest(db: DatabaseSync): Digest {
  return {
    migrations: digestRows(db, 'SELECT store, state, updated_at, detail_json FROM migrations ORDER BY store'),
    lifecycle: digestRows(db, 'SELECT * FROM lifecycle ORDER BY id'),
    codex_slots: digestRows(db, `SELECT account_id, fingerprint, prev_fingerprint, last_refresh, dead, archived_at
      FROM codex_slots ORDER BY account_id`),
    claude_slots: digestRows(db, `SELECT account_id, fingerprint, prev_fingerprint, dead, archived_at
      FROM claude_slots ORDER BY account_id`),
    lineage_log: digestRows(db, 'SELECT count(*) AS count, max(id) AS max_id FROM lineage_log'),
    active_login: digestRows(db, 'SELECT provider, account_id FROM active_login ORDER BY provider'),
    pi_export_targets: digestRows(db, `SELECT provider, target, slot_account_id, lineage_fp
      FROM pi_export_targets ORDER BY provider, target`),
    accounts: digestRows(db, 'SELECT id, provider, status, grant_generation FROM accounts ORDER BY id'),
    config: configDigest(db),
  };
}

function keychainItems(db: DatabaseSync): KeychainItem[] {
  const items: KeychainItem[] = [];
  for (const row of rows(db, 'SELECT account_id FROM codex_slots ORDER BY account_id') as Array<{ account_id: string }>) {
    items.push({ service: qlbKeychainService('openai-codex', row.account_id), account: QLB_KEYCHAIN_ACCOUNT });
  }
  // D-B86 covers generic grants for these providers at qlb:<provider>:<id>
  // using label || id as the Keychain account attribute.
  for (const row of rows(db, `SELECT id, provider, label FROM accounts
    WHERE provider IN ('xai', 'kimi-coding', 'openai-codex', 'anthropic') ORDER BY id`) as Array<{ id: string; provider: string; label: string | null }>) {
    items.push({ service: qlbKeychainService(row.provider, row.id), account: row.label || row.id });
  }
  items.push(
    { service: qlbKeychainService('xai', 'default'), account: QLB_KEYCHAIN_ACCOUNT },
    { service: qlbKeychainService('kimi-coding', 'default'), account: QLB_KEYCHAIN_ACCOUNT },
  );
  const unique = new Map<string, KeychainItem>();
  for (const item of items) unique.set(`${item.service}\0${item.account}`, item);
  return [...unique.values()].sort((a, b) => `${a.service}\0${a.account}`.localeCompare(`${b.service}\0${b.account}`));
}

function keychainDigest(db: DatabaseSync, keychain: KeychainBackend): KeychainDigest {
  const result: KeychainDigest = {};
  for (const item of keychainItems(db)) {
    const key = `${item.service}\0${item.account}`;
    try {
      result[key] = sha256(keychain.getSync(item.service, item.account));
    } catch (error) {
      if (!isCredentialNotFound(error)) throw error;
      result[key] = 'absent';
    }
  }
  return result;
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

function parseBaseline(raw: unknown): RestoreBaseline | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const value = JSON.parse(raw) as Partial<RestoreBaseline>;
    if (value?.v !== 1 || typeof value.backupPath !== 'string' || typeof value.saveKind !== 'string'
      || typeof value.userVersion !== 'number' || !value.digest || typeof value.digest !== 'object') return undefined;
    return value as RestoreBaseline;
  } catch {
    return undefined;
  }
}

/** Records the post-save baseline in the transaction that took the backup. */
export function recordRestoreBaseline(db: DatabaseSync, options: BaselineOptions): void {
  if (!db.isTransaction) throw new Error('restore-baseline-needs-transaction');
  if (!SAVE_KINDS.has(options.saveKind)) throw new Error('invalid-restore-baseline-save-kind');
  const existing = db.prepare('SELECT value FROM config WHERE key = ?').get(BASELINE_KEY) as { value: string | null } | undefined;
  if (parseBaseline(existing?.value)?.v === 1) return;

  const baseline: RestoreBaseline = {
    v: 1,
    backupPath: options.backupPath,
    saveKind: options.saveKind,
    userVersion: userVersion(db),
    digest: comparedSetDigest(db),
    keychain: keychainDigest(db, options.keychain),
  };
  db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(BASELINE_KEY, canonicalJson(baseline));
}

function readBaseline(db: DatabaseSync): RestoreBaseline | undefined {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(BASELINE_KEY) as { value: string | null } | undefined;
  return parseBaseline(row?.value);
}

function integrityOk(db: DatabaseSync): boolean {
  const row = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
  return Object.values(row ?? {})[0] === 'ok';
}

/**
 * Read-only D-B82 restore gate. It never changes either database or Keychain.
 */
export function checkRestorePrecondition(livePath: string, options: CheckOptions = {}):
  | { verdict: 'same' }
  | { verdict: 'differ'; reasons: string[] } {
  const live = new DatabaseSync(livePath, { readOnly: true });
  try {
    const baseline = readBaseline(live);
    if (!baseline) return { verdict: 'differ', reasons: ['no-baseline'] };

    const reasons: string[] = [];
    const recordedPath = (live.prepare('SELECT value FROM config WHERE key = ?').get('codex.rekey.backupPath') as { value: string | null } | undefined)?.value;
    if (recordedPath !== baseline.backupPath) reasons.push('backup-path-mismatch');
    if (!existsSync(baseline.backupPath)) {
      reasons.push('backup-missing');
    } else {
      let copy: DatabaseSync | undefined;
      try {
        copy = new DatabaseSync(baseline.backupPath, { readOnly: true });
        if (!integrityOk(copy)) reasons.push('backup-integrity');
      } catch {
        // An unreadable copy cannot satisfy integrity_check; fail closed.
        reasons.push('backup-integrity');
      } finally {
        copy?.close();
      }
    }
    if (userVersion(live) !== baseline.userVersion) reasons.push('user-version');
    if (baseline.saveKind === 'existing-adopt' || baseline.saveKind === 'add-replace') reasons.push('backup-save-renewal');

    const digest = comparedSetDigest(live);
    for (const entry of Object.keys(digest)) {
      if (digest[entry] !== baseline.digest[entry]) reasons.push(entry);
    }
    try {
      const actual = keychainDigest(live, options.keychain ?? platformKeychain);
      if (canonicalJson(actual) !== canonicalJson(baseline.keychain)) reasons.push('keychain');
    } catch {
      reasons.push('keychain');
    }
    return reasons.length === 0 ? { verdict: 'same' } : { verdict: 'differ', reasons };
  } finally {
    live.close();
  }
}
