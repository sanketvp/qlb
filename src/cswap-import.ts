/*
 * Ported in concept from claude-swap 0.28.0's backup reader.
 * Upstream file(s): src/claude_swap/credentials.py:1075-1367, switcher.py:896-917.
 * License: MIT. Modified for QLB. See NOTICE.
 */

// K10: staging-only C-swap import. Source credentials are never returned in a
// plan/result and journal records contain fingerprints and service names only.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { credentialFingerprint, parseCredentialBlob } from './anthropic-oauth';
import type { ClaudeSlot, ClaudeSlotBackend, ClaudeSlotRepository } from './cc-slots';
import { CswapImportInProgress, withCswapImportLock } from './cc-locks';
import { looksLikeApiKey } from './cc-credentials';
import { isCredentialNotFound } from './credential-backends';
import { QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from './keychain';

const PROVIDER = 'anthropic';

export type CswapCredentialBackend = 'enc' | 'keychain';
export type CswapImportRefusalCode =
  | 'destination-non-empty'
  | 'destination-lineage-unrelated'
  | 'import-in-progress'
  | 'live-active-identity-mismatch'
  | 'live-identity-unresolvable'
  | 'live-changed'
  | 'api-key-source'
  | 'session-profiles';

/** A credential-free, operator-actionable refusal (command exit 3). */
export class CswapImportRefusalError extends Error {
  constructor(readonly code: CswapImportRefusalCode, message: string) {
    super(message);
    this.name = 'CswapImportRefusalError';
  }
}

/** Test seam: models a process dying after a durable Keychain write. */
export class CswapImportInjectedCrash extends Error {
  constructor() {
    super('injected C-swap import crash');
    this.name = 'CswapImportInjectedCrash';
  }
}

/** The SQLite import_runs authority could not be read; leave effects for S62 recovery. */
export class CswapImportCommitUnknown extends Error {
  constructor(readonly journalPath: string) {
    super(`C-swap import commit state is unknown; recovery required: ${journalPath}`);
    this.name = 'CswapImportCommitUnknown';
  }
}

export interface CswapImportSlotPlan {
  slotNum: number;
  email: string;
  accountId: string;
  alias: string | null;
  orgUuid: string | null;
  threshold: number | null;
  fingerprint: string;
  previousFingerprint: string | null;
  backend: CswapCredentialBackend;
  encPresent: boolean;
  active: boolean;
}

export interface CswapImportPlan {
  slots: CswapImportSlotPlan[];
  keychainItems: number;
  apiKeySlots: number;
  sessionProfiles: number;
  encFiles: number;
  activeAccountId: string | null;
  destination: 'empty' | 'replace-required';
}

export interface CswapImportOptions {
  /** The fixture or configured C-swap backup root; never defaults to a real home here. */
  backupDir: string;
  /** QLB-owned journal root. This is required so an import never writes the source tree. */
  journalDir?: string;
  keychain: ClaudeSlotBackend;
  repository: ClaudeSlotRepository;
  /** Read only; supplied by the command for the live Claude Code item. */
  liveCredential?: () => Promise<string>;
  /** Identity comes from Claude's global config oauthAccount, never the credential blob. */
  liveAccountId?: () => Promise<string | null>;
  /** Production reads the credential and config identity while holding Claude's switch locks. */
  liveSnapshot?: () => Promise<{ credential: string; accountId: string | null }>;
  /** Holds Claude's credential then config locks around an individual live-state transaction. */
  withLiveStateLocks?: <T>(fn: () => Promise<T> | T) => Promise<T>;
  /** Test seam after the first live snapshot and before the required pre-commit re-read. */
  afterLiveSnapshot?: () => Promise<void> | void;
  /** Test seam after the final locked re-check and before the SQLite commit. */
  afterLiveRecheck?: () => Promise<void> | void;
  /** Test seam called only after recovery has acquired the shared import lock. */
  beforeRecovery?: () => Promise<void> | void;
  now?: () => number;
  runId?: string;
  replace?: boolean;
  /** S46 proof injected by the Store-bound lineage service. */
  isSuccessor?: (accountId: string, ancestor: string, descendant: string) => boolean;
  /** Test-only crash point, called after each final Keychain write. */
  afterPromotionWrite?: (point: 'destination-written' | 'previous-written', accountId: string) => void;
  files?: CswapImportFileOps;
}

export interface CswapImportFileOps {
  exists(path: string): boolean;
  readText(path: string): string;
  readdir(path: string): string[];
  mkdir(path: string): void;
  writeText(path: string, text: string): void;
}

const files: CswapImportFileOps = {
  exists: existsSync,
  readText: (path) => readFileSync(path, 'utf8'),
  readdir: readdirSync,
  mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
  writeText: (path, text) => writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 }),
};

interface SourceSlot extends CswapImportSlotPlan {
  configJson: string;
  credential: string;
  previousCredential: string | null;
  /** Inventory count only; never returned with a credential value. */
  keychainItems: number;
}

type ReachedPhase = 'unreached' | 'destination' | 'previous';

/**
 * Deliberately credential-free S62 recovery record. Every preimage has its own
 * QLB-owned backup service; the journal can therefore restore both final keys.
 */
interface JournalSlot {
  accountId: string;
  staging: string;
  destination: string;
  importPrevious: string;
  importPreviousPrevious: string;
  fingerprint: string;
  previousFingerprint: string | null;
  promotedFingerprint: string | null;
  destinationExisted: boolean | null;
  priorDestinationFingerprint: string | null;
  priorDestinationLineage: string | null;
  previousDestinationExisted: boolean | null;
  priorPreviousFingerprint: string | null;
  prevSaved: boolean;
  previousSaved: boolean;
  reached: ReachedPhase;
  /** Written before cleanup so a crash after a partial cleanup does not re-restore it. */
  restored: boolean;
}

interface Journal {
  runId: string;
  phase: 'staged' | 'promoting' | 'committed' | 'commit-unknown' | 'cleaned' | 'aborted';
  startedAt: number;
  slots: JournalSlot[];
}

interface PromotionEffect {
  entry: JournalSlot;
  prior: string | null;
  priorPrevious: string | null;
}

function safeSegment(value: string, label: string): string {
  if (!value || /[\\/\0:]/.test(value)) throw new Error(`invalid C-swap ${label}`);
  return value;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function string(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value) throw new Error(message);
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A C-swap source is accepted only as a real Claude Code OAuth document. */
function oauthFingerprint(credential: string, slotNum: number): string {
  const oauth = parseCredentialBlob(credential)?.oauth;
  if (!oauth || typeof oauth.refreshToken !== 'string' || !oauth.refreshToken) {
    throw new Error(`C-swap OAuth credential is invalid for slot ${slotNum}`);
  }
  // refreshToken was checked above, so this cannot be the sha256-full fallback.
  return credentialFingerprint(credential)!;
}

function configAccountId(config: string): string {
  const root = object(JSON.parse(config), 'C-swap config is malformed');
  const oauth = object(root.oauthAccount, 'C-swap config has no oauthAccount');
  return string(oauth.accountUuid ?? oauth.account_id, 'C-swap config has no account identity');
}

function base64Credential(text: string): string | null {
  const encoded = text.trim();
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return decoded || null;
  } catch {
    return null;
  }
}

function service(runId: string, accountId: string, kind: 'staging' | 'import-prev' | 'import-prev-prev'): string {
  return qlbKeychainService(PROVIDER, `${kind}:${safeSegment(runId, 'run id')}:${safeSegment(accountId, 'account identity')}`);
}

function destination(accountId: string): string {
  return qlbKeychainService(PROVIDER, safeSegment(accountId, 'account identity'));
}

function previousDestination(accountId: string): string {
  return qlbKeychainService(PROVIDER, `${safeSegment(accountId, 'account identity')}:prev`);
}

async function optionalGet(keychain: ClaudeSlotBackend, target: string, account = QLB_KEYCHAIN_ACCOUNT): Promise<string | null> {
  try { return await keychain.get(target, account); } catch (error) {
    if (isCredentialNotFound(error)) return null;
    throw error;
  }
}

/** A valid .enc wins even while its stale Keychain fallback is unreadable. */
async function probeCswapItem(keychain: ClaudeSlotBackend, account: string): Promise<string | null> {
  return optionalGet(keychain, 'claude-swap', account);
}

function countSessions(root: string, io: CswapImportFileOps): number {
  const dir = join(root, 'sessions');
  if (!io.exists(dir)) return 0;
  return io.readdir(dir).length;
}

async function readSourceSlots(options: CswapImportOptions): Promise<{ slots: SourceSlot[]; sessionProfiles: number }> {
  const io = options.files ?? files;
  const sequencePath = join(options.backupDir, 'sequence.json');
  let sequence: Record<string, unknown>;
  try { sequence = object(JSON.parse(io.readText(sequencePath)), 'C-swap sequence is malformed'); } catch (error) {
    if (error instanceof Error && error.message.startsWith('C-swap')) throw error;
    throw new Error('C-swap sequence is unreadable');
  }
  const accounts = object(sequence.accounts, 'C-swap sequence has no accounts');
  const activeNumber = sequence.activeAccountNumber == null ? null : String(sequence.activeAccountNumber);
  const slots: SourceSlot[] = [];
  const identities = new Set<string>();
  for (const [number, rawRecord] of Object.entries(accounts)) {
    const record = object(rawRecord, 'C-swap account record is malformed');
    const slotNum = Number(number);
    if (!Number.isSafeInteger(slotNum) || slotNum < 1) throw new Error('C-swap account number is invalid');
    const email = safeSegment(string(record.email, 'C-swap account has no email'), 'email');
    const configPath = join(options.backupDir, 'configs', `.claude-config-${number}-${email}.json`);
    let configJson: string;
    try { configJson = io.readText(configPath); } catch { throw new Error(`C-swap config is unreadable for slot ${number}`); }
    const accountId = safeSegment(configAccountId(configJson), 'account identity');
    if (identities.has(accountId)) throw new Error(`C-swap duplicate account identity for slot ${number}`);
    identities.add(accountId);
    const encPath = join(options.backupDir, 'credentials', `.creds-${number}-${email}.enc`);
    const encPresent = io.exists(encPath);
    let credential: string | null = null;
    if (encPresent) {
      try { credential = base64Credential(io.readText(encPath)); } catch { /* corrupt/unreadable .enc falls through */ }
    }
    const keychainCurrent = await probeCswapItem(options.keychain, `account-${number}-${email}`);
    let backend: CswapCredentialBackend = 'enc';
    if (credential == null) {
      backend = 'keychain';
      if (keychainCurrent == null) throw new Error(`C-swap credential is unavailable for slot ${number}`);
      credential = keychainCurrent;
    }
    if (looksLikeApiKey(credential)) {
      throw new CswapImportRefusalError('api-key-source', `C-swap API-key slot refused: ${number}`);
    }
    const fingerprint = oauthFingerprint(credential, slotNum);
    let previousFromEnc: string | null = null;
    if (io.exists(`${encPath}.prev`)) {
      try { previousFromEnc = base64Credential(io.readText(`${encPath}.prev`)); } catch { /* Keychain prev remains a fallback */ }
    }
    const keychainPrevious = await probeCswapItem(options.keychain, `account-${number}-${email}.prev`);
    const previousText = previousFromEnc ?? keychainPrevious;
    const previousFingerprint = previousText ? oauthFingerprint(previousText, slotNum) : null;
    slots.push({
      slotNum, email, accountId, alias: nullableString(record.alias),
      orgUuid: nullableString(record.organizationUuid) ?? nullableString(record.orgUuid),
      threshold: nullableNumber(record.threshold), configJson, fingerprint,
      previousFingerprint, backend, encPresent, active: activeNumber === number,
      credential, previousCredential: previousText,
      keychainItems: Number(keychainCurrent !== null) + Number(keychainPrevious !== null),
    });
  }
  slots.sort((left, right) => left.slotNum - right.slotNum);
  if (slots.length === 0) throw new Error('C-swap sequence has no accounts');
  if (activeNumber !== null && !slots.some((slot) => slot.active)) throw new Error('C-swap active slot is missing');
  return { slots, sessionProfiles: countSessions(options.backupDir, io) };
}

function importedSettings(options: CswapImportOptions): Record<string, string> {
  const io = options.files ?? files;
  const path = join(options.backupDir, 'settings.json');
  if (!io.exists(path)) return {};
  try {
    const settings = object(JSON.parse(io.readText(path)), 'settings');
    const source = object(settings.autoswitch ?? settings, 'settings');
    const out: Record<string, string> = {};
    for (const [from, to] of [
      ['threshold', 'autoswitch.threshold'], ['weeklyThreshold', 'autoswitch.weeklyThreshold'],
      ['intervalSeconds', 'autoswitch.intervalSeconds'], ['cooldownSeconds', 'autoswitch.cooldownSeconds'],
      ['hysteresisPct', 'autoswitch.hysteresisPct'], ['unhealthyTicks', 'autoswitch.unhealthyTicks'],
      ['strategy', 'autoswitch.strategy'],
    ]) {
      const value = source[from];
      if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) out[to] = String(value);
    }
    return out;
  } catch {
    return {};
  }
}

function importedSnapshots(options: CswapImportOptions, slots: SourceSlot[]): Array<{ accountId: string; bucket: string; usedPct: number; fetchedAt: number }> {
  const io = options.files ?? files;
  const path = join(options.backupDir, 'cache', 'usage.json');
  if (!io.exists(path)) return [];
  try {
    const root = object(JSON.parse(io.readText(path)), 'usage');
    const accounts = object(root.accounts, 'usage');
    const result: Array<{ accountId: string; bucket: string; usedPct: number; fetchedAt: number }> = [];
    for (const slot of slots) {
      const row = accounts[String(slot.slotNum)];
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      const lastGood = record.lastGood;
      if (!lastGood || typeof lastGood !== 'object' || Array.isArray(lastGood)) continue;
      const fetched = nullableNumber(record.fetchedAt);
      if (fetched == null) continue;
      for (const [field, bucket] of [['fiveHour', 'five_hour'], ['five_hour', 'five_hour'], ['sevenDay', 'seven_day'], ['seven_day', 'seven_day']] as const) {
        const reading = (lastGood as Record<string, unknown>)[field];
        const value = reading && typeof reading === 'object' && !Array.isArray(reading)
          ? nullableNumber((reading as Record<string, unknown>).pct ?? (reading as Record<string, unknown>).utilization ?? (reading as Record<string, unknown>).usedPct)
          : nullableNumber(reading);
        if (value == null || value < 0 || value > 100 || result.some((item) => item.accountId === slot.accountId && item.bucket === bucket)) continue;
        result.push({ accountId: slot.accountId, bucket, usedPct: value, fetchedAt: fetched < 100_000_000_000 ? fetched * 1000 : fetched });
      }
    }
    return result;
  } catch { return []; }
}

function planFrom(slots: SourceSlot[], sessionProfiles: number, replaceRequired: boolean): CswapImportPlan {
  return {
    slots: slots.map(({ slotNum, email, accountId, alias, orgUuid, threshold, fingerprint, previousFingerprint, backend, encPresent, active }) =>
      ({ slotNum, email, accountId, alias, orgUuid, threshold, fingerprint, previousFingerprint, backend, encPresent, active })),
    keychainItems: slots.reduce((count, slot) => count + slot.keychainItems, 0),
    apiKeySlots: 0, sessionProfiles, encFiles: slots.filter((slot) => slot.encPresent).length,
    activeAccountId: slots.find((slot) => slot.active)?.accountId ?? null,
    destination: replaceRequired ? 'replace-required' : 'empty',
  };
}

/** Read-only inventory. It deliberately never probes the live Claude credential. */
export async function planCswapImport(options: CswapImportOptions): Promise<CswapImportPlan> {
  const { slots, sessionProfiles } = await readSourceSlots(options);
  const replaceRequired = options.repository.listSlots().length > 0 || await Promise.all(slots.map(async (slot) => {
    const [current, previous] = await Promise.all([
      optionalGet(options.keychain, destination(slot.accountId)),
      optionalGet(options.keychain, previousDestination(slot.accountId)),
    ]);
    return current !== null || previous !== null;
  })).then((items) => items.some(Boolean));
  return planFrom(slots, sessionProfiles, replaceRequired);
}

function admittedReplace(existing: ClaudeSlot, source: SourceSlot, successor: CswapImportOptions['isSuccessor']): boolean {
  if (existing.fingerprint === source.fingerprint) return true;
  if (source.previousFingerprint === existing.fingerprint) return true;
  return Boolean(existing.fingerprint && successor?.(source.accountId, existing.fingerprint, source.fingerprint));
}

async function assertDestination(options: CswapImportOptions, slots: SourceSlot[]): Promise<void> {
  const existingSlots = options.repository.listSlots();
  const sourceIds = new Set(slots.map((slot) => slot.accountId));
  const unrelated = existingSlots.find((slot) => !sourceIds.has(slot.accountId));
  if (unrelated) throw new CswapImportRefusalError('destination-non-empty', `C-swap import refused: destination has unrelated slot ${unrelated.accountId}`);
  for (const source of slots) {
    const dbSlot = options.repository.getSlot(source.accountId);
    const [item, previous] = await Promise.all([
      optionalGet(options.keychain, destination(source.accountId)),
      optionalGet(options.keychain, previousDestination(source.accountId)),
    ]);
    if (!dbSlot && !item && !previous) continue;
    if (!options.replace) throw new CswapImportRefusalError('destination-non-empty', `C-swap import refused: destination is non-empty for slot ${source.slotNum}`);
    if (!dbSlot || !item || !admittedReplace(dbSlot, source, options.isSuccessor)) {
      throw new CswapImportRefusalError('destination-lineage-unrelated', `C-swap import refused: destination lineage is unrelated for slot ${source.slotNum}`);
    }
    // The actual bytes must agree with the metadata used for S46 admission.
    if (credentialFingerprint(item) !== dbSlot.fingerprint) {
      throw new CswapImportRefusalError('destination-lineage-unrelated', `C-swap import refused: destination lineage is unrelated for slot ${source.slotNum}`);
    }
  }
}

function journalRoot(options: CswapImportOptions): string {
  if (!options.journalDir) throw new Error('C-swap import requires a QLB journal directory');
  return options.journalDir;
}

function journalPath(options: CswapImportOptions, runId: string): string {
  return join(journalRoot(options), `cswap-import-${safeSegment(runId, 'run id')}`, 'journal.json');
}

function writeJournal(options: CswapImportOptions, journal: Journal): void {
  const io = options.files ?? files;
  const path = journalPath(options, journal.runId);
  io.mkdir(dirname(path));
  io.writeText(path, JSON.stringify(journal));
}

async function deleteIfPresent(keychain: ClaudeSlotBackend, target: string): Promise<void> {
  try { await keychain.delete(target, QLB_KEYCHAIN_ACCOUNT); } catch (error) { if (!isCredentialNotFound(error)) throw error; }
}

async function cleanup(keychain: ClaudeSlotBackend, journal: Journal, restoredOnly = false): Promise<void> {
  for (const entry of journal.slots) {
    await deleteIfPresent(keychain, entry.staging);
    // Recovery preimages are deleted only after their corresponding restore is
    // durably recorded. A failed restore retains every preimage for S62.
    if (!restoredOnly || entry.restored) {
      await deleteIfPresent(keychain, entry.importPrevious);
      await deleteIfPresent(keychain, entry.importPreviousPrevious);
    }
  }
}

function readJournal(options: CswapImportOptions, runId: string): Journal {
  const io = options.files ?? files;
  try {
    const parsed = JSON.parse(io.readText(journalPath(options, runId))) as Partial<Journal>;
    if (!parsed || typeof parsed !== 'object' || parsed.runId !== runId || !Array.isArray(parsed.slots)) throw new Error('invalid');
    return parsed as Journal;
  } catch {
    throw new Error('C-swap import journal is unreadable');
  }
}

async function rollbackEffects(
  keychain: ClaudeSlotBackend,
  effects: PromotionEffect[],
  onRestored: (entry: JournalSlot) => void,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const effect of [...effects].reverse()) {
    let restored = true;
    try {
      if (effect.prior == null) await deleteIfPresent(keychain, effect.entry.destination);
      else await keychain.set(effect.entry.destination, QLB_KEYCHAIN_ACCOUNT, effect.prior);
    } catch (error) { failures.push(error); restored = false; }
    try {
      const previous = previousDestination(effect.entry.accountId);
      if (effect.priorPrevious == null) await deleteIfPresent(keychain, previous);
      else await keychain.set(previous, QLB_KEYCHAIN_ACCOUNT, effect.priorPrevious);
    } catch (error) { failures.push(error); restored = false; }
    if (restored) {
      effect.entry.restored = true;
      onRestored(effect.entry);
    }
  }
  return failures;
}

type LiveSnapshot = { credential: string; accountId: string | null };

async function withLiveStateLocks<T>(options: CswapImportOptions, fn: () => Promise<T> | T): Promise<T> {
  return options.withLiveStateLocks ? options.withLiveStateLocks(fn) : fn();
}

async function readLiveSnapshot(options: CswapImportOptions): Promise<LiveSnapshot> {
  if (options.liveSnapshot) return options.liveSnapshot();
  if (!options.liveCredential || !options.liveAccountId) {
    throw new CswapImportRefusalError('live-identity-unresolvable', 'C-swap import refused: live active identity is unresolvable');
  }
  const [credential, accountId] = await Promise.all([options.liveCredential(), options.liveAccountId()]);
  return { credential, accountId };
}

async function liveEffectiveCredentials(options: CswapImportOptions, sourceSlots: SourceSlot[]): Promise<{
  effective: Array<SourceSlot & { effectiveCredential: string; effectivePrevious: string | null; effectiveFrom: string | null }>;
  snapshot: LiveSnapshot | null;
}> {
  const effective = sourceSlots.map((slot) => ({ ...slot, effectiveCredential: slot.credential, effectivePrevious: slot.previousCredential, effectiveFrom: null as string | null }));
  const activeIndex = effective.findIndex((slot) => slot.active);
  if (activeIndex < 0 || (!options.liveCredential && !options.liveSnapshot)) return { effective, snapshot: null };
  const snapshot = await readLiveSnapshot(options);
  if (!snapshot.accountId) throw new CswapImportRefusalError('live-identity-unresolvable', 'C-swap import refused: live active identity is unresolvable');
  if (snapshot.accountId !== effective[activeIndex].accountId) {
    throw new CswapImportRefusalError('live-active-identity-mismatch', 'C-swap import refused: live active identity mismatch');
  }
  const liveFingerprint = oauthFingerprint(snapshot.credential, effective[activeIndex].slotNum);
  if (snapshot.credential !== effective[activeIndex].credential) {
    effective[activeIndex].effectiveCredential = snapshot.credential;
    // A same-lineage live refresh updates access data, not the source's prior lineage.
    effective[activeIndex].effectivePrevious = liveFingerprint === effective[activeIndex].fingerprint
      ? effective[activeIndex].previousCredential : effective[activeIndex].credential;
    effective[activeIndex].effectiveFrom = liveFingerprint === effective[activeIndex].fingerprint ? null : effective[activeIndex].fingerprint;
  }
  return { effective, snapshot };
}

/** Executes §4.9 staging/promotion. K14 consumes this credential-free S62 journal. */
export async function importCswap(options: CswapImportOptions): Promise<{ runId: string; phase: 'cleaned'; plan: CswapImportPlan }> {
  const lock = join(journalRoot(options), 'cswap-import.lock');
  try {
    return await withCswapImportLock(lock, () => importCswapLocked(options));
  } catch (error) {
    if (error instanceof CswapImportInProgress) {
      throw new CswapImportRefusalError('import-in-progress', 'C-swap import refused: import already in progress');
    }
    throw error;
  }
}

async function importCswapLocked(options: CswapImportOptions): Promise<{ runId: string; phase: 'cleaned'; plan: CswapImportPlan }> {
  const { slots: sourceSlots, sessionProfiles } = await readSourceSlots(options);
  if (sessionProfiles > 0) throw new CswapImportRefusalError('session-profiles', `C-swap import refused: ${sessionProfiles} session profiles present`);
  await assertDestination(options, sourceSlots);
  const plan = planFrom(sourceSlots, sessionProfiles, options.repository.listSlots().length > 0);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const runId = options.runId ?? `${startedAt}-${randomUUID()}`;
  const journal: Journal = {
    runId, phase: 'staged', startedAt,
    slots: sourceSlots.map((slot) => ({
      accountId: slot.accountId, staging: service(runId, slot.accountId, 'staging'),
      destination: destination(slot.accountId), importPrevious: service(runId, slot.accountId, 'import-prev'),
      importPreviousPrevious: service(runId, slot.accountId, 'import-prev-prev'),
      fingerprint: slot.fingerprint, previousFingerprint: slot.previousFingerprint, promotedFingerprint: null,
      destinationExisted: null, priorDestinationFingerprint: null, priorDestinationLineage: null,
      previousDestinationExisted: null, priorPreviousFingerprint: null,
      prevSaved: false, previousSaved: false, reached: 'unreached', restored: false,
    })),
  };
  writeJournal(options, journal);
  const effects: PromotionEffect[] = [];
  try {
    for (let index = 0; index < sourceSlots.length; index += 1) {
      const source = sourceSlots[index];
      await options.keychain.set(journal.slots[index].staging, QLB_KEYCHAIN_ACCOUNT, source.credential);
      const actual = await options.keychain.get(journal.slots[index].staging, QLB_KEYCHAIN_ACCOUNT);
      if (oauthFingerprint(actual, source.slotNum) !== source.fingerprint) throw new Error(`C-swap import verification failed for slot ${source.slotNum}`);
    }

    const { effective, snapshot: firstLiveSnapshot } = await withLiveStateLocks(options, () =>
      liveEffectiveCredentials(options, sourceSlots));
    journal.phase = 'promoting';
    for (let index = 0; index < effective.length; index += 1) {
      journal.slots[index].promotedFingerprint = oauthFingerprint(effective[index].effectiveCredential, effective[index].slotNum);
    }
    writeJournal(options, journal);

    for (let index = 0; index < effective.length; index += 1) {
      const slot = effective[index];
      const entry = journal.slots[index];
      const previousTarget = previousDestination(slot.accountId);
      const [prior, priorPrevious] = await Promise.all([
        optionalGet(options.keychain, entry.destination),
        optionalGet(options.keychain, previousTarget),
      ]);
      // Register every preimage before the first write, including a write of a
      // backup service. A failure at either final service can now be undone.
      effects.push({ entry, prior, priorPrevious });
      const dbSlot = options.repository.getSlot(slot.accountId);
      entry.destinationExisted = prior !== null;
      entry.priorDestinationFingerprint = prior ? credentialFingerprint(prior) : null;
      entry.priorDestinationLineage = dbSlot?.prevFingerprint ?? null;
      entry.previousDestinationExisted = priorPrevious !== null;
      entry.priorPreviousFingerprint = priorPrevious ? credentialFingerprint(priorPrevious) : null;
      writeJournal(options, journal);
      if (prior != null) {
        await options.keychain.set(entry.importPrevious, QLB_KEYCHAIN_ACCOUNT, prior);
        entry.prevSaved = true;
        writeJournal(options, journal);
      }
      if (priorPrevious != null) {
        await options.keychain.set(entry.importPreviousPrevious, QLB_KEYCHAIN_ACCOUNT, priorPrevious);
        entry.previousSaved = true;
        writeJournal(options, journal);
      }
      // Persist the recovery intent before each non-idempotent final write. If
      // a process dies between this journal write and the Keychain call, restore
      // is still safe because the durable preimage represents the same bytes.
      entry.reached = 'destination';
      writeJournal(options, journal);
      await options.keychain.set(entry.destination, QLB_KEYCHAIN_ACCOUNT, slot.effectiveCredential);
      options.afterPromotionWrite?.('destination-written', slot.accountId);
      if (slot.effectivePrevious) {
        entry.reached = 'previous';
        writeJournal(options, journal);
        await options.keychain.set(previousTarget, QLB_KEYCHAIN_ACCOUNT, slot.effectivePrevious);
        options.afterPromotionWrite?.('previous-written', slot.accountId);
      }
    }
    for (let index = 0; index < effective.length; index += 1) {
      const actual = await options.keychain.get(journal.slots[index].destination, QLB_KEYCHAIN_ACCOUNT);
      if (oauthFingerprint(actual, effective[index].slotNum) !== journal.slots[index].promotedFingerprint) {
        throw new Error(`C-swap import final verification failed for slot ${effective[index].slotNum}`);
      }
    }

    // The final live read and SQLite authority commit share one lock hold. A
    // native Claude switch therefore cannot interleave after the comparison.
    if (firstLiveSnapshot) await options.afterLiveSnapshot?.();
    let committedAt = 0;
    await withLiveStateLocks(options, async () => {
      if (firstLiveSnapshot) {
        const secondLiveSnapshot = await readLiveSnapshot(options);
        if (secondLiveSnapshot.credential !== firstLiveSnapshot.credential || secondLiveSnapshot.accountId !== firstLiveSnapshot.accountId) {
          throw new CswapImportRefusalError('live-changed', 'C-swap import refused: live state changed during import');
        }
      }
      await options.afterLiveRecheck?.();
      committedAt = now();
      options.repository.commitCswapImport({
        runId, startedAt, committedAt,
        slots: effective.map((source) => ({
          slot: {
            accountId: source.accountId, slotNum: source.slotNum, email: source.email, alias: source.alias,
            orgUuid: source.orgUuid, configJson: source.configJson, fingerprint: credentialFingerprint(source.effectiveCredential),
            prevFingerprint: source.effectivePrevious ? credentialFingerprint(source.effectivePrevious) : source.previousFingerprint,
            threshold: source.threshold, dead: false, addedAt: committedAt, lastActiveAt: source.active ? committedAt : null,
            source: 'cswap-import', archivedAt: null,
          }, lineageFrom: source.effectiveFrom,
        })),
        activeAccountId: effective.find((slot) => slot.active)?.accountId ?? null,
        snapshots: importedSnapshots(options, sourceSlots), config: importedSettings(options),
      });
    });
    journal.phase = 'committed';
    writeJournal(options, journal);
    await cleanup(options.keychain, journal);
    journal.phase = 'cleaned';
    writeJournal(options, journal);
    return { runId, phase: 'cleaned', plan };
  } catch (error) {
    // An injected crash deliberately bypasses compensation so S62 recovery is
    // exercised against exactly the durable state a killed process leaves.
    if (error instanceof CswapImportInjectedCrash) throw error;
    let committed: boolean;
    try {
      committed = options.repository.getImportRun(runId)?.committedAt != null;
    } catch {
      // The import_runs row is S62's authority. Unknown is never evidence that
      // compensation is safe: retain all effects and let recovery decide later.
      journal.phase = 'commit-unknown';
      try { writeJournal(options, journal); } catch { /* preserve the authority failure */ }
      throw new CswapImportCommitUnknown(journalPath(options, runId));
    }
    if (committed) {
      journal.phase = 'committed';
      try { writeJournal(options, journal); } catch { /* original failure remains authoritative */ }
      throw error;
    }
    const restoreFailures = await rollbackEffects(options.keychain, effects, () => writeJournal(options, journal));
    if (restoreFailures.length > 0) {
      // Keep all preimages: one failed restore means recovery still needs a
      // coherent set of backups, including entries restored before the failure.
      try { writeJournal(options, journal); } catch { /* preserve original error */ }
      throw new Error(`C-swap import recovery required: ${journalPath(options, runId)}`);
    }
    let cleanupFailure: unknown | null = null;
    try { await cleanup(options.keychain, journal, true); } catch (failure) { cleanupFailure = failure; }
    if (cleanupFailure) {
      // restored is journaled before cleanup, making a partial cleanup idempotent.
      try { writeJournal(options, journal); } catch { /* preserve original error */ }
      throw new Error(`C-swap import recovery required: ${journalPath(options, runId)}`);
    }
    journal.phase = 'aborted';
    try { writeJournal(options, journal); } catch { /* original failure remains authoritative */ }
    throw error;
  }
}

/**
 * S62 recovery primitive for K14: the SQLite import_runs row decides whether a
 * promoting journal committed. Unreached slots are deliberately untouched.
 */
export async function recoverUncommittedCswapImport(options: CswapImportOptions, runId: string): Promise<'cleaned' | 'aborted'> {
  const lock = join(journalRoot(options), 'cswap-import.lock');
  try {
    return await withCswapImportLock(lock, async () => {
      await options.beforeRecovery?.();
      return recoverUncommittedCswapImportLocked(options, runId);
    });
  } catch (error) {
    if (error instanceof CswapImportInProgress) {
      throw new CswapImportRefusalError('import-in-progress', 'C-swap import refused: import already in progress');
    }
    throw error;
  }
}

async function recoverUncommittedCswapImportLocked(options: CswapImportOptions, runId: string): Promise<'cleaned' | 'aborted'> {
  const journal = readJournal(options, runId);
  let committed: boolean;
  try {
    committed = options.repository.getImportRun(runId)?.committedAt != null;
  } catch {
    journal.phase = 'commit-unknown';
    try { writeJournal(options, journal); } catch { /* retain the original authority failure */ }
    throw new CswapImportCommitUnknown(journalPath(options, runId));
  }
  if (committed) {
    await cleanup(options.keychain, journal);
    journal.phase = 'cleaned';
    writeJournal(options, journal);
    return 'cleaned';
  }
  if (journal.phase === 'promoting' || journal.phase === 'commit-unknown') {
    for (const entry of [...journal.slots].reverse()) {
      if (entry.reached === 'unreached' || entry.restored) continue;
      if (entry.destinationExisted) {
        if (!entry.prevSaved || !entry.priorDestinationFingerprint) {
          throw new Error(`C-swap import recovery required: ${journalPath(options, runId)}`);
        }
        const backup = await options.keychain.get(entry.importPrevious, QLB_KEYCHAIN_ACCOUNT);
        if (credentialFingerprint(backup) !== entry.priorDestinationFingerprint) {
          throw new Error(`C-swap import recovery required: ${journalPath(options, runId)}`);
        }
        await options.keychain.set(entry.destination, QLB_KEYCHAIN_ACCOUNT, backup);
      } else {
        await deleteIfPresent(options.keychain, entry.destination);
      }
      if (entry.reached === 'previous') {
        const previous = previousDestination(entry.accountId);
        if (entry.previousDestinationExisted) {
          if (!entry.previousSaved || !entry.priorPreviousFingerprint) {
            throw new Error(`C-swap import recovery required: ${journalPath(options, runId)}`);
          }
          const backup = await options.keychain.get(entry.importPreviousPrevious, QLB_KEYCHAIN_ACCOUNT);
          if (credentialFingerprint(backup) !== entry.priorPreviousFingerprint) {
            throw new Error(`C-swap import recovery required: ${journalPath(options, runId)}`);
          }
          await options.keychain.set(previous, QLB_KEYCHAIN_ACCOUNT, backup);
        } else {
          await deleteIfPresent(options.keychain, previous);
        }
      }
      entry.restored = true;
      writeJournal(options, journal);
    }
  }
  await cleanup(options.keychain, journal);
  journal.phase = 'aborted';
  writeJournal(options, journal);
  return 'aborted';
}
