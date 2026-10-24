import { createHash } from 'node:crypto';

export const REDACTED = '[redacted]';

// These patterns catch credentials in error bodies before their concrete values are known.
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/gi,
];
const SENSITIVE_KEY = /^(?:access|refresh|id)?[_-]?token(?:s)?$|^(?:api[_-]?key|authorization|credential|password|secret)$|(?:^|[_-])(?:api[_-]?key|authorization|credential|password|secret)$/i;

function fingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Replaces supplied credentials (and their fingerprints) plus recognisable
 * credential shapes. This is deliberately safe to use on arbitrary error text.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED).split(fingerprint(secret)).join(REDACTED);
  }
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

function redactValue(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return REDACTED;
  seen.add(value);

  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets, seen));

  const out: Record<string, unknown> = {};
  try {
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(entry, secrets, seen);
    }
  } catch {
    return REDACTED;
  }
  return out;
}

/** Serializes an arbitrary value without retaining credential values. */
export function redactJson(value: unknown, secrets: readonly string[] = []): string {
  try {
    const json = JSON.stringify(redactValue(value, secrets, new WeakSet<object>()));
    return json === undefined ? 'null' : json;
  } catch {
    return JSON.stringify(REDACTED);
  }
}

/** Returns a safe, single-line error description for persisted error columns and stderr. */
export function redactError(error: unknown, secrets: readonly string[] = []): string {
  if (error instanceof Error) return redactSecrets(error.message || error.name, secrets);
  if (typeof error === 'string') return redactSecrets(error, secrets);
  return redactJson(error, secrets);
}
