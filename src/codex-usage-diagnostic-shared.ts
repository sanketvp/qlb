export const CODEX_USAGE_DIAGNOSTIC_CLASSES = [
  'preflight-no-bare-account-id',
  'transport-failure',
  'unauthorized',
  'forbidden-or-provider-ineligible',
  'rate-limited',
  'http-other',
  'provider-gauge',
  'success-unrecognized-shape',
] as const;

export type CodexUsageDiagnosticClass = typeof CODEX_USAGE_DIAGNOSTIC_CLASSES[number];
export type CodexUsageDiagnosticEndpoint = 'none' | 'wham' | 'codex-api';
export type CodexUsageDiagnosticParserShape = 'not-applicable' | 'recognized-primary-or-secondary' | 'unrecognized-success';
export type CodexUsageDiagnosticEntitlementEvidence = 'unknown' | 'provider-gauge-recognized' | 'provider-forbidden-or-ineligible';

export interface CodexUsageDiagnosticAttempt {
  classification: CodexUsageDiagnosticClass;
  httpStatus: number | null;
  endpoint: CodexUsageDiagnosticEndpoint;
  fallbackAttempted: boolean;
  parserShape: CodexUsageDiagnosticParserShape;
  entitlementEvidence: CodexUsageDiagnosticEntitlementEvidence;
}

const classes = new Set<string>(CODEX_USAGE_DIAGNOSTIC_CLASSES);
const endpoints = new Set<string>(['none', 'wham', 'codex-api']);
const shapes = new Set<string>(['not-applicable', 'recognized-primary-or-secondary', 'unrecognized-success']);
const evidence = new Set<string>(['unknown', 'provider-gauge-recognized', 'provider-forbidden-or-ineligible']);

function is2xx(value: number | null): boolean {
  return value !== null && value >= 200 && value < 300;
}

/** Validates the complete finite tuple before persistence or read-only projection. */
export function isCodexUsageDiagnosticAttempt(value: unknown): value is CodexUsageDiagnosticAttempt {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const classification = item.classification;
  const status = item.httpStatus;
  const endpoint = item.endpoint;
  const fallback = item.fallbackAttempted;
  const shape = item.parserShape;
  const entitlement = item.entitlementEvidence;
  if (typeof classification !== 'string' || !classes.has(classification)
    || typeof endpoint !== 'string' || !endpoints.has(endpoint)
    || typeof fallback !== 'boolean'
    || typeof shape !== 'string' || !shapes.has(shape)
    || typeof entitlement !== 'string' || !evidence.has(entitlement)
    || !(status === null || (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599))) return false;
  if (fallback && endpoint !== 'codex-api') return false;
  switch (classification) {
    case 'preflight-no-bare-account-id':
      return status === null && endpoint === 'none' && !fallback && shape === 'not-applicable' && entitlement === 'unknown';
    case 'transport-failure':
      return status === null && endpoint !== 'none' && shape === 'not-applicable' && entitlement === 'unknown';
    case 'unauthorized':
      return status === 401 && endpoint !== 'none' && shape === 'not-applicable' && entitlement === 'unknown';
    case 'forbidden-or-provider-ineligible':
      return status === 403 && endpoint !== 'none' && shape === 'not-applicable' && entitlement === 'provider-forbidden-or-ineligible';
    case 'rate-limited':
      return status === 429 && endpoint !== 'none' && shape === 'not-applicable' && entitlement === 'unknown';
    case 'http-other':
      return status !== null && !is2xx(status) && ![401, 403, 429].includes(status)
        && endpoint !== 'none' && shape === 'not-applicable' && entitlement === 'unknown';
    case 'provider-gauge':
      return is2xx(status) && endpoint !== 'none' && shape === 'recognized-primary-or-secondary'
        && entitlement === 'provider-gauge-recognized';
    case 'success-unrecognized-shape':
      return is2xx(status) && endpoint !== 'none' && shape === 'unrecognized-success' && entitlement === 'unknown';
  }
  return false;
}

export function assertCodexUsageDiagnosticAttempt(value: unknown): asserts value is CodexUsageDiagnosticAttempt {
  if (!isCodexUsageDiagnosticAttempt(value)) throw new Error('invalid Codex usage diagnostic');
}

export function networkDispatchAttempted(value: CodexUsageDiagnosticAttempt): boolean {
  return value.classification !== 'preflight-no-bare-account-id';
}

export function authoritativeWindowObserved(value: CodexUsageDiagnosticAttempt): boolean {
  return value.classification === 'provider-gauge';
}
