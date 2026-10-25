import { createHash } from 'node:crypto';

export const REDACTED = '[redacted]';
const CIRCULAR = '[circular]';

// Explicit token-character lookarounds avoid the \b false-negative when a
// credential ends in punctuation such as -, ~, +, /, or =.
const TOKEN_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9])xai-[A-Za-z0-9]{32,}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9\-._~+/=])Bearer[ \t]+[A-Za-z0-9\-._~+/]{16,}={0,}(?![A-Za-z0-9\-._~+/=])/gi,
];

const SENSITIVE_KEY = new Set([
  'token',
  'tokens',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'apikey',
  'xapikey',
  'secret',
  'clientsecret',
  'consumersecret',
  'apisecret',
  'secretkey',
  'privatekey',
  'password',
  'authorization',
  'credential',
  'credentials',
  'cookie',
  'setcookie',
]);

function fingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.has(key.replace(/[_-]/g, '').toLowerCase());
}

/**
 * Replaces supplied credentials (and their fingerprints) plus recognisable
 * credential shapes. This is deliberately safe to use on arbitrary error text.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  const values = [...new Set(secrets.filter(Boolean))];
  const replacements = [...new Set(values.flatMap((secret) => [fingerprint(secret), secret]))]
    .sort((a, b) => b.length - a.length);
  let out = replacements.length > 0
    ? text.replace(new RegExp(replacements.map(escapeRegExp).join('|'), 'g'), REDACTED)
    : text;

  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** Redacts credentials in diagnostic key/value text that is not valid JSON. */
export function redactKeyValueText(text: string, secrets: readonly string[]): string {
  let out = redactSecrets(text, secrets);
  // Quoted JSON-like pairs are common in truncated diagnostic payloads.
  out = out.replace(/((["'])([A-Za-z][A-Za-z0-9_-]*)\2\s*:\s*)(["'])((?:\\.|(?!\4)[^\\\r\n])*)\4/g,
    (match, prefix: string, _keyQuote: string, key: string, valueQuote: string) => (
      isSensitiveKey(key) ? `${prefix}${valueQuote}${REDACTED}${valueQuote}` : match
    ));
  // Authorization values commonly contain a scheme and spaces, so redact the
  // whole header remainder rather than only its first word.
  out = out.replace(/(^|[^A-Za-z0-9_-])(authorization)(\s*(?:=|:)\s*)([^\r\n]*)/gi,
    (match, boundary: string, key: string, separator: string) => (
      isSensitiveKey(key) ? `${boundary}${key}${separator}${REDACTED}` : match
    ));
  return out.replace(/(^|[^A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]*)(\s*(?:=|:)\s*)([^\s,;\r\n]+)/g,
    (match, boundary: string, key: string, separator: string) => (
      isSensitiveKey(key) ? `${boundary}${key}${separator}${REDACTED}` : match
    ));
}

type RedactedValue = unknown | undefined;

interface RedactOptions {
  /** Persisted sinks redact sensitive property names; live events preserve their payload shape. */
  keyRules: boolean;
}

function arrayLength(descriptors: PropertyDescriptorMap): number {
  const length = descriptors.length;
  if (!length || !('value' in length) || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0) {
    throw new Error('unreadable array length');
  }
  return length.value;
}

function uniqueKey(key: string, used: Set<string>): string {
  if (!used.has(key)) {
    used.add(key);
    return key;
  }
  let suffix = 2;
  while (used.has(`${key}#${suffix}`)) suffix += 1;
  const unique = `${key}#${suffix}`;
  used.add(unique);
  return unique;
}

function defineOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  // Assignment to __proto__ invokes Object.prototype's legacy setter.
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

function redactValue(
  value: unknown,
  secrets: readonly string[],
  ancestors: WeakSet<object>,
  memo: WeakMap<object, object>,
  options: RedactOptions,
): RedactedValue {
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return CIRCULAR;
  const prior = memo.get(value);
  if (prior) return prior;

  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      memo.set(value, out);
      const length = arrayLength(descriptors);
      out.length = length;
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) {
          out[index] = undefined;
        } else if (!('value' in descriptor)) {
          // Never invoke event accessors. Persisted output marks them redacted;
          // live events use undefined rather than inventing a string payload.
          out[index] = options.keyRules ? REDACTED : undefined;
        } else {
          out[index] = redactValue(descriptor.value, secrets, ancestors, memo, options);
        }
      }
      return out;
    }

    const out: Record<string, unknown> = {};
    memo.set(value, out);
    const used = new Set<string>();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      const redactedKey = options.keyRules ? redactSecrets(key, secrets) : key;
      if (options.keyRules && (isSensitiveKey(key) || !('value' in descriptor))) {
        defineOwn(out, uniqueKey(redactedKey, used), REDACTED);
        continue;
      }
      // Accessors are omitted from live events: invoking them could execute
      // arbitrary code, and a fabricated redaction string corrupts the payload.
      if (!('value' in descriptor)) continue;
      const redacted = redactValue(descriptor.value, secrets, ancestors, memo, options);
      if (redacted !== undefined) defineOwn(out, uniqueKey(redactedKey, used), redacted);
    }
    return out;
  } catch {
    // A proxy may reject descriptor inspection. Do not fall back to property reads.
    return REDACTED;
  } finally {
    ancestors.delete(value);
  }
}

/** Serializes an arbitrary value without retaining credential values. */
export function redactJson(value: unknown, secrets: readonly string[]): string {
  try {
    const json = JSON.stringify(redactValue(value, secrets, new WeakSet<object>(), new WeakMap<object, object>(), { keyRules: true }));
    return json === undefined ? 'null' : json;
  } catch {
    return JSON.stringify(REDACTED);
  }
}

/** Redacts Pi stream strings without mutating payload keys or primitive value types. */
export function redactEvent(event: unknown, secrets: readonly string[]): unknown {
  return redactValue(event, secrets, new WeakSet<object>(), new WeakMap<object, object>(), { keyRules: false });
}

function escapeControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    switch (character) {
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      default: return `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`;
    }
  });
}

function errorProperty(error: Error, key: 'message' | 'name'): string {
  try {
    let target: object | null = error;
    while (target !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor) {
        if (!('value' in descriptor)) return '[unreadable]';
        const { value } = descriptor;
        if (typeof value === 'string') return value;
        if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return String(value);
        return '[unreadable]';
      }
      target = Object.getPrototypeOf(target);
    }
  } catch {
    // Proxies can reject descriptor or prototype inspection.
  }
  return '[unreadable]';
}

/** Returns a safe, single-line error description for persisted error columns and stderr. */
export function redactError(error: unknown, secrets: readonly string[]): string {
  try {
    const value = error instanceof Error
      ? (() => {
          const message = errorProperty(error, 'message');
          const name = errorProperty(error, 'name');
          return redactSecrets(message || name, secrets);
        })()
      : typeof error === 'string'
        ? redactSecrets(error, secrets)
        : redactJson(error, secrets);
    return escapeControls(value);
  } catch {
    return '[unreadable]';
  }
}
