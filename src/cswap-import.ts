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
import { credentialFingerprint } from './anthropic-oauth';
import { looksLikeApiKey } from './cc-credentials';
import type { ClaudeSlot, ClaudeSlotBackend, ClaudeSlotRepository } from './cc-slots';
import { isCredentialNotFound } from './credential-backends';
import { QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from './keychain';

const PROVIDER = 'anthropic';

export type CswapCredentialBackend = 'enc' | 'keychain';

export interface CswapImportSlotPlan {
  slotNum: number;
  email: string;
  accountId: string;
  alias: string | null;
  orgUuid: string | null;
  threshold: number | null;
  configJson: string;
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
  journalDir?: string;
  keychain: ClaudeSlotBackend;
  repository: ClaudeSlotRepository;
  /** Read only; supplied by the command for the live Claude Code item. */
  liveCredential?: () => Promise<string>;
  now?: () => number;
  runId?: string;
  replace?: boolean;
  /** S46 proof injected by the Store-bound lineage service. */
  isSuccessor?: (accountId: string, ancestor: string, descendant: string) => boolean;
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
  credential: string;
  previousCredential: string | null;
  /** Inventory count only; never returned with a credential value. */
  keychainItems: number;
}

interface JournalSlot {
  accountId: string;
  staging: string;
  destination: string;
  importPrevious: string;
  fingerprint: string;
  previousFingerprint: string | null;
  prevSaved: boolean;
}

interface Journal {
  runId: string;
  phase: 'staged' | 'promoting' | 'committed' | 'cleaned' | 'aborted';
  startedAt: number;
  slots: JournalSlot[];
}

function safeSegment(value: string, label: string): string {
  if (!value || /[\\/\0]/.test(value)) throw new Error(`invalid C-swap ${label}`);
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

function credentialAccountId(credential: string): string | null {
  try {
    const root = object(JSON.parse(credential), 'invalid credential');
    const oauth = object(root.claudeAiOauth, 'invalid credential');
    return nullableString(oauth.accountUuid) ?? nullableString(oauth.account_id);
  } catch {
    return null;
  }
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

function service(runId: string, accountId: string, kind: 'staging' | 'import-prev'): string {
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
  try { return await keychain.get('claude-swap', account); } catch { return null; }
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
  for (const [number, rawRecord] of Object.entries(accounts)) {
    const record = object(rawRecord, 'C-swap account record is malformed');
    const slotNum = Number(number);
    if (!Number.isSafeInteger(slotNum) || slotNum < 1) throw new Error('C-swap account number is invalid');
    const email = safeSegment(string(record.email, 'C-swap account has no email'), 'email');
    const configPath = join(options.backupDir, 'configs', `.claude-config-${number}-${email}.json`);
    let configJson: string;
    try { configJson = io.readText(configPath); } catch { throw new Error(`C-swap config is unreadable for slot ${number}`); }
    const accountId = safeSegment(configAccountId(configJson), 'account identity');
    const encPath = join(options.backupDir, 'credentials', `.creds-${number}-${email}.enc`);
    const encPresent = io.exists(encPath);
    let credential: string | null = null;
    if (encPresent) {
      try { credential = base64Credential(io.readText(encPath)); } catch { /* corrupt/unreadable .enc falls through */ }
    }
    // Inventory probes both C-swap generations even when a valid .enc shadows
    // the current item; reader precedence still decides the imported bytes.
    const keychainCurrent = await probeCswapItem(options.keychain, `account-${number}-${email}`);
    let backend: CswapCredentialBackend = 'enc';
    if (credential == null) {
      backend = 'keychain';
      if (keychainCurrent == null) throw new Error(`C-swap credential is unavailable for slot ${number}`);
      credential = keychainCurrent;
    }
    if (looksLikeApiKey(credential)) {
      throw new Error(`C-swap API-key slot refused: ${number}`);
    }
    const fingerprint = credentialFingerprint(credential);
    if (!fingerprint) throw new Error(`C-swap credential is invalid for slot ${number}`);
    let previousFromEnc: string | null = null;
    if (io.exists(`${encPath}.prev`)) {
      try { previousFromEnc = base64Credential(io.readText(`${encPath}.prev`)); } catch { /* Keychain prev remains a fallback */ }
    }
    const keychainPrevious = await probeCswapItem(options.keychain, `account-${number}-${email}.prev`);
    const previousText = previousFromEnc ?? keychainPrevious;
    const previousFingerprint = previousText ? credentialFingerprint(previousText) : null;
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
    // Imported credentials remain valid when C-swap's optional preferences
    // cache is stale or malformed; it is not an authorization source.
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
          ? nullableNumber((reading as Record<string, unknown>).utilization ?? (reading as Record<string, unknown>).usedPct)
          : nullableNumber(reading);
        if (value == null || value < 0 || value > 100 || result.some((item) => item.accountId === slot.accountId && item.bucket === bucket)) continue;
        result.push({ accountId: slot.accountId, bucket, usedPct: value, fetchedAt: fetched });
      }
    }
    return result;
  } catch { return []; }
}

function planFrom(slots: SourceSlot[], sessionProfiles: number, replaceRequired: boolean): CswapImportPlan {
  return {
    slots: slots.map(({ credential: _credential, previousCredential: _previousCredential, keychainItems: _keychainItems, ...slot }) => slot),
    keychainItems: slots.reduce((count, slot) => count + slot.keychainItems, 0),
    apiKeySlots: 0, sessionProfiles, encFiles: slots.filter((slot) => slot.encPresent).length,
    activeAccountId: slots.find((slot) => slot.active)?.accountId ?? null,
    destination: replaceRequired ? 'replace-required' : 'empty',
  };
}

/** Read-only inventory. It deliberately never probes the live Claude credential. */
export async function planCswapImport(options: CswapImportOptions): Promise<CswapImportPlan> {
  const { slots, sessionProfiles } = await readSourceSlots(options);
  const replaceRequired = options.repository.listSlots().length > 0 || await Promise.all(slots.map((slot) => optionalGet(options.keychain, destination(slot.accountId))))
    .then((items) => items.some((item) => item !== null));
  return planFrom(slots, sessionProfiles, replaceRequired);
}

function admittedReplace(existing: ClaudeSlot, source: SourceSlot, successor: CswapImportOptions['isSuccessor']): boolean {
  if (existing.fingerprint === source.fingerprint) return true;
  if (source.previousFingerprint === existing.fingerprint) return true;
  return Boolean(existing.fingerprint && successor?.(source.accountId, existing.fingerprint, source.fingerprint));
}

async function assertDestination(options: CswapImportOptions, slots: SourceSlot[]): Promise<void> {
  const existingSlots = options.repository.listSlots();
  const hasSlot = existingSlots.length > 0;
  const sourceIds = new Set(slots.map((slot) => slot.accountId));
  const unrelated = existingSlots.find((slot) => !sourceIds.has(slot.accountId));
  if (unrelated) throw new Error(`C-swap import refused: destination has unrelated slot ${unrelated.accountId}`);
  for (const source of slots) {
    const dbSlot = options.repository.getSlot(source.accountId);
    const item = await optionalGet(options.keychain, destination(source.accountId));
    if (!dbSlot && !item) continue;
    if (!options.replace) throw new Error(`C-swap import refused: destination is non-empty for slot ${source.slotNum}`);
    if (!dbSlot || !admittedReplace(dbSlot, source, options.isSuccessor)) {
      throw new Error(`C-swap import refused: destination lineage is unrelated for slot ${source.slotNum}`);
    }
  }
  if (hasSlot && !options.replace) throw new Error('C-swap import refused: destination is non-empty');
}

function journalPath(options: CswapImportOptions, runId: string): string {
  const root = options.journalDir ?? join(options.backupDir, '.qlb-import-journal');
  return join(root, `cswap-import-${safeSegment(runId, 'run id')}`, 'journal.json');
}

function writeJournal(options: CswapImportOptions, journal: Journal): void {
  const io = options.files ?? files;
  const path = journalPath(options, journal.runId);
  io.mkdir(dirname(path));
  io.writeText(path, JSON.stringify(journal));
}

async function cleanup(keychain: ClaudeSlotBackend, journal: Journal): Promise<void> {
  for (const entry of journal.slots) {
    try { await keychain.delete(entry.staging, QLB_KEYCHAIN_ACCOUNT); } catch (error) { if (!isCredentialNotFound(error)) throw error; }
    try { await keychain.delete(entry.importPrevious, QLB_KEYCHAIN_ACCOUNT); } catch (error) { if (!isCredentialNotFound(error)) throw error; }
  }
}

/**
 * Executes §4.9 staging/promotion. K14 owns cross-process journal discovery;
 * this function records all phases and exposes S62's import-run authority.
 */
export async function importCswap(options: CswapImportOptions): Promise<{ runId: string; phase: 'cleaned'; plan: CswapImportPlan }> {
  const { slots: sourceSlots, sessionProfiles } = await readSourceSlots(options);
  if (sessionProfiles > 0) throw new Error(`C-swap import refused: ${sessionProfiles} session profiles present`);
  await assertDestination(options, sourceSlots);
  const plan = planFrom(sourceSlots, sessionProfiles, options.repository.listSlots().length > 0);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const runId = options.runId ?? `${startedAt}-${randomUUID()}`;
  const journal: Journal = {
    runId, phase: 'staged', startedAt,
    slots: sourceSlots.map((slot) => ({ accountId: slot.accountId, staging: service(runId, slot.accountId, 'staging'),
      destination: destination(slot.accountId), importPrevious: service(runId, slot.accountId, 'import-prev'),
      fingerprint: slot.fingerprint, previousFingerprint: slot.previousFingerprint, prevSaved: false })),
  };
  writeJournal(options, journal);
  const finals: Array<{ target: string; prior: string | null; previousTarget: string; priorPrevious: string | null; replaced: boolean }> = [];
  try {
    for (let index = 0; index < sourceSlots.length; index += 1) {
      const source = sourceSlots[index];
      await options.keychain.set(journal.slots[index].staging, QLB_KEYCHAIN_ACCOUNT, source.credential);
      const actual = await options.keychain.get(journal.slots[index].staging, QLB_KEYCHAIN_ACCOUNT);
      if (credentialFingerprint(actual) !== source.fingerprint) throw new Error(`C-swap import verification failed for slot ${source.slotNum}`);
    }

    // The live value only supersedes the C-swap backup for its matching active identity.
    const effective = sourceSlots.map((slot) => ({ ...slot, effectiveCredential: slot.credential, effectivePrevious: slot.previousCredential, effectiveFrom: null as string | null }));
    const activeIndex = effective.findIndex((slot) => slot.active);
    if (activeIndex >= 0 && options.liveCredential) {
      const live = await options.liveCredential();
      if (credentialAccountId(live) !== effective[activeIndex].accountId) throw new Error('C-swap import refused: live active identity mismatch');
      const liveFingerprint = credentialFingerprint(live);
      if (!liveFingerprint) throw new Error('C-swap import refused: live active credential is invalid');
      if (live !== effective[activeIndex].credential) {
        effective[activeIndex].effectiveCredential = live;
        effective[activeIndex].effectivePrevious = effective[activeIndex].credential;
        // Same-lineage refreshes have no S46 graph edge; a different refresh
        // lineage records the C-swap copy as its explicit ancestor.
        effective[activeIndex].effectiveFrom = liveFingerprint === effective[activeIndex].fingerprint
          ? null : effective[activeIndex].fingerprint;
      }
    }

    journal.phase = 'promoting';
    writeJournal(options, journal);
    for (let index = 0; index < effective.length; index += 1) {
      const slot = effective[index];
      const entry = journal.slots[index];
      const prior = await optionalGet(options.keychain, entry.destination);
      const previousTarget = previousDestination(slot.accountId);
      const priorPrevious = await optionalGet(options.keychain, previousTarget);
      if (prior != null) {
        await options.keychain.set(entry.importPrevious, QLB_KEYCHAIN_ACCOUNT, prior);
        entry.prevSaved = true;
        writeJournal(options, journal);
      }
      await options.keychain.set(entry.destination, QLB_KEYCHAIN_ACCOUNT, slot.effectiveCredential);
      if (slot.effectivePrevious) await options.keychain.set(previousTarget, QLB_KEYCHAIN_ACCOUNT, slot.effectivePrevious);
      finals.push({ target: entry.destination, prior, previousTarget, priorPrevious, replaced: prior !== null });
    }
    for (let index = 0; index < effective.length; index += 1) {
      const actual = await options.keychain.get(journal.slots[index].destination, QLB_KEYCHAIN_ACCOUNT);
      if (credentialFingerprint(actual) !== credentialFingerprint(effective[index].effectiveCredential)) {
        throw new Error(`C-swap import final verification failed for slot ${effective[index].slotNum}`);
      }
    }

    const committedAt = now();
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
      snapshots: importedSnapshots(options, sourceSlots),
      config: importedSettings(options),
    });
    journal.phase = 'committed';
    writeJournal(options, journal);
    await cleanup(options.keychain, journal);
    journal.phase = 'cleaned';
    writeJournal(options, journal);
    return { runId, phase: 'cleaned', plan };
  } catch (error) {
    // Before the durable DB commit, restore a replaced destination and remove
    // new destinations. This is the same data recorded for K14's crash path.
    const committed = options.repository.getImportRun(runId)?.committedAt != null;
    if (committed) {
      // S62: a durable row wins over a failed cleanup/write of the journal.
      // K14 will finish cleanup; never mislabel this committed promotion aborted.
      journal.phase = 'committed';
      try { writeJournal(options, journal); } catch { /* original failure remains authoritative */ }
      throw error;
    }
    for (let index = finals.length - 1; index >= 0; index -= 1) {
      const effect = finals[index];
      const entry = journal.slots.find((slot) => slot.destination === effect.target)!;
      try {
        if (effect.replaced && effect.prior != null) await options.keychain.set(effect.target, QLB_KEYCHAIN_ACCOUNT, effect.prior);
        else await options.keychain.delete(effect.target, QLB_KEYCHAIN_ACCOUNT);
        if (effect.priorPrevious != null) await options.keychain.set(effect.previousTarget, QLB_KEYCHAIN_ACCOUNT, effect.priorPrevious);
        else await options.keychain.delete(effect.previousTarget, QLB_KEYCHAIN_ACCOUNT);
      } catch { /* original failure remains authoritative */ }
    }
    journal.phase = 'aborted';
    try { writeJournal(options, journal); } catch { /* original failure remains authoritative */ }
    throw error;
  }
}
