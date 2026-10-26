// C-swap retirement (§4.11) gate evaluation. This module deliberately has no
// mutation primitives: callers may create a journal or retirement fence only
// after this function returns an approved gate record.

import { isSuccessor } from './lineage-log';
import { assertAdmitted, phase } from './lifecycle';
import { openStoreConnection, type Store } from './store';

const RECEIPT_MAX_AGE_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PI_PROVIDERS = ['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter'] as const;

type RetirePhase = 'started' | 'archive' | 'delete-cswap-items' | 'uninstall-cswap' | 'remove-launch-artifacts' | 'delete-pi-baselines' | 'archive-stash' | 'committed';

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

export interface CswapRetireEffects {
  archiveCswap(archivePath: string): Promise<void> | void;
  deleteCswapItems(): Promise<void> | void;
  uninstallCswap(): Promise<void> | void;
  removeCswapLaunchArtifacts(): Promise<void> | void;
  deletePiBaselines(): Promise<void> | void;
  archiveExpiredStash(archivePath: string): Promise<void> | void;
}

export interface CswapRetireDependencies {
  now(): number;
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

function itemMapsToPassedSlot(store: Store, item: CswapRetireItem, slots: RetireSlot[]): boolean {
  return slots.some((slot) => slot.source !== 'qlb-add' && slot.sourceFingerprint !== null
    && (slot.sourceFingerprint === item.fingerprint
      || isSuccessor(store, 'anthropic', slot.accountId, slot.sourceFingerprint, item.fingerprint)));
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
  }

  let items: CswapRetireItem[];
  try {
    items = dependencies.cswapItems();
  } catch {
    return refusal('cswap-items-unavailable');
  }
  const unmatched = items.find((item) => !itemMapsToPassedSlot(store, item, slots));
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
