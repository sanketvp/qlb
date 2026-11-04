// C-swap hand-back planning and execution. Credential bytes stay inside injected
// readers/writers; plans and results expose only non-secret identities.

import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { credentialFingerprint, parseCredentialBlob } from './anthropic-oauth';
import type { ClaudeSlotBackend } from './cc-slots';
import { isCredentialNotFound } from './credential-backends';
import { openStoreConnection, readOnlySchemaRefusal } from './store';

const FINGERPRINT_PREFIX_LENGTH = 'sha256:'.length + 12;

export interface HandBackSlot {
  accountId: string;
  slotNum: number | null;
  email: string | null;
  fingerprint: string | null;
  source: string | null;
  dead: number;
}

export type HandBackAction = 'update' | 'noop';
export type HandBackDestinationState = 'match' | 'rotated' | 'missing' | 'malformed';

export interface HandBackSlotPlan {
  accountId: string;
  accountNumber: number;
  email: string;
  item: string;
  action: HandBackAction;
  destinationState: HandBackDestinationState;
  fingerprint: string;
}

export interface HandBackPlan {
  slots: HandBackSlotPlan[];
  deleteEnc: string[];
  activeAccountNumber: number | null;
}

export interface PlanHandBackDependencies {
  slots: () => HandBackSlot[];
  activeAccountId: () => string | null;
  migratedPiProviders: () => string[];
  backupDir: string;
  keychain: Pick<ClaudeSlotBackend, 'get'>;
  /** Fresh QLB slot read. Its lineage, not the SQLite cache, is authoritative. */
  readSlotCredential?: (accountId: string) => Promise<string>;
  listCredentials?: (path: string) => string[];
}

/** Fresh readonly lifecycle state shared by undo admission and doctor checks. */
export function readPlanState(dbPath: string, missingIsEmpty = false): Pick<PlanHandBackDependencies, 'slots' | 'activeAccountId' | 'migratedPiProviders'> {
  if (missingIsEmpty && !existsSync(dbPath)) {
    return { slots: () => [], activeAccountId: () => null, migratedPiProviders: () => [] };
  }
  const read = <T>(fn: (db: ReturnType<typeof openStoreConnection>) => T): T => {
    const db = openStoreConnection(dbPath, true);
    try {
      const schemaRefusal = readOnlySchemaRefusal(db);
      if (schemaRefusal) throw new Error(schemaRefusal);
      return fn(db);
    } finally { db.close(); }
  };
  return {
    slots: () => read((db) => db.prepare(`SELECT account_id AS accountId, slot_num AS slotNum, email, fingerprint, source, dead
      FROM claude_slots WHERE archived_at IS NULL ORDER BY slot_num, account_id`).all() as unknown as ReturnType<PlanHandBackDependencies['slots']>),
    activeAccountId: () => read((db) => {
      const active = db.prepare("SELECT account_id AS accountId FROM active_login WHERE provider = 'anthropic'").get() as { accountId: string | null } | undefined;
      return active?.accountId ?? null;
    }),
    migratedPiProviders: () => read((db) => {
      const migrated = db.prepare("SELECT key FROM config WHERE key LIKE 'pi.%.state' AND value = 'migrated' ORDER BY key").all() as Array<{ key: string }>;
      return migrated.map(({ key }) => key.slice('pi.'.length, -'.state'.length));
    }),
  };
}

export interface CswapUndoRefusalSlot {
  accountNumber: number;
  email: string;
}

export class CswapUndoRefusalError extends Error {
  constructor(
    readonly code: 'qlb-add-slot' | 'pi-migrated' | 'active-slot-missing',
    readonly provider?: string,
    readonly slots: CswapUndoRefusalSlot[] = [],
  ) {
    super(code);
    this.name = 'CswapUndoRefusalError';
  }
}

export class CswapUndoDrainError extends Error {
  constructor(readonly pids: number[], readonly locks: string[]) {
    super('undo drain timed out');
    this.name = 'CswapUndoDrainError';
  }
}

export class CswapUndoActiveLoginError extends Error {
  readonly reason = 'active-login-unattributed';

  constructor(readonly accountNumber: number) {
    super('active login could not be attributed');
    this.name = 'CswapUndoActiveLoginError';
  }
}

export class CswapUndoVerificationError extends Error {
  constructor(readonly accountNumber: number) {
    super('undo read-back mismatch');
    this.name = 'CswapUndoVerificationError';
  }
}

export class CswapUndoPendingStashError extends Error {
  constructor(readonly stash: string) {
    super('pending Claude stash');
    this.name = 'CswapUndoPendingStashError';
  }
}

export class CswapUndoSequenceError extends Error {
  constructor(readonly reason: 'missing' | 'malformed') {
    super(`C-swap sequence is ${reason}`);
    this.name = 'CswapUndoSequenceError';
  }
}

function requireSlotCoordinate(slot: HandBackSlot, requireEmail = true): { accountNumber: number; email: string } {
  if (!Number.isSafeInteger(slot.slotNum) || slot.slotNum == null || slot.slotNum < 1) {
    throw new Error('Claude hand-back slot coordinates are invalid');
  }
  if (!slot.email || /[\x00-\x1f\x7f\\/:]/.test(slot.email)) {
    if (!requireEmail) return { accountNumber: slot.slotNum, email: '' };
    throw new Error('Claude hand-back slot coordinates are invalid');
  }
  return { accountNumber: slot.slotNum, email: slot.email };
}

function credentialLineage(credential: string, accountNumber: number): string {
  const value = credentialFingerprint(credential);
  if (!value) throw new Error(`Claude hand-back credential is invalid for slot ${accountNumber}`);
  return value;
}

function fingerprintPrefix(value: string): string {
  return value.slice(0, FINGERPRINT_PREFIX_LENGTH);
}

async function optionalCswapCredential(
  keychain: Pick<ClaudeSlotBackend, 'get'>,
  item: string,
): Promise<string | null> {
  try {
    return await keychain.get('claude-swap', item);
  } catch (error) {
    if (isCredentialNotFound(error)) return null;
    throw error;
  }
}

function encryptedCredentials(
  listCredentials: (path: string) => string[],
  backupDir: string,
  accountNumber: number,
): string[] {
  const directory = join(backupDir, 'credentials');
  let names: string[];
  try {
    names = listCredentials(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const prefix = `.creds-${accountNumber}-`;
  return names
    .filter((name) => {
      // Names from a directory are untrusted input. Do not turn a terminal
      // escape/control character into either output or a deletion path.
      if (/[\x00-\x1f\x7f]/.test(name)) throw new Error('C-swap encrypted credential name is invalid');
      return name.startsWith(prefix) && name.endsWith('.enc');
    })
    .sort()
    .map((name) => join(directory, name));
}

async function sourceCredential(deps: PlanHandBackDependencies, accountId: string): Promise<string> {
  if (deps.readSlotCredential) return deps.readSlotCredential(accountId);
  return deps.keychain.get(`qlb:anthropic:${accountId}`, 'qlb');
}

/**
 * Builds a fresh hand-back plan. The QLB Keychain slot is read for every
 * lineage comparison because `claude_slots.fingerprint` is metadata that can
 * lag an in-flight refresh successor.
 */
export function validateHandBackStructure(deps: Pick<PlanHandBackDependencies, 'slots' | 'activeAccountId' | 'migratedPiProviders'>): void {
  const allSlots = deps.slots();
  const activeAccountId = deps.activeAccountId();
  const qlbAdd = allSlots
    // A dead imported slot can be left alone, but a dead qlb-add slot cannot
    // become C-swap's active account: it has no C-swap provenance to restore.
    .filter((slot) => slot.source === 'qlb-add' && (!slot.dead || slot.accountId === activeAccountId))
    .map((slot) => requireSlotCoordinate(slot, false))
    .map(({ accountNumber, email }) => ({ accountNumber, email }))
    .sort((left, right) => left.accountNumber - right.accountNumber);
  if (qlbAdd.length > 0) throw new CswapUndoRefusalError('qlb-add-slot', undefined, qlbAdd);
  const slots = allSlots.filter((slot) => slot.source !== 'qlb-add' && !slot.dead);

  const migrated = deps.migratedPiProviders().sort();
  if (migrated.length > 0) throw new CswapUndoRefusalError('pi-migrated', migrated[0]);

  const active = activeAccountId === null ? null : allSlots.find((slot) => slot.accountId === activeAccountId);
  if ((slots.length > 0 && activeAccountId === null) || (activeAccountId !== null && !active)) {
    throw new CswapUndoRefusalError('active-slot-missing');
  }

  for (const slot of slots) requireSlotCoordinate(slot);
  if (active) requireSlotCoordinate(active);
}

export async function planHandBack(deps: PlanHandBackDependencies): Promise<HandBackPlan> {
  validateHandBackStructure(deps);
  const allSlots = deps.slots();
  const slots = allSlots.filter((slot) => slot.source !== 'qlb-add' && !slot.dead);
  const activeAccountId = deps.activeAccountId();
  const active = activeAccountId === null ? null : allSlots.find((slot) => slot.accountId === activeAccountId);
  const listCredentials = deps.listCredentials ?? readdirSync;
  const plans: HandBackSlotPlan[] = [];
  const deleteEnc: string[] = [];
  for (const slot of [...slots].sort((left, right) => (left.slotNum ?? Number.MAX_SAFE_INTEGER) - (right.slotNum ?? Number.MAX_SAFE_INTEGER))) {
    const { accountNumber, email } = requireSlotCoordinate(slot);
    const item = `account-${accountNumber}-${email}`;
    const currentCredential = await sourceCredential(deps, slot.accountId);
    const currentLineage = credentialLineage(currentCredential, accountNumber);
    const destination = await optionalCswapCredential(deps.keychain, item);
    // A corrupt fallback must not prevent recovery: the current credential
    // replaces it and the readable bytes are retained as .prev by writeSlot.
    let destinationState: HandBackDestinationState = 'missing';
    if (destination !== null) {
      destinationState = parseCredentialBlob(destination) === null
        ? 'malformed'
        : credentialLineage(destination, accountNumber) === currentLineage ? 'match' : 'rotated';
    }
    const action: HandBackAction = destinationState === 'match' ? 'noop' : 'update';
    plans.push({
      accountId: slot.accountId,
      accountNumber,
      email,
      item,
      action,
      destinationState,
      fingerprint: fingerprintPrefix(currentLineage),
    });
    deleteEnc.push(...encryptedCredentials(listCredentials, deps.backupDir, accountNumber));
  }

  return {
    slots: plans,
    deleteEnc,
    activeAccountNumber: active == null ? null : requireSlotCoordinate(active).accountNumber,
  };
}

export interface HandBackDrainState {
  pids: number[];
  locks: string[];
}

export interface ExecuteHandBackDependencies extends PlanHandBackDependencies {
  /** Test/composition seam; production leaves this unset and always plans fresh. */
  plan?: () => Promise<HandBackPlan>;
  transitionUndoing: () => boolean | Promise<boolean>;
  bootoutQlbAgent: () => { ok: boolean; code?: string } | Promise<{ ok: boolean; code?: string }>;
  drainState: () => HandBackDrainState | Promise<HandBackDrainState>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pendingStash: () => string | null | Promise<string | null>;
  keychain: Pick<ClaudeSlotBackend, 'get' | 'set'>;
  deleteEnc: (path: string) => void | Promise<void>;
  withUndoCapability: <T>(fn: () => Promise<T>) => Promise<T> | T;
  withActiveLocks: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Reads the live login while the active switch + credential locks are held. */
  readActiveCredential?: () => Promise<{ credential: string; accountId: string | null }>;
  /** Re-syncs the active slot after a verified, locked live read. */
  resyncActive?: (accountId: string, credential: string) => Promise<void>;
  /** C-swap 0.26.0 precedence reader (valid .enc first, then Keychain). */
  readBack?: (slot: HandBackSlotPlan) => Promise<string | null>;
  /** Refuses a missing or malformed C-swap sequence before any hand-back write. */
  validateActiveSequence?: (accountNumber: number | null) => Promise<void>;
  /** Validates and atomically advances C-swap's activeAccountNumber. */
  setActiveAccountNumber?: (accountNumber: number | null) => Promise<void>;
}

export interface HandBackResult {
  plan: HandBackPlan;
  skipped: number;
}

async function writeSlot(deps: ExecuteHandBackDependencies, slot: HandBackSlotPlan): Promise<boolean> {
  const current = await sourceCredential(deps, slot.accountId);
  const destination = await optionalCswapCredential(deps.keychain, slot.item);
  let sameLineage = false;
  if (destination !== null) {
    try { sameLineage = credentialLineage(destination, slot.accountNumber) === credentialLineage(current, slot.accountNumber); } catch { /* replace malformed destination */ }
  }
  if (sameLineage) return false;
  if (destination !== null) await deps.keychain.set('claude-swap', `${slot.item}.prev`, destination);
  await deps.keychain.set('claude-swap', slot.item, current);
  return true;
}

async function verifyPlan(deps: ExecuteHandBackDependencies, plan: HandBackPlan): Promise<void> {
  for (const slot of plan.slots) {
    const expected = await sourceCredential(deps, slot.accountId);
    const actual = deps.readBack
      ? await deps.readBack(slot)
      : await optionalCswapCredential(deps.keychain, slot.item);
    if (actual === null || credentialLineage(actual, slot.accountNumber) !== credentialLineage(expected, slot.accountNumber)) {
      throw new CswapUndoVerificationError(slot.accountNumber);
    }
  }
}

async function waitForDrain(deps: ExecuteHandBackDependencies): Promise<void> {
  const deadline = deps.now() + 60_000;
  for (;;) {
    const state = await deps.drainState();
    if (state.pids.length === 0 && state.locks.length === 0) return;
    if (deps.now() >= deadline) throw new CswapUndoDrainError(state.pids, state.locks);
    await deps.sleep(1_000);
  }
}

/**
 * G17's ordered, resumable write half. It deliberately does not restart
 * C-swap or complete the lifecycle transition; G18 owns those effects.
 */
export async function executeHandBack(deps: ExecuteHandBackDependencies, resume = false): Promise<HandBackResult> {
  // Structural refusals are evaluated before fencing so ordinary recovery work
  // remains possible. The fresh plan below is still authoritative for writes.
  if (!resume) {
    validateHandBackStructure(deps);
    const active = deps.activeAccountId();
    if (active !== null) {
      const slot = deps.slots().find((candidate) => candidate.accountId === active);
      if (slot) await deps.validateActiveSequence?.(requireSlotCoordinate(slot).accountNumber);
    }
  }
  if (!resume && !await deps.transitionUndoing()) throw new Error('undo lifecycle fence refused');
  const stopped = await deps.bootoutQlbAgent();
  if (!stopped.ok) throw new Error(`QLB agent bootout failed${stopped.code ? `: ${stopped.code}` : ''}`);
  await waitForDrain(deps);
  // Resume repeats these checks only after the agent is stopped and the drain
  // has cleared; the plan always obtains fresh readonly state.
  const plan = await (deps.plan ?? (() => planHandBack(deps)))();
  await deps.validateActiveSequence?.(plan.activeAccountNumber);
  const stash = await deps.pendingStash();
  if (stash !== null) throw new CswapUndoPendingStashError(stash);
  let skipped = 0;
  const encFor = (slot: HandBackSlotPlan): string[] => plan.deleteEnc.filter((path) =>
    basename(path).startsWith(`.creds-${slot.accountNumber}-`));
  const inactive = plan.slots.filter((slot) => slot.accountNumber !== plan.activeAccountNumber);
  await deps.withUndoCapability(async () => {
    for (const slot of inactive) {
      if (!await writeSlot(deps, slot)) skipped += 1;
      for (const path of encFor(slot)) await deps.deleteEnc(path);
    }
  });

  const active = plan.slots.find((slot) => slot.accountNumber === plan.activeAccountNumber);
  if (active) {
    await deps.withActiveLocks(async () => deps.withUndoCapability(async () => {
      const live = await deps.readActiveCredential?.();
      if (live && live.accountId !== active.accountId) throw new Error('active Claude identity mismatch');
      // Attribute any locked live rotation before exporting. If it cannot be
      // attributed, resyncActive fails closed rather than handing back a spent slot.
      if (live) await deps.resyncActive?.(active.accountId, live.credential);
      if (!await writeSlot(deps, active)) skipped += 1;
      for (const path of encFor(active)) await deps.deleteEnc(path);
      await deps.setActiveAccountNumber?.(plan.activeAccountNumber);
    }));
  } else if (plan.activeAccountNumber !== null) {
    // A dead active slot has no export row, but C-swap must still receive its
    // authoritative active account number before the healthy-slot verification.
    await deps.setActiveAccountNumber?.(plan.activeAccountNumber);
  }
  await verifyPlan(deps, plan);
  return { plan, skipped };
}
