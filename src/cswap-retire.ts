// C-swap retirement (§4.11). First-run gates are pure; this module writes a
// journal and retirement fence only after that gate record is approved.

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteText, fsyncDirSync } from './fsutil';
import { isSuccessor } from './lineage-log';
import {
  assertAdmitted,
  beginRetirementFence,
  clearRetirementFence,
  phase,
  retirementLockPath,
  transition,
  withRetirementMutationLock,
} from './lifecycle';
import { openStoreConnection, type Store } from './store';

const RECEIPT_MAX_AGE_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PI_PROVIDERS = ['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter'] as const;
const PHASES = ['started', 'archive', 'delete-cswap-items', 'uninstall-cswap', 'remove-launch-artifacts', 'delete-pi-baselines', 'archive-stash', 'committed'] as const;
type RetirePhase = (typeof PHASES)[number];
const defaultRetireLock = withRetirementMutationLock;

export interface RetireSlot {
  accountId: string;
  /** `qlb-add` slots did not originate in C-swap and have no source proof. */
  source?: string | null;
  /** The imported C-swap lineage; values are fingerprints, never credentials. */
  sourceFingerprint: string | null;
  /** Metadata fingerprint observed before the fresh Keychain read. */
  currentFingerprint: string | null;
}

export interface CswapRetireItem {
  id: string;
  fingerprint: string;
}

/** Every effect must be idempotent: rerunning after a crash completes the same end state safely. */
export interface CswapRetireEffects {
  archiveCswap(archivePath: string): Promise<void> | void;
  deleteCswapItems(items: CswapRetireItem[]): Promise<void> | void;
  uninstallCswap(): Promise<void> | void;
  removeCswapLaunchArtifacts(): Promise<void> | void;
  deletePiBaselines(): Promise<void> | void;
  archiveExpiredStash(archivePath: string): Promise<void> | void;
}

export interface CswapRetireDependencies {
  now(): number;
  /** The private QLB state root; the lock is derived from this, never dbPath. */
  stateDir: string;
  backupsDir: string;
  journalDir: string;
  doctor(): Promise<{ overall: 'PASS' | 'FAIL'; autoAgent: 'PASS' | 'FAIL' }> | { overall: 'PASS' | 'FAIL'; autoAgent: 'PASS' | 'FAIL' };
  reportReceiptPasses(): boolean;
  hasFourInjectedDrillRows(): boolean;
  hasUnadoptedStash(): boolean;
  claudeSlotsPass(): boolean;
  slots(): RetireSlot[];
  cswapItems(): CswapRetireItem[];
  /** Must force a Keychain read; it returns only the resulting fingerprint. */
  readSlotFingerprint(accountId: string): Promise<string> | string;
  effects: CswapRetireEffects;
  /** Test seam for requiring each atomic journal rename to be durable. */
  fsyncJournalDir?(dir: string): void;
  /** Test seam for simulating a crash after an effect and before its checkpoint. */
  afterEffect?(phase: Exclude<RetirePhase, 'started' | 'committed'>): void;
  afterCheckpoint?(phase: RetirePhase): void;
  afterTransition?(): void;
  withRetireLock?<T>(path: string, fn: () => Promise<T>): Promise<T>;
}

export interface RetireGateRecord {
  checkedAt: number;
  receiptAt: number;
  slots: Array<{ accountId: string; fingerprint: string }>;
  cswapItems: CswapRetireItem[];
}

interface RetireJournal {
  phase: RetirePhase;
  archivePath: string;
  gates: RetireGateRecord;
  ownerPid: number;
  updatedAt: number;
}

export type CswapRetireResult =
  | { ok: true; archivePath: string }
  | { ok: false; code: string };

export type RetirementGateResult =
  | { ok: true; gates: RetireGateRecord }
  | { ok: false; code: string };

function validTimestamp(value: string | null): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function refusal(code: string): RetirementGateResult {
  return { ok: false, code };
}

function retireRefusal(code: string): CswapRetireResult {
  return { ok: false, code };
}

function journalPath(dir: string): string {
  return join(dir, 'retire-cswap.json');
}

function phaseAtLeast(actual: RetirePhase, expected: RetirePhase): boolean {
  return PHASES.indexOf(actual) >= PHASES.indexOf(expected);
}

function validGates(value: unknown): value is RetireGateRecord {
  if (!value || typeof value !== 'object') return false;
  const gates = value as Partial<RetireGateRecord>;
  return Number.isSafeInteger(gates.checkedAt) && Number.isSafeInteger(gates.receiptAt)
    && Array.isArray(gates.slots) && gates.slots.every((slot) => slot && typeof slot.accountId === 'string' && typeof slot.fingerprint === 'string')
    && Array.isArray(gates.cswapItems) && gates.cswapItems.every((item) => item && typeof item.id === 'string' && typeof item.fingerprint === 'string');
}

function readJournal(dir: string): RetireJournal | null {
  try {
    const value: unknown = JSON.parse(readFileSync(journalPath(dir), 'utf8'));
    if (!value || typeof value !== 'object') throw new Error('malformed retirement journal');
    const journal = value as Partial<RetireJournal>;
    if (!PHASES.includes(journal.phase as RetirePhase) || typeof journal.archivePath !== 'string' || !journal.archivePath
      || !validGates(journal.gates) || !Number.isSafeInteger(journal.ownerPid) || !Number.isSafeInteger(journal.updatedAt)) {
      throw new Error('malformed retirement journal');
    }
    return journal as RetireJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function writeJournal(dir: string, journal: RetireJournal, fsyncJournalDir: (dir: string) => void): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteText(journalPath(dir), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  fsyncJournalDir(dir);
}

function checkpoint(
  dir: string,
  journal: RetireJournal,
  nextPhase: RetirePhase,
  now: number,
  fsyncJournalDir: (dir: string) => void,
): RetireJournal {
  const next = { ...journal, phase: nextPhase, ownerPid: process.pid, updatedAt: now };
  writeJournal(dir, next, fsyncJournalDir);
  return next;
}

function passesReceiptHealth(store: Store, now: number): string | null {
  const receiptId = validTimestamp(store.getConfig('report.receiptHealthLogId'));
  if (receiptId == null || receiptId === 0) return 'report-receipt-health-log-missing';
  const db = openStoreConnection(store.dbPath, true);
  try {
    const receipt = db.prepare('SELECT id, overall FROM health_log WHERE id = ?').get(receiptId) as { id: number; overall: string } | undefined;
    if (receipt?.overall !== 'PASS') return 'report-receipt-health-log-invalid';
    const since = now - DAY_MS;
    const lastPass = db.prepare("SELECT id FROM health_log WHERE overall = 'PASS' AND ts >= ? ORDER BY id DESC LIMIT 1").get(since) as { id: number } | undefined;
    if (!lastPass) return 'health-log-pass-missing';
    const failed = db.prepare("SELECT 1 FROM health_log WHERE overall = 'FAIL' AND ts >= ? AND id > ? LIMIT 1").get(since, lastPass.id);
    return failed ? 'health-log-fail-after-pass' : null;
  } finally {
    db.close();
  }
}

function passesS64(
  store: Store,
  doctor: { overall: 'PASS' | 'FAIL'; autoAgent: 'PASS' | 'FAIL' },
  now: number,
): string | null {
  if (doctor.overall !== 'PASS') return 'doctor-not-pass';
  if (doctor.autoAgent !== 'PASS') return 'doctor-auto-agent-not-pass';
  for (const provider of PI_PROVIDERS) {
    if (store.getConfig(`pi.${provider}.state`) !== 'migrated') continue;
    const servedAt = validTimestamp(store.getConfig(`pi.${provider}.lastServedAt`));
    if (servedAt == null || servedAt > now || now - servedAt > DAY_MS) return `pi-last-served-stale:${provider}`;
  }
  return passesReceiptHealth(store, now);
}

function itemMapsToPassedSlot(
  store: Store,
  item: CswapRetireItem,
  slots: Array<{ slot: RetireSlot; freshFingerprint: string }>,
): boolean {
  return slots.some(({ slot, freshFingerprint }) => slot.source !== 'qlb-add'
    && (item.fingerprint === freshFingerprint
      || isSuccessor(store, 'anthropic', slot.accountId, item.fingerprint, freshFingerprint)));
}

/**
 * Evaluates every first-run retirement bar without writing a journal, fence,
 * lock, database row, or filesystem path. The captured record is the only
 * input a later destructive slice may use to begin retirement.
 */
export async function evaluateRetirementGates(
  store: Store,
  dependencies: CswapRetireDependencies,
): Promise<RetirementGateResult> {
  const admission = assertAdmitted(store, 'retire-cswap');
  if (!admission.ok) return refusal(admission.code ?? 'not-admitted');

  const receiptAt = validTimestamp(store.getConfig('report.receiptAt'));
  if (receiptAt == null) return refusal('report-receipt-missing');
  if (!dependencies.reportReceiptPasses()) return refusal('report-not-pass');
  const doctor = await dependencies.doctor();

  const current = phase(store);
  if (current.rollbackAt != null) return refusal('rollback-recorded');
  for (const provider of PI_PROVIDERS) {
    const state = store.getConfig(`pi.${provider}.state`);
    if (state !== 'migrated' && state !== 'not-applicable') return refusal(`pi-state-invalid:${provider}`);
  }
  if (current.drillDoneAt == null) return refusal('drill-not-recorded');
  if (!dependencies.hasFourInjectedDrillRows()) return refusal('drill-rows-missing');
  if (validTimestamp(store.getConfig('codex.l13VerifiedAt')) == null) return refusal('codex-l13-missing');
  try {
    if (dependencies.hasUnadoptedStash()) return refusal('unadopted-stash');
  } catch {
    return refusal('unadopted-stash-unavailable');
  }
  if (!dependencies.claudeSlotsPass()) return refusal('claude-slots-not-pass');

  let slots: RetireSlot[];
  try {
    slots = dependencies.slots();
  } catch {
    return refusal('claude-slots-unavailable');
  }
  if (slots.length === 0) return refusal('claude-slots-empty');
  const passedSlots: Array<{ slot: RetireSlot; freshFingerprint: string }> = [];
  for (const slot of slots) {
    let freshFingerprint: string;
    try {
      freshFingerprint = await dependencies.readSlotFingerprint(slot.accountId);
    } catch {
      return refusal(`slot-read-failed:${slot.accountId}`);
    }
    if (!slot.currentFingerprint || freshFingerprint !== slot.currentFingerprint) {
      return refusal(`slot-lineage-mismatch:${slot.accountId}`);
    }
    if (slot.source !== 'qlb-add' && (!slot.sourceFingerprint || (slot.sourceFingerprint !== freshFingerprint
      && !isSuccessor(store, 'anthropic', slot.accountId, slot.sourceFingerprint, freshFingerprint)))) {
      return refusal(`slot-lineage-unprovable:${slot.accountId}`);
    }
    passedSlots.push({ slot, freshFingerprint });
  }

  let items: CswapRetireItem[];
  try {
    items = dependencies.cswapItems();
  } catch {
    return refusal('cswap-items-unavailable');
  }
  const unmatched = items.find((item) => !itemMapsToPassedSlot(store, item, passedSlots));
  if (unmatched) return refusal(`cswap-item-unmapped:${unmatched.id}`);

  // The final time read is adjacent to approval, so receipt age and the
  // cutover window cannot become stale between a prior read and destruction.
  const destructiveAt = dependencies.now();
  if (!Number.isSafeInteger(destructiveAt) || destructiveAt < 0) return refusal('clock-invalid');
  if (receiptAt > destructiveAt || destructiveAt - receiptAt > RECEIPT_MAX_AGE_MS) return refusal('report-receipt-stale');
  const finalPhase = phase(store);
  if (finalPhase.state !== 'cutover') return refusal(`phase=${finalPhase.state}`);
  if (finalPhase.rollbackAt != null) return refusal('rollback-recorded');
  if (finalPhase.windowEnd == null || destructiveAt < finalPhase.windowEnd) return refusal('window-not-ended');
  const s64 = passesS64(store, doctor, destructiveAt);
  if (s64) return refusal(s64);

  return {
    ok: true,
    gates: {
      checkedAt: destructiveAt,
      receiptAt,
      slots: slots.map((slot) => ({ accountId: slot.accountId, fingerprint: slot.currentFingerprint! })),
      cswapItems: items,
    },
  };
}

/**
 * Runs the destructive retirement protocol. First-run gates are deliberately
 * evaluated before either durable recovery artifact is written. Resumes use
 * only the captured credential-safety facts, never stale time-based gates.
 */
export async function retireCswap(store: Store, dependencies: CswapRetireDependencies): Promise<CswapRetireResult> {
  const lock = dependencies.withRetireLock ?? defaultRetireLock;
  try {
    return await lock(retirementLockPath(dependencies.stateDir), async () => {
      const fsyncJournalDir = dependencies.fsyncJournalDir ?? fsyncDirSync;
      let journal: RetireJournal | null;
      try {
        journal = readJournal(dependencies.journalDir);
      } catch {
        return retireRefusal('retirement-journal-malformed');
      }

      const admission = assertAdmitted(store, journal ? 'retire-cswap:resume' : 'retire-cswap');
      if (!admission.ok) return retireRefusal(admission.code ?? 'not-admitted');

      // transition() is durable before the committed checkpoint. A retry must
      // finish that terminal cleanup without recreating the retirement fence.
      if (journal && phase(store).state === 'retired') {
        if (phase(store).note === 'retirement-in-progress') {
          const cleared = clearRetirementFence(store);
          if (!cleared.ok) return retireRefusal(cleared.code ?? 'retirement-fence-clear-failed');
        }
        rmSync(journalPath(dependencies.journalDir), { force: true });
        return { ok: true, archivePath: journal.archivePath };
      }

      const resuming = journal !== null;
      if (!journal) {
        const gates = await evaluateRetirementGates(store, dependencies);
        if (!gates.ok) return gates;
        journal = {
          phase: 'started',
          archivePath: join(dependencies.backupsDir, `cswap-retired-${gates.gates.checkedAt}.tar.gz`),
          gates: gates.gates,
          ownerPid: process.pid,
          updatedAt: dependencies.now(),
        };
        // From this point a restart can finish or report the partial operation.
        writeJournal(dependencies.journalDir, journal, fsyncJournalDir);
      }

      // The durable journal always precedes the fence. On resume this is
      // intentionally before safety checks so reversals remain fenced while
      // recovery determines whether effects may continue.
      const fenced = beginRetirementFence(store);
      if (!fenced.ok) return retireRefusal(fenced.code ?? 'retirement-fence-failed');

      if (resuming) {
        // A resumed run must never make an old receipt/window/doctor decision
        // block recovery. It only proves the captured credentials are still
        // safe to remove and that C-swap has not gained another item.
        try {
          if (dependencies.hasUnadoptedStash()) return retireRefusal('unadopted-stash');
        } catch {
          return retireRefusal('unadopted-stash-unavailable');
        }
        for (const captured of journal.gates.slots) {
          let current: string;
          try {
            current = await dependencies.readSlotFingerprint(captured.accountId);
          } catch {
            return retireRefusal(`slot-read-failed:${captured.accountId}`);
          }
          if (current !== captured.fingerprint
            && !isSuccessor(store, 'anthropic', captured.accountId, captured.fingerprint, current)) {
            return retireRefusal(`slot-lineage-mismatch:${captured.accountId}`);
          }
        }
      }

      const effects: Array<[Exclude<RetirePhase, 'started' | 'committed'>, () => Promise<void> | void]> = [
        ['archive', () => dependencies.effects.archiveCswap(journal!.archivePath)],
        ['delete-cswap-items', () => dependencies.effects.deleteCswapItems(journal!.gates.cswapItems)],
        ['uninstall-cswap', () => dependencies.effects.uninstallCswap()],
        ['remove-launch-artifacts', () => dependencies.effects.removeCswapLaunchArtifacts()],
        ['delete-pi-baselines', () => dependencies.effects.deletePiBaselines()],
        ['archive-stash', () => dependencies.effects.archiveExpiredStash(journal!.archivePath)],
      ];
      for (const [name, effect] of effects) {
        if (phaseAtLeast(journal.phase, name)) continue;
        if (name === 'delete-cswap-items') {
          let currentItems: CswapRetireItem[];
          try {
            currentItems = dependencies.cswapItems();
          } catch {
            return retireRefusal('cswap-items-unavailable');
          }
          if (currentItems.some((item) => !journal!.gates.cswapItems.some(
            (captured) => captured.id === item.id && captured.fingerprint === item.fingerprint,
          ))) return retireRefusal('cswap-items-changed');
        }
        try {
          await effect();
        } catch {
          return retireRefusal(`retirement-effect-failed:${name}`);
        }
        dependencies.afterEffect?.(name);
        journal = checkpoint(dependencies.journalDir, journal, name, dependencies.now(), fsyncJournalDir);
        dependencies.afterCheckpoint?.(name);
      }

      if (!phaseAtLeast(journal.phase, 'committed')) {
        const retired = transition(store, 'retired', journal.gates.checkedAt);
        if (!retired.ok) return retireRefusal(retired.code ?? 'retirement-transition-failed');
        dependencies.afterTransition?.();
        journal = checkpoint(dependencies.journalDir, journal, 'committed', dependencies.now(), fsyncJournalDir);
        dependencies.afterCheckpoint?.('committed');
      }
      const cleared = clearRetirementFence(store);
      if (!cleared.ok) return retireRefusal(cleared.code ?? 'retirement-fence-clear-failed');
      rmSync(journalPath(dependencies.journalDir), { force: true });
      return { ok: true, archivePath: journal.archivePath };
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'retirement-locked') return retireRefusal('retirement-in-progress');
    throw error;
  }
}
