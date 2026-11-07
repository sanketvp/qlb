import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config';
import {
  authoritativeWindowObserved,
  isCodexUsageDiagnosticAttempt,
  networkDispatchAttempted,
  type CodexUsageDiagnosticAttempt,
} from './codex-usage-diagnostic-shared';
import { readOnlyCodexDiagnosticSchemaRefusal } from './schema-readonly';
import { STALE_OK_S } from './usage-freshness';

type Output = {
  provider: 'openai-codex'; recorded: boolean; attemptedAt: number | null;
  networkDispatchAttempted: boolean | null; classification: string | null;
  entitlementEvidence: string | null; httpStatus: number | null; endpoint: string | null;
  fallbackAttempted: boolean | null; parserShape: string | null; backoffUntil: number | null;
  authoritativeWindowObserved: boolean; stale: boolean;
};

function noRecord(): Output {
  return {
    provider: 'openai-codex', recorded: false, attemptedAt: null, networkDispatchAttempted: null,
    classification: null, entitlementEvidence: null, httpStatus: null, endpoint: null,
    fallbackAttempted: null, parserShape: null, backoffUntil: null,
    authoritativeWindowObserved: false, stale: true,
  };
}

function output(attemptedAt: number, backoffUntil: number | null, diagnostic: CodexUsageDiagnosticAttempt, now: number): Output {
  return {
    provider: 'openai-codex', recorded: true, attemptedAt,
    networkDispatchAttempted: networkDispatchAttempted(diagnostic),
    classification: diagnostic.classification, entitlementEvidence: diagnostic.entitlementEvidence,
    httpStatus: diagnostic.httpStatus, endpoint: diagnostic.endpoint,
    fallbackAttempted: diagnostic.fallbackAttempted, parserShape: diagnostic.parserShape,
    backoffUntil, authoritativeWindowObserved: authoritativeWindowObserved(diagnostic),
    stale: now - attemptedAt * 1000 > STALE_OK_S * 1000,
  };
}

export function readCodexUsageDiagnostic(now = Date.now(), dbPath = config.dbPath): Output {
  if (!existsSync(dbPath)) return noRecord();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let reading = false;
  try {
    db.exec('PRAGMA busy_timeout = 150');
    db.exec('BEGIN');
    reading = true;
    const refusal = readOnlyCodexDiagnosticSchemaRefusal(db);
    if (refusal) throw new Error(`qlb codex usage-diagnostic: ${refusal}`);
    const row = db.prepare(`SELECT last_attempt_at, backoff_until, codex_diag_class, codex_diag_http_status,
      codex_diag_endpoint, codex_diag_fallback_attempted, codex_diag_parser_shape, codex_diag_entitlement_evidence
      FROM usage_polls WHERE provider = 'openai-codex' AND codex_diag_class IS NOT NULL
      ORDER BY last_attempt_at DESC, account_id ASC LIMIT 1`).get() as Record<string, unknown> | undefined;
    db.exec('COMMIT');
    reading = false;
    if (!row || typeof row.last_attempt_at !== 'number') return noRecord();
    const diagnostic = {
      classification: row.codex_diag_class,
      httpStatus: row.codex_diag_http_status,
      endpoint: row.codex_diag_endpoint,
      fallbackAttempted: row.codex_diag_fallback_attempted === 1,
      parserShape: row.codex_diag_parser_shape,
      entitlementEvidence: row.codex_diag_entitlement_evidence,
    };
    if (row.codex_diag_fallback_attempted !== 0 && row.codex_diag_fallback_attempted !== 1
      || !isCodexUsageDiagnosticAttempt(diagnostic)) return noRecord();
    return output(row.last_attempt_at, typeof row.backoff_until === 'number' ? row.backoff_until : null, diagnostic, now);
  } finally {
    if (reading) db.exec('ROLLBACK');
    db.close();
  }
}

export function runCodexUsageDiagnostic(args: string[], write: (line: string) => void = console.log, error: (line: string) => void = console.error, dbPath = config.dbPath): number {
  const json = args.length === 1 && args[0] === '--json';
  if (!(args.length === 0 || json)) {
    error('usage: qlb codex usage-diagnostic [--json]');
    return 1;
  }
  try {
    const result = readCodexUsageDiagnostic(Date.now(), dbPath);
    if (json) write(JSON.stringify(result));
    else if (!result.recorded) write('codex usage diagnostic: no recorded scoped-refresh diagnostic');
    else write(`codex usage diagnostic: attemptedAt=${result.attemptedAt} dispatch=${result.networkDispatchAttempted} classification=${result.classification} entitlement=${result.entitlementEvidence} http=${result.httpStatus ?? 'none'} endpoint=${result.endpoint} fallback=${result.fallbackAttempted} parser=${result.parserShape} backoff=${result.backoffUntil ?? 'none'} authoritative=${result.authoritativeWindowObserved} stale=${result.stale}`);
    return 0;
  } catch (err) {
    error(err instanceof Error ? err.message : 'qlb codex usage-diagnostic: unavailable');
    return 1;
  }
}
