import { createHash } from 'node:crypto';

/** Durable relogin reason taxonomy from spec §3.2 / S65. */
export const RELOGIN_REASON_CODES = [
  'login-expiry-jump',
  'auth-time',
  'unattributed-rotation',
  'dead',
  'wiped',
  'replace',
] as const;

const RELOGIN_REASON_CODE_SET = new Set<string>(RELOGIN_REASON_CODES);
const RELOGIN_EVIDENCE_FINGERPRINT = /^sha256:[0-9a-f]{16}$/;

export function reloginReasonCode(detail: string | null | undefined): string | null {
  if (detail == null) return null;
  return RELOGIN_REASON_CODE_SET.has(detail) ? detail : 'other';
}

export function reloginEvidenceFingerprint(evidence: string | null | undefined): string | null {
  if (evidence == null) return null;
  return `sha256:${createHash('sha256').update(evidence, 'utf8').digest('hex').slice(0, 16)}`;
}

/** Reject bypasses of the relogin writer that would persist raw text. */
export function assertStoredReloginFields(detail: string | null | undefined, evidence: string | null | undefined): void {
  if (detail != null && detail !== 'other' && !RELOGIN_REASON_CODE_SET.has(detail)) {
    throw new Error('invalid relogin detail code');
  }
  if (evidence != null && !RELOGIN_EVIDENCE_FINGERPRINT.test(evidence)) {
    throw new Error('invalid relogin evidence fingerprint');
  }
}
