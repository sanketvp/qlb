import type { CodexConsumeStatus } from './codex-consume';
import type { AdmissionRefusal } from './codex-stage';
import type { CodexRecoveryVerdict, CodexSwitchPreconditionReason, ObserveLiveCodexResult } from './codex-switch';

/**
 * Every refusal cause the Codex switch path can persist as a `switch_log`
 * row. The go-live stop rules treat a persisted refusal with any other cause
 * (or none) as an unexplained refusal. `test/codex-refusals.test.ts` reads the
 * switch source and fails when a persisted cause is missing here; the
 * `Record` keys below make the compiler enforce the typed unions.
 */
const PRECONDITION_REASONS: Record<CodexSwitchPreconditionReason, true> = {
  'cswap-process-alive': true,
  'cswap-process-check-failed': true,
  'target-missing': true,
  'target-dead': true,
  'target-pending-adopt': true,
  'codex-l13-unverified': true,
};

const CONSUME_STATUSES: Record<CodexConsumeStatus, true> = {
  refreshed: true,
  fresh: true,
  held: true,
  busy: true,
  'active-slot': true,
  'c9-unavailable': true,
  dead: true,
  superseded: true,
  'codex-won-inactive': true,
  transient: true,
  stashed: true,
  'stashed-lock-lost': true,
  'successor-unpersisted': true,
  'slot-removed': true,
  'slot-split': true,
  'switch-in-flight': true,
  'stop-latched': true,
};

type UnresolvedFenceReason = Extract<CodexRecoveryVerdict, { class: 'unresolved' }>['reason'];
const UNRESOLVED_FENCE_REASONS: Record<UnresolvedFenceReason, true> = {
  'target-changed': true,
  'target-ancestor': true,
  'slot-split': true,
  'stash-unverifiable': true,
  'logged-out': true,
};

type LiveObservationRefusal = Extract<ObserveLiveCodexResult, { outcome: 'refused' }>['reason'];
const LIVE_OBSERVATION_REFUSALS: Record<LiveObservationRefusal, true> = {
  'codex-writing': true,
  'codex-logged-out': true,
  'codex-auth-unreadable': true,
  wiped: true,
  'republish-failed': true,
  'unknown-live-identity': true,
  'stash-unverifiable': true,
  'slot-split': true,
};

/** The stop rules' admission refusals. The switch path never persists them, but a row carrying one is explained. */
const ADMISSION_REFUSALS: Record<AdmissionRefusal, true> = {
  'codex-stop-latched': true,
  'codex-switch-disabled': true,
  'codex-auto-outside-stage-2': true,
};

export const CODEX_NAMED_REFUSALS: ReadonlySet<string> = new Set([
  ...Object.keys(PRECONDITION_REASONS),
  ...Object.keys(CONSUME_STATUSES).map((status) => `target-freshen-${status}`),
  ...Object.keys(UNRESOLVED_FENCE_REASONS),
  ...Object.keys(LIVE_OBSERVATION_REFUSALS),
  ...Object.keys(ADMISSION_REFUSALS),
  // Passed as literals at the persisting refusal sites.
  'switch-busy',
  'target-slot-split',
  'target-freshen-too-close',
  'target-held-by-session',
  // Recovery-fence reasons that are not unresolved verdicts.
  'switch-recovery-malformed',
  'switch-in-flight',
]);
