/*
 * Ported from claude-swap 0.28.0.
 * Upstream file(s): src/claude_swap/credentials.py:152,352,417,456-485,1101-1213,1262-1405.
 * License: MIT.
 * Modified for QLB. See NOTICE.
 */

// Claude-slot credential storage (§3.1, S17, S36, S42, S46).
// Credential bytes are accepted only through injected backends and are never
// included in errors, return metadata, or filesystem names.

import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openStoreConnection } from './store';
import { assertAdmittedInConnection } from './lifecycle';
import { credentialFingerprint } from './anthropic-oauth';
import { isCredentialNotFound } from './credential-backends';
import { KeychainReadBackoff, platformKeychain, qlbKeychainService, QLB_KEYCHAIN_ACCOUNT } from './keychain';

const DISPLAY_CACHE_TTL_MS = 60_000;
const ANTHROPIC_PROVIDER = 'anthropic';

export interface ClaudeSlotBackend {
  readonly kind?: string;
  get(service: string, account: string): Promise<string>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

export interface ClaudeSlot {
  accountId: string;
  slotNum?: number | null;
  email?: string | null;
  alias?: string | null;
  orgUuid?: string | null;
  configJson?: string;
  fingerprint: string | null;
  prevFingerprint: string | null;
  threshold?: number | null;
  dead?: boolean;
  deadReason?: string | null;
  deadAt?: number | null;
  healedAt?: number | null;
  addedAt: number;
  lastActiveAt?: number | null;
  source?: string | null;
  archivedAt?: number | null;
}

export interface CreateClaudeSlotInput {
  accountId: string;
  credential: string;
  slotNum?: number | null;
  email?: string | null;
  alias?: string | null;
  orgUuid?: string | null;
  configJson?: string;
  threshold?: number | null;
  source: string;
}

export interface LineageAppend {
  ts: number;
  provider: 'anthropic';
  accountId: string;
  fromFp: string | null;
  toFp: string;
  cause: string;
  by: string;
  evidence?: 'post' | 'oracle' | 'lineage' | 'holder' | 'auth-time' | 'identity' | 'import' | 'undo' | null;
}

/** The one-transaction §4.13 metadata effect after the slot credential is durable. */
export interface ClaudeAddEffectsInput {
  accountId: string;
  fingerprint: string;
  email: string | null;
  alias: string | null;
  orgUuid: string | null;
  configJson: string;
  now: number;
  mode: 'add' | 'replace';
  /** True only when the Keychain predecessor was saved or the lineage advanced. */
  advancePrevious: boolean;
  /** Byte-identical current credential: report success without a Keychain rewrite. */
  credentialUnchanged: boolean;
}

export interface ClaudeAddEffectsResult {
  kind: 'added' | 'replaced' | 'already-current';
  slotNum: number;
}

/** A lifecycle refusal observed by the transaction-owning repository connection. */
export class ClaudeAddAdmissionRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ClaudeAddAdmissionRefused';
  }
}

/** Persistence boundary: tests use the in-memory implementation; production uses SQLite. */
type RollbackHook = () => Promise<void> | void;
type RegisterRollback = (hook: RollbackHook) => void;

export interface ClaudeSlotRepository {
  getSlot(accountId: string): ClaudeSlot | null;
  listSlots(): ClaudeSlot[];
  createSlot(slot: ClaudeSlot): void;
  /** Holds SQLite's write lock across the credential and metadata effects. */
  withWriteTransaction<T>(fn: (onRollback: RegisterRollback) => Promise<T>): Promise<T>;
  /** Called first inside the write transaction, on its own database connection. */
  assertAddAdmitted(): void;
  /** Each method is one SQLite transaction in production. */
  createSlotWithLineage(slot: ClaudeSlot, lineage: LineageAppend): void;
  updateCredentialWithLineage(accountId: string, expectedFingerprint: string | null, fingerprint: string, prevFingerprint: string | null, lineage: LineageAppend | null): void;
  removeSlotWithGeneration(accountId: string): void;
  /** Must run inside `withWriteTransaction`; writes slots, lineage, account, active login, and relogin atomically. */
  applyAddEffects(input: ClaudeAddEffectsInput): ClaudeAddEffectsResult;
  currentGeneration(): number;
}

function cloneSlot(slot: ClaudeSlot): ClaudeSlot {
  return { ...slot };
}

/** Test repository with no filesystem or SQLite effects. */
export class InMemoryClaudeSlotRepository implements ClaudeSlotRepository {
  private readonly slots = new Map<string, ClaudeSlot>();
  readonly transitions: LineageAppend[] = [];
  readonly accounts: Array<{ id: string; provider: string; label: string; status: string }> = [];
  readonly relogins: Array<{ provider: string; accountId: string; kind: string }> = [];
  activeLogin: { provider: string; accountId: string; setBy: string } | null = null;
  generation = 0;

  getSlot(accountId: string): ClaudeSlot | null {
    const slot = this.slots.get(accountId);
    return slot ? cloneSlot(slot) : null;
  }

  listSlots(): ClaudeSlot[] {
    return [...this.slots.values()].map(cloneSlot);
  }

  async withWriteTransaction<T>(fn: (onRollback: RegisterRollback) => Promise<T>): Promise<T> {
    const rollbackHooks: RollbackHook[] = [];
    try {
      return await fn((hook) => rollbackHooks.push(hook));
    } catch (error) {
      for (const hook of rollbackHooks.reverse()) {
        try { await hook(); } catch { /* preserve original failure */ }
      }
      throw error;
    }
  }

  assertAddAdmitted(): void {
    // In-memory repositories have no lifecycle database; command integration
    // tests exercise the SQLite implementation below.
  }

  createSlot(slot: ClaudeSlot): void {
    if (this.slots.has(slot.accountId)) throw new Error('Claude slot already exists');
    this.slots.set(slot.accountId, cloneSlot(slot));
  }

  createSlotWithLineage(slot: ClaudeSlot, lineage: LineageAppend): void {
    if (this.slots.has(slot.accountId)) throw new Error('Claude slot already exists');
    this.slots.set(slot.accountId, cloneSlot(slot));
    this.transitions.push({ ...lineage });
    this.generation += 1;
  }

  updateCredentialWithLineage(accountId: string, expectedFingerprint: string | null, fingerprint: string, prevFingerprint: string | null, lineage: LineageAppend | null): void {
    const slot = this.slots.get(accountId);
    if (!slot) throw new Error('Claude slot not found');
    if (slot.fingerprint !== expectedFingerprint) throw new Error('Claude slot changed concurrently');
    slot.fingerprint = fingerprint;
    slot.prevFingerprint = prevFingerprint;
    // A real lineage change heals a dead slot; idempotent writes never do.
    if (slot.dead) slot.healedAt = lineage?.ts ?? slot.healedAt;
    slot.dead = false;
    slot.deadReason = null;
    if (lineage) this.transitions.push({ ...lineage });
    this.generation += 1;
  }

  removeSlotWithGeneration(accountId: string): void {
    this.slots.delete(accountId);
    this.generation += 1;
  }

  applyAddEffects(input: ClaudeAddEffectsInput): ClaudeAddEffectsResult {
    const existing = this.slots.get(input.accountId);
    if (input.mode === 'add') {
      if (existing && existing.archivedAt == null) throw new Error('Claude slot already exists');
      const slotNum = existing?.slotNum ?? Math.max(0, ...[...this.slots.values()].map((slot) => slot.slotNum ?? 0)) + 1;
      this.slots.set(input.accountId, {
        accountId: input.accountId, slotNum, email: input.email, alias: input.alias,
        orgUuid: input.orgUuid, configJson: input.configJson, fingerprint: input.fingerprint,
        prevFingerprint: null, dead: false, addedAt: input.now, lastActiveAt: null,
        source: 'qlb-add', archivedAt: null,
      });
      this.transitions.push({ ts: input.now, provider: ANTHROPIC_PROVIDER, accountId: input.accountId,
        fromFp: null, toFp: input.fingerprint, cause: 'add', by: 'qlb-cli', evidence: 'identity' });
      this.upsertAddAccount(input.accountId, input.email);
      if (!this.activeLogin || this.activeLogin.accountId !== input.accountId) {
        this.activeLogin = { provider: ANTHROPIC_PROVIDER, accountId: input.accountId, setBy: 'adopt' };
      }
      this.generation += 1;
      return { kind: 'added', slotNum };
    }
    if (!existing) throw new Error('Claude replace slot not found');
    const previousFingerprint = existing.fingerprint;
    existing.email = input.email;
    existing.alias = input.alias ?? existing.alias ?? null;
    existing.orgUuid = input.orgUuid;
    existing.configJson = input.configJson;
    existing.prevFingerprint = input.advancePrevious ? previousFingerprint : existing.prevFingerprint;
    existing.fingerprint = input.fingerprint;
    existing.dead = false;
    existing.deadReason = null;
    existing.deadAt = null;
    existing.healedAt = input.now;
    existing.archivedAt = null;
    if (previousFingerprint !== input.fingerprint) {
      this.transitions.push({ ts: input.now, provider: ANTHROPIC_PROVIDER, accountId: input.accountId,
        fromFp: previousFingerprint, toFp: input.fingerprint, cause: 'replace', by: 'qlb-cli', evidence: 'identity' });
    }
    this.upsertAddAccount(input.accountId, input.email);
    if (!this.activeLogin || this.activeLogin.accountId !== input.accountId) {
      this.activeLogin = { provider: ANTHROPIC_PROVIDER, accountId: input.accountId, setBy: 'adopt' };
    }
    this.relogins.push({ provider: ANTHROPIC_PROVIDER, accountId: input.accountId, kind: 'identity-replaced' });
    this.generation += 1;
    return { kind: input.credentialUnchanged ? 'already-current' : 'replaced', slotNum: existing.slotNum ?? 0 };
  }

  /** Test-only setup for an A7 dead-slot fixture. */
  markDead(accountId: string): void {
    const slot = this.slots.get(accountId);
    if (!slot) throw new Error('Claude slot not found');
    slot.dead = true;
    slot.deadReason = 'fixture';
    slot.deadAt = 1;
  }

  private upsertAddAccount(id: string, email: string | null): void {
    const existing = this.accounts.find((account) => account.id === id);
    const row = { id, provider: ANTHROPIC_PROVIDER, label: email ?? id, status: 'active' };
    if (existing) Object.assign(existing, row);
    else this.accounts.push(row);
  }

  currentGeneration(): number {
    return this.generation;
  }
}

/** SQLite adapter for the v5 `claude_slots`, `lineage_log`, and config tables. */
export class SqliteClaudeSlotRepository implements ClaudeSlotRepository {
  private static readonly writeQueues = new Map<string, Promise<void>>();
  private static nextConnectionId = 0;
  private writeTransactionActive = false;

  constructor(
    private readonly db: ReturnType<typeof openStoreConnection>,
    private readonly writeQueueKey = `connection-${SqliteClaudeSlotRepository.nextConnectionId++}`,
  ) {}

  static open(dbPath: string): SqliteClaudeSlotRepository {
    return new SqliteClaudeSlotRepository(openStoreConnection(dbPath), dbPath);
  }

  close(): void {
    this.db.close();
  }

  assertAddAdmitted(): void {
    if (!this.writeTransactionActive) throw new Error('Claude add admission requires a write transaction');
    const admission = assertAdmittedInConnection(this.db, 'claude-add');
    if (!admission.ok) throw new ClaudeAddAdmissionRefused(admission.code ?? 'lifecycle-refused');
  }

  getSlot(accountId: string): ClaudeSlot | null {
    const row = this.db.prepare(`SELECT account_id, slot_num, email, alias, org_uuid, config_json,
      fingerprint, prev_fingerprint, threshold, dead, dead_reason, dead_at, healed_at,
      added_at, last_active_at, source, archived_at FROM claude_slots WHERE account_id = ?`).get(accountId) as Record<string, unknown> | undefined;
    return row ? this.toSlot(row) : null;
  }

  listSlots(): ClaudeSlot[] {
    return (this.db.prepare(`SELECT account_id, slot_num, email, alias, org_uuid, config_json,
      fingerprint, prev_fingerprint, threshold, dead, dead_reason, dead_at, healed_at,
      added_at, last_active_at, source, archived_at FROM claude_slots ORDER BY slot_num, account_id`).all() as Record<string, unknown>[]).map((row) => this.toSlot(row));
  }

  async withWriteTransaction<T>(fn: (onRollback: RegisterRollback) => Promise<T>): Promise<T> {
    const previous = SqliteClaudeSlotRepository.writeQueues.get(this.writeQueueKey) ?? Promise.resolve();
    let release!: () => void;
    const own = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => own);
    SqliteClaudeSlotRepository.writeQueues.set(this.writeQueueKey, queued);
    await previous;
    let began = false;
    const rollbackHooks: RollbackHook[] = [];
    try {
      this.db.exec('BEGIN IMMEDIATE');
      began = true;
      this.writeTransactionActive = true;
      const result = await fn((hook) => rollbackHooks.push(hook));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (began) {
        try { this.db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
      }
      for (const hook of rollbackHooks.reverse()) {
        try { await hook(); } catch { /* preserve original failure */ }
      }
      throw error;
    } finally {
      this.writeTransactionActive = false;
      release();
      if (SqliteClaudeSlotRepository.writeQueues.get(this.writeQueueKey) === queued) {
        SqliteClaudeSlotRepository.writeQueues.delete(this.writeQueueKey);
      }
    }
  }

  createSlot(slot: ClaudeSlot): void {
    this.db.prepare(`INSERT INTO claude_slots (account_id, slot_num, email, alias, org_uuid, config_json,
      fingerprint, prev_fingerprint, threshold, dead, dead_reason, dead_at, healed_at,
      added_at, last_active_at, source, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(slot.accountId, slot.slotNum ?? null, slot.email ?? null, slot.alias ?? null, slot.orgUuid ?? null,
        slot.configJson ?? '{}', slot.fingerprint, slot.prevFingerprint, slot.threshold ?? null,
        slot.dead ? 1 : 0, slot.deadReason ?? null, slot.deadAt ?? null, slot.healedAt ?? null,
        slot.addedAt, slot.lastActiveAt ?? null, slot.source ?? null, slot.archivedAt ?? null);
  }

  createSlotWithLineage(slot: ClaudeSlot, lineage: LineageAppend): void {
    this.transaction(() => {
      this.createSlot(slot);
      this.appendLineage(lineage);
      this.bumpGenerationInTransaction();
    });
  }

  updateCredentialWithLineage(accountId: string, expectedFingerprint: string | null, fingerprint: string, prevFingerprint: string | null, lineage: LineageAppend | null): void {
    this.transaction(() => {
      const result = this.db.prepare(`UPDATE claude_slots
        SET fingerprint = ?, prev_fingerprint = ?, dead = 0, dead_reason = NULL,
          healed_at = CASE WHEN dead != 0 THEN ? ELSE healed_at END
        WHERE account_id = ? AND fingerprint IS ?`).run(fingerprint, prevFingerprint, lineage?.ts ?? null, accountId, expectedFingerprint);
      if (Number(result.changes) !== 1) throw new Error('Claude slot changed concurrently');
      if (lineage) this.appendLineage(lineage);
      this.bumpGenerationInTransaction();
    });
  }

  removeSlotWithGeneration(accountId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM claude_slots WHERE account_id = ?').run(accountId);
      this.bumpGenerationInTransaction();
    });
  }

  applyAddEffects(input: ClaudeAddEffectsInput): ClaudeAddEffectsResult {
    if (!this.writeTransactionActive) throw new Error('Claude add effects require a write transaction');
    const existing = this.getSlot(input.accountId);
    let result: ClaudeAddEffectsResult;
    if (input.mode === 'add') {
      if (existing && existing.archivedAt == null) throw new Error('Claude slot already exists');
      const slotNum = existing?.slotNum ?? Number((this.db.prepare(
        'SELECT COALESCE(MAX(slot_num), 0) + 1 AS slot_num FROM claude_slots',
      ).get() as { slot_num: number }).slot_num);
      if (existing) {
        this.db.prepare(`UPDATE claude_slots SET slot_num = ?, email = ?, alias = ?, org_uuid = ?, config_json = ?,
          fingerprint = ?, prev_fingerprint = NULL, dead = 0, dead_reason = NULL, dead_at = NULL,
          healed_at = NULL, added_at = ?, last_active_at = NULL, source = 'qlb-add', archived_at = NULL
          WHERE account_id = ?`).run(
          slotNum, input.email, input.alias, input.orgUuid, input.configJson, input.fingerprint, input.now, input.accountId,
        );
      } else {
        this.createSlot({
          accountId: input.accountId, slotNum, email: input.email, alias: input.alias, orgUuid: input.orgUuid,
          configJson: input.configJson, fingerprint: input.fingerprint, prevFingerprint: null, dead: false,
          addedAt: input.now, lastActiveAt: null, source: 'qlb-add', archivedAt: null,
        });
      }
      this.appendLineage({ ts: input.now, provider: ANTHROPIC_PROVIDER, accountId: input.accountId,
        fromFp: null, toFp: input.fingerprint, cause: 'add', by: 'qlb-cli', evidence: 'identity' });
      result = { kind: 'added', slotNum };
    } else {
      if (!existing) throw new Error('Claude replace slot not found');
      this.db.prepare(`UPDATE claude_slots SET email = ?, alias = COALESCE(?, alias), org_uuid = ?, config_json = ?,
        fingerprint = ?, prev_fingerprint = ?, dead = 0, dead_reason = NULL, dead_at = NULL, healed_at = ?,
        archived_at = NULL WHERE account_id = ?`).run(
        input.email, input.alias, input.orgUuid, input.configJson, input.fingerprint,
        input.advancePrevious ? existing.fingerprint : existing.prevFingerprint, input.now, input.accountId,
      );
      if (existing.fingerprint !== input.fingerprint) {
        this.appendLineage({ ts: input.now, provider: ANTHROPIC_PROVIDER, accountId: input.accountId,
          fromFp: existing.fingerprint, toFp: input.fingerprint, cause: 'replace', by: 'qlb-cli', evidence: 'identity' });
      }
      this.db.prepare(`INSERT INTO relogin_events (ts, provider, account_id, kind, detail, evidence, user_denied_at)
        VALUES (?, ?, ?, 'identity-replaced', NULL, 'identity', NULL)`).run(input.now, ANTHROPIC_PROVIDER, input.accountId);
      result = { kind: input.credentialUnchanged ? 'already-current' : 'replaced', slotNum: existing.slotNum ?? 0 };
    }
    this.db.prepare(`INSERT INTO accounts (id, provider, label, status, created_at) VALUES (?, ?, ?, 'active', ?)
      ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, label = excluded.label`).run(
      input.accountId, ANTHROPIC_PROVIDER, input.email ?? input.accountId, input.now,
    );
    const active = this.db.prepare('SELECT account_id FROM active_login WHERE provider = ?').get(ANTHROPIC_PROVIDER) as { account_id?: string } | undefined;
    if (!active || active.account_id !== input.accountId) {
      this.db.prepare(`INSERT INTO active_login (provider, account_id, since, set_by) VALUES (?, ?, ?, 'adopt')
        ON CONFLICT(provider) DO UPDATE SET account_id = excluded.account_id, since = excluded.since, set_by = excluded.set_by`)
        .run(ANTHROPIC_PROVIDER, input.accountId, input.now);
    }
    this.bumpGenerationInTransaction();
    return result;
  }

  currentGeneration(): number {
    const row = this.db.prepare("SELECT value FROM config WHERE key = 'slots.generation'").get() as { value?: string } | undefined;
    const value = Number(row?.value ?? '0');
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  private transaction(fn: () => void): void {
    if (this.writeTransactionActive) {
      fn();
      return;
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.writeTransactionActive = true;
    try { fn(); this.db.exec('COMMIT'); } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    } finally {
      this.writeTransactionActive = false;
    }
  }

  private bumpGenerationInTransaction(): void {
    const next = this.currentGeneration() + 1;
    this.db.prepare(`INSERT INTO config (key, value) VALUES ('slots.generation', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(next));
  }

  private appendLineage(row: LineageAppend): void {
    this.db.prepare(`INSERT INTO lineage_log (ts, provider, account_id, from_fp, to_fp, cause, by, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.ts, row.provider, row.accountId, row.fromFp, row.toFp, row.cause, row.by, row.evidence ?? null,
    );
  }

  private toSlot(row: Record<string, unknown>): ClaudeSlot {
    return {
      accountId: String(row.account_id), slotNum: row.slot_num as number | null,
      email: row.email as string | null, alias: row.alias as string | null,
      orgUuid: row.org_uuid as string | null, configJson: String(row.config_json),
      fingerprint: row.fingerprint as string | null, prevFingerprint: row.prev_fingerprint as string | null,
      threshold: row.threshold as number | null, dead: Number(row.dead) !== 0,
      deadReason: row.dead_reason as string | null, deadAt: row.dead_at as number | null,
      healedAt: row.healed_at as number | null, addedAt: Number(row.added_at),
      lastActiveAt: row.last_active_at as number | null, source: row.source as string | null,
      archivedAt: row.archived_at as number | null,
    };
  }
}

export interface UnclaimedRecord {
  credential: string;
  consumedFp?: string;
}

export interface RestoreUnclaimedResult {
  cleanupPending: boolean;
}

export interface ClaudeSlotFileOps {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<string | undefined>;
  chmod(path: string, mode: number): Promise<void>;
  writeFile(path: string, data: string, options: { encoding: 'utf8'; mode: number; flag: 'wx' }): Promise<void>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readdir(path: string): Promise<string[]>;
  rm(path: string, options: { force: boolean }): Promise<void>;
}

const defaultFileOps: ClaudeSlotFileOps = {
  mkdir, chmod, writeFile, readFile, readdir, rm,
};

export interface ClaudeSlotsOptions {
  backend?: ClaudeSlotBackend;
  repository: ClaudeSlotRepository;
  stashDir: string;
  now?: () => number;
  readBackoff?: KeychainReadBackoff;
  files?: ClaudeSlotFileOps;
}

export interface ReadSlotOptions {
  /** Display reads only; correctness reads are fresh by default. */
  cached?: boolean;
  /** @deprecated Fresh is the default; retained for call-site compatibility. */
  fresh?: boolean;
}

export interface ReadClaudeSlot {
  credential: string;
  fingerprint: string;
}

type CachedSlot = ReadClaudeSlot & { expiresAt: number; generation: number };

function missingItem(error: unknown): boolean {
  return isCredentialNotFound(error);
}

function assertId(value: string, kind: string): void {
  if (!value || /[\0/\\]/.test(value)) throw new Error(`invalid ${kind}`);
}

function assertSlotId(value: string): void {
  // `:prev` and `unclaimed:` are storage namespaces, never slot identifiers.
  if (!value || /[\0/\\:]/.test(value)) throw new Error('invalid slot id');
}

function parseUnclaimed(text: string): UnclaimedRecord {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('unclaimed stash is malformed'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('unclaimed stash is malformed');
  const record = value as Record<string, unknown>;
  if (typeof record.credential !== 'string' || !record.credential) throw new Error('unclaimed stash is malformed');
  if (record.consumedFp != null && typeof record.consumedFp !== 'string') throw new Error('unclaimed stash is malformed');
  return record.consumedFp ? { credential: record.credential, consumedFp: record.consumedFp } : { credential: record.credential };
}

/**
 * Slot/keychain coordinator. Every effect is injectable: tests use an
 * in-memory credential backend, in-memory repository, clock, and temp files.
 */
export class ClaudeSlots {
  private readonly backend: ClaudeSlotBackend;
  private readonly now: () => number;
  private readonly backoff: KeychainReadBackoff;
  private readonly files: ClaudeSlotFileOps;
  private readonly cache = new Map<string, CachedSlot>();
  private readonly slotWrites = new Map<string, Promise<void>>();
  private cacheEpoch = 0;

  constructor(private readonly options: ClaudeSlotsOptions) {
    this.backend = options.backend ?? platformKeychain;
    this.now = options.now ?? Date.now;
    this.backoff = options.readBackoff ?? new KeychainReadBackoff({ now: this.now });
    this.files = options.files ?? defaultFileOps;
  }

  listSlots(): ClaudeSlot[] {
    return this.options.repository.listSlots();
  }

  async createSlot(input: CreateClaudeSlotInput): Promise<ClaudeSlot> {
    assertSlotId(input.accountId);
    return this.withSlotWrite(input.accountId, () => this.options.repository.withWriteTransaction(async (onRollback) => {
      const fingerprint = this.fingerprint(input.credential);
      const existing = this.options.repository.getSlot(input.accountId);
      if (existing) throw new Error('Claude slot already exists');
      const previous = await this.readExistingCredential(input.accountId);
      if (previous != null) throw new Error('Claude slot credential already exists');
      const slot: ClaudeSlot = {
        accountId: input.accountId, slotNum: input.slotNum ?? null, email: input.email ?? null,
        alias: input.alias ?? null, orgUuid: input.orgUuid ?? null, configJson: input.configJson ?? '{}',
        fingerprint, prevFingerprint: null, threshold: input.threshold ?? null, dead: false,
        addedAt: this.now(), lastActiveAt: null, source: input.source, archivedAt: null,
      };
      this.invalidateCache();
      // The hook covers failures from the outer COMMIT as well as errors from
      // the nested repository operation.
      onRollback(() => this.restoreServiceIfUnchanged(this.slotService(input.accountId), input.credential, null));
      await this.backend.set(this.slotService(input.accountId), QLB_KEYCHAIN_ACCOUNT, input.credential);
      this.options.repository.createSlotWithLineage(slot, {
        ts: slot.addedAt, provider: ANTHROPIC_PROVIDER, accountId: input.accountId, fromFp: null,
        toFp: fingerprint, cause: input.source === 'cswap-import' ? 'import' : 'add', by: 'qlb-cli',
        evidence: input.source === 'cswap-import' ? 'import' : 'identity',
      });
      this.invalidateCache();
      return slot;
    }));
  }

  /** Fresh correctness read by default; only display callers opt into the cache. */
  async readSlot(accountId: string, options: ReadSlotOptions = {}): Promise<ReadClaudeSlot> {
    assertSlotId(accountId);
    const cachedRead = options.cached === true && options.fresh !== true;
    const now = this.now();
    const generation = this.options.repository.currentGeneration();
    const cached = this.cache.get(accountId);
    if (cachedRead && cached && cached.expiresAt > now && cached.generation === generation) {
      return { credential: cached.credential, fingerprint: cached.fingerprint };
    }

    const epoch = this.cacheEpoch;
    const credential = await this.readWithBackoff(
      () => this.backend.get(this.slotService(accountId), QLB_KEYCHAIN_ACCOUNT),
      !cachedRead,
    );
    const result: ReadClaudeSlot = { credential, fingerprint: this.fingerprint(credential) };
    if (cachedRead && epoch === this.cacheEpoch && generation === this.options.repository.currentGeneration()) {
      this.cache.set(accountId, { ...result, expiresAt: now + DISPLAY_CACHE_TTL_MS, generation });
    }
    return result;
  }

  async writeSlot(accountId: string, credential: string, transition: { cause: string; by?: string; evidence?: LineageAppend['evidence'] }): Promise<void> {
    assertSlotId(accountId);
    return this.withSlotWrite(accountId, () => this.options.repository.withWriteTransaction(
      (onRollback) => this.writeSlotUnlocked(accountId, credential, transition, onRollback),
    ));
  }

  private async writeSlotUnlocked(accountId: string, credential: string, transition: { cause: string; by?: string; evidence?: LineageAppend['evidence'] }, onRollback: RegisterRollback): Promise<void> {
    const slot = this.options.repository.getSlot(accountId);
    if (!slot) throw new Error('Claude slot not found');
    const nextFingerprint = this.fingerprint(credential);
    const existing = await this.readExistingCredential(accountId);
    // Fingerprints identify credential lineage, but refreshes may retain the
    // refresh token while changing access-token or expiry bytes. Only a full
    // byte-for-byte match is an idempotent write.
    if (slot.fingerprint === nextFingerprint && existing === credential) return;
    const previous = await this.readPreviousCredential(accountId);
    const saveExistingAsPrevious = existing != null && existing !== credential;
    // The DB record is the CAS and restore-lineage authority. A Keychain-only
    // crash-window successor must never become a self-edge on retry.
    const lineage = slot.fingerprint === nextFingerprint ? null : {
      ts: this.now(), provider: ANTHROPIC_PROVIDER, accountId, fromFp: slot.fingerprint,
      toFp: nextFingerprint, cause: transition.cause, by: transition.by ?? 'qlb-cli', evidence: transition.evidence ?? 'lineage',
    } satisfies LineageAppend;
    const prevFingerprint = lineage || saveExistingAsPrevious ? slot.fingerprint : slot.prevFingerprint;
    this.invalidateCache();
    // Register before the first mutation so a backend error after a partial
    // write and a failed outer COMMIT both restore the observed pre-image.
    onRollback(() => this.restoreCredentialPair(
      accountId, existing, previous, credential, saveExistingAsPrevious ? existing : previous,
    ));
    if (saveExistingAsPrevious) await this.backend.set(this.previousService(accountId), QLB_KEYCHAIN_ACCOUNT, existing);
    await this.backend.set(this.slotService(accountId), QLB_KEYCHAIN_ACCOUNT, credential);
    // Even without a lineage edge, a changed credential blob must invalidate
    // display readers in other processes via slots.generation.
    this.options.repository.updateCredentialWithLineage(accountId, slot.fingerprint, nextFingerprint, prevFingerprint, lineage);
    this.invalidateCache();
  }

  /** §4.13: persist a current Claude login without touching the live store. */
  async applyAdd(input: {
    accountId: string;
    credential: string;
    email: string | null;
    alias: string | null;
    orgUuid: string | null;
    configJson: string;
    replace: boolean;
  }): Promise<ClaudeAddEffectsResult> {
    assertSlotId(input.accountId);
    return this.withSlotWrite(input.accountId, () => this.options.repository.withWriteTransaction(async (onRollback) => {
      this.options.repository.assertAddAdmitted();
      const existing = this.options.repository.getSlot(input.accountId);
      if (input.replace ? !existing : Boolean(existing && existing.archivedAt == null)) {
        throw new Error(input.replace ? 'Claude replace slot not found' : 'Claude slot already exists');
      }
      const fingerprint = this.fingerprint(input.credential);
      const oldCurrent = await this.readExistingCredential(input.accountId);
      // Add must preserve createSlot's crash-window orphan guard, including
      // when an archived row is being reactivated.
      if (!input.replace && oldCurrent != null) throw new Error('Claude slot credential already exists');
      const oldPrevious = await this.readPreviousCredential(input.accountId);
      const savePrevious = input.replace && oldCurrent != null && oldCurrent !== input.credential;
      const clearArchivedPrevious = !input.replace && existing?.archivedAt != null && oldPrevious != null;
      const credentialUnchanged = input.replace && existing?.fingerprint === fingerprint && oldCurrent === input.credential;
      const advancePrevious = Boolean(existing && (savePrevious || existing.fingerprint !== fingerprint));
      if (!credentialUnchanged) {
        this.invalidateCache();
        onRollback(() => this.restoreCredentialPair(
          input.accountId, oldCurrent, oldPrevious, input.credential,
          savePrevious ? oldCurrent : clearArchivedPrevious ? null : oldPrevious,
        ));
        if (savePrevious) await this.backend.set(this.previousService(input.accountId), QLB_KEYCHAIN_ACCOUNT, oldCurrent!);
        else if (clearArchivedPrevious) await this.deleteIfPresent(this.previousService(input.accountId));
        await this.backend.set(this.slotService(input.accountId), QLB_KEYCHAIN_ACCOUNT, input.credential);
      }
      const result = this.options.repository.applyAddEffects({
        accountId: input.accountId, fingerprint, email: input.email, alias: input.alias, orgUuid: input.orgUuid,
        configJson: input.configJson, now: this.now(), mode: input.replace ? 'replace' : 'add',
        advancePrevious, credentialUnchanged,
      });
      this.invalidateCache();
      return result;
    }));
  }

  async deleteSlot(accountId: string): Promise<void> {
    assertSlotId(accountId);
    return this.withSlotWrite(accountId, () => this.options.repository.withWriteTransaction(async (onRollback) => {
      if (!this.options.repository.getSlot(accountId)) throw new Error('Claude slot not found');
      const current = await this.readExistingCredential(accountId);
      const previous = await this.readPreviousCredential(accountId);
      this.invalidateCache();
      onRollback(() => this.restoreCredentialPair(accountId, current, previous, null, null));
      await this.deleteIfPresent(this.slotService(accountId));
      await this.deleteIfPresent(this.previousService(accountId));
      this.options.repository.removeSlotWithGeneration(accountId);
      this.invalidateCache();
    }));
  }

  /** S36: Keychain first; a private file is retained only if that write fails. */
  async stashUnclaimed(timestamp: string, credential: string, consumedFp?: string): Promise<{ location: 'keychain' | 'file'; path?: string }> {
    this.assertTimestamp(timestamp);
    const record = JSON.stringify({ credential, ...(consumedFp ? { consumedFp } : {}) });
    try {
      await this.backend.set(this.unclaimedService(timestamp), QLB_KEYCHAIN_ACCOUNT, record);
      return { location: 'keychain' };
    } catch {
      const path = this.filePath(timestamp);
      await this.files.mkdir(this.options.stashDir, { recursive: true, mode: 0o700 });
      await this.files.chmod(this.options.stashDir, 0o700);
      try {
        await this.files.writeFile(path, record, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      } catch (error) {
        // Retrying a stash for the same timestamp may only replace an existing
        // value through Keychain; never overwrite a file that might be newer.
        throw new Error('unable to persist unclaimed credential');
      }
      await this.files.chmod(path, 0o600);
      return { location: 'file', path };
    }
  }

  /** Moves any surviving S36 fallback files into Keychain without exposing their contents. */
  async sweepUnclaimed(): Promise<{ swept: number; retained: number }> {
    let names: string[];
    try { names = await this.files.readdir(this.options.stashDir); } catch { return { swept: 0, retained: 0 }; }
    let swept = 0;
    let retained = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const timestamp = name.slice(0, -'.json'.length);
      try {
        this.assertTimestamp(timestamp);
        const text = await this.files.readFile(join(this.options.stashDir, name), 'utf8');
        parseUnclaimed(text);
        await this.backend.set(this.unclaimedService(timestamp), QLB_KEYCHAIN_ACCOUNT, text);
        await this.files.rm(join(this.options.stashDir, name), { force: true });
        swept += 1;
      } catch {
        retained += 1;
      }
    }
    return { swept, retained };
  }

  /** Restores an S36 record only when it was issued from the slot's current lineage. */
  async restoreUnclaimed(timestamp: string, accountId: string): Promise<RestoreUnclaimedResult> {
    this.assertTimestamp(timestamp);
    assertSlotId(accountId);
    return this.withSlotWrite(accountId, async () => {
      await this.options.repository.withWriteTransaction(async (onRollback) => {
        const record = await this.readUnclaimed(timestamp);
        const slot = this.options.repository.getSlot(accountId);
        if (!slot) throw new Error('Claude slot not found');
        if (!record.consumedFp || record.consumedFp !== slot.fingerprint) throw new Error('unclaimed lineage mismatch');
        await this.writeSlotUnlocked(accountId, record.credential, { cause: 'stash-adopt', evidence: 'lineage' }, onRollback);
      });
      try {
        // The safety copy is only disposable after its slot metadata commit.
        await this.deleteUnclaimed(timestamp);
        return { cleanupPending: false };
      } catch {
        // The restore is durable, but callers must disclose the retained copy.
        return { cleanupPending: true };
      }
    });
  }

  private async readExistingCredential(accountId: string): Promise<string | null> {
    try {
      return await this.readWithBackoff(
        () => this.backend.get(this.slotService(accountId), QLB_KEYCHAIN_ACCOUNT),
        true,
      );
    } catch (error) {
      if (missingItem(error)) return null;
      throw error;
    }
  }

  private async readPreviousCredential(accountId: string): Promise<string | null> {
    try { return await this.backend.get(this.previousService(accountId), QLB_KEYCHAIN_ACCOUNT); } catch (error) {
      if (missingItem(error)) return null;
      throw error;
    }
  }

  private async readUnclaimed(timestamp: string): Promise<UnclaimedRecord> {
    try {
      return parseUnclaimed(await this.backend.get(this.unclaimedService(timestamp), QLB_KEYCHAIN_ACCOUNT));
    } catch (keychainError) {
      try {
        return parseUnclaimed(await this.files.readFile(this.filePath(timestamp), 'utf8'));
      } catch {
        if (missingItem(keychainError)) throw new Error('unclaimed credential not found');
        throw new Error('unclaimed credential unavailable');
      }
    }
  }

  private async deleteUnclaimed(timestamp: string): Promise<void> {
    try { await this.backend.delete(this.unclaimedService(timestamp), QLB_KEYCHAIN_ACCOUNT); } catch (error) {
      if (!missingItem(error)) throw new Error('unable to remove unclaimed credential');
    }
    await this.files.rm(this.filePath(timestamp), { force: true });
  }

  private async readWithBackoff(read: () => Promise<string>, fresh: boolean): Promise<string> {
    // KeychainReadBackoff is synchronous, while CredentialBackend is async.
    // Probe its state first, then arm it explicitly for a rejected read.
    this.backoff.read(() => undefined, { fresh });
    try {
      return await read();
    } catch (error) {
      // rc 44 is an ordinary absent item, never a disabled Keychain.
      if (!missingItem(error)) {
        try { this.backoff.read(() => { throw error; }, { fresh: true }); } catch { /* rethrow original below */ }
      }
      throw error;
    }
  }

  private async deleteIfPresent(service: string): Promise<void> {
    try { await this.backend.delete(service, QLB_KEYCHAIN_ACCOUNT); } catch (error) {
      if (!missingItem(error)) throw error;
    }
  }

  private async restoreCredentialPair(
    accountId: string,
    current: string | null,
    previous: string | null,
    expectedCurrent: string | null,
    expectedPrevious: string | null,
  ): Promise<void> {
    try {
      // Do not put stale pre-images over a concurrent writer's values. A
      // writer that respects the SQLite lock cannot interleave; this is a
      // second, conservative guard for failed CAS or backend edge cases.
      await this.restoreServiceIfUnchanged(this.slotService(accountId), expectedCurrent, current);
      await this.restoreServiceIfUnchanged(this.previousService(accountId), expectedPrevious, previous);
    } catch { /* Best-effort compensation; preserve the original persistence error. */ }
  }

  private async restoreServiceIfUnchanged(service: string, expected: string | null, replacement: string | null): Promise<void> {
    let actual: string | null;
    try {
      actual = await this.backend.get(service, QLB_KEYCHAIN_ACCOUNT);
    } catch (error) {
      if (!missingItem(error)) throw error;
      actual = null;
    }
    if (actual !== expected) return;
    if (replacement == null) await this.deleteIfPresent(service);
    else await this.backend.set(service, QLB_KEYCHAIN_ACCOUNT, replacement);
  }

  private async withSlotWrite<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.slotWrites.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const own = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => own);
    this.slotWrites.set(accountId, queued);
    await previous;
    try { return await fn(); } finally {
      release();
      if (this.slotWrites.get(accountId) === queued) this.slotWrites.delete(accountId);
    }
  }

  private fingerprint(credential: string): string {
    const fingerprint = credentialFingerprint(credential);
    if (!fingerprint) throw new Error('invalid Claude credential');
    return fingerprint;
  }

  private invalidateCache(): void {
    this.cacheEpoch += 1;
    this.cache.clear();
  }

  private slotService(accountId: string): string {
    return qlbKeychainService(ANTHROPIC_PROVIDER, accountId);
  }

  private previousService(accountId: string): string {
    return qlbKeychainService(ANTHROPIC_PROVIDER, `${accountId}:prev`);
  }

  private unclaimedService(timestamp: string): string {
    return qlbKeychainService(ANTHROPIC_PROVIDER, `unclaimed:${timestamp}`);
  }

  private filePath(timestamp: string): string {
    return join(this.options.stashDir, `${timestamp}.json`);
  }

  private assertTimestamp(timestamp: string): void {
    assertId(timestamp, 'unclaimed timestamp');
  }
}
