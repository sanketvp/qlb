import { createHash } from 'node:crypto';

/** S65's durable, queryable external-login evidence taxonomy. */
export const RELOGIN_EVIDENCE_CLASSES = [
  'login-expiry-jump',
  'auth-time',
  'unattributed-rotation',
  'dead',
  'wiped',
  'replace',
] as const;

/** Existing durable relogin detail codes. All other detail is fingerprinted. */
export const RELOGIN_DETAIL_CODES = ['other', ...RELOGIN_EVIDENCE_CLASSES] as const;

const RELOGIN_EVIDENCE_CLASS_SET = new Set<string>(RELOGIN_EVIDENCE_CLASSES);
const RELOGIN_DETAIL_CODE_SET = new Set<string>(RELOGIN_DETAIL_CODES);
const RELOGIN_DETAIL_FINGERPRINT = /^sha256:[0-9a-f]{16}$/;

export function reloginDetailValue(detail: string | null | undefined): string | null {
  if (detail == null) return null;
  return RELOGIN_DETAIL_CODE_SET.has(detail) ? detail : reloginDetailFingerprint(detail);
}

export function reloginDetailFingerprint(detail: string): string {
  return `sha256:${createHash('sha256').update(detail, 'utf8').digest('hex').slice(0, 16)}`;
}

export function isReloginEvidenceClass(evidence: unknown): evidence is (typeof RELOGIN_EVIDENCE_CLASSES)[number] {
  return typeof evidence === 'string' && RELOGIN_EVIDENCE_CLASS_SET.has(evidence);
}

/** Reject bypasses of the relogin writer that would persist raw text. */
export function assertStoredReloginFields(detail: string | null | undefined, evidence: string | null | undefined): void {
  if (detail != null && !RELOGIN_DETAIL_CODE_SET.has(detail) && !RELOGIN_DETAIL_FINGERPRINT.test(detail)) {
    throw new Error('invalid relogin detail');
  }
  if (evidence != null && !isReloginEvidenceClass(evidence)) {
    throw new Error('invalid relogin evidence class');
  }
}
