import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { tokenCallAllowed } from './commands/token';
import { assertAdmitted } from './lifecycle';
import { loadGate } from './gate';
import { openStore, openStoreConnection } from './store';

export const PI_GATE_PROVIDERS = ['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter'] as const;
export type PiGateProvider = (typeof PI_GATE_PROVIDERS)[number];

export interface GateCredential {
  token: string;
  accountId: string;
  chatgptAccountId?: string;
  expiresAt?: number;
  source: string;
}

/** Provider slices own identity resolution and any synchronous refresh. */
export interface ProviderGate {
  prerequisites?: () => void | Promise<void>;
  read(): GateCredential | Promise<GateCredential>;
  refresh?: () => GateCredential | Promise<GateCredential>;
}

export interface PiGateDeps {
  dbPath: string;
  env: NodeJS.ProcessEnv;
  deliver(value: string): void;
  stderr?(message: string): void;
  guard?: (env: NodeJS.ProcessEnv) => boolean;
  /** Test seam; production opens a short-lived Store solely for lifecycle admission. */
  admitted?: () => { ok: boolean; code?: string };
  provider?: ProviderGate;
  prerequisites?: (provider: PiGateProvider, db: DatabaseSync) => void | Promise<void>;
  open?: (dbPath: string) => DatabaseSync;
  sqlTrace?: (sql: string) => void;
  evidenceGap?: (provider: PiGateProvider, error: unknown) => void;
  /** Command dispatch supplies the configured Pi agent directory. */
  piAgentDir?: string;
}

function isProvider(value: string): value is PiGateProvider {
  return (PI_GATE_PROVIDERS as readonly string[]).includes(value);
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function defaultAdmission(dbPath: string): { ok: boolean; code?: string } {
  const store = openStore(dbPath);
  try {
    const result = assertAdmitted(store, 'gate');
    return { ok: result.ok, code: result.code };
  } finally {
    store.close();
  }
}

function parsedObject(path: string, code: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
    return value as Record<string, unknown>;
  } catch {
    throw new Error(code);
  }
}

function defaultPrerequisites(provider: PiGateProvider, db: DatabaseSync, dbPath: string, piAgentDir?: string): void {
  const state = db.prepare('SELECT value FROM config WHERE key = ?').get(`pi.${provider}.state`) as { value?: unknown } | undefined;
  if (state?.value === 'not-applicable') throw new Error('provider-not-applicable');

  const agentDir = piAgentDir ?? join(dirname(dbPath), '..', '.pi', 'agent');
  const ownerPath = join(agentDir, 'qlb-owner.json');
  if (!existsSync(ownerPath)) throw new Error('owner-entry-missing');
  const owner = parsedObject(ownerPath, 'owner-file-malformed');
  const providers = owner.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) throw new Error('owner-file-malformed');
  const entry = (providers as Record<string, unknown>)[provider];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      (entry as Record<string, unknown>).mode !== 'qlb') throw new Error('owner-entry-missing');

  if (provider === 'openrouter') return;
  const authPath = join(agentDir, 'auth.json');
  const auth = parsedObject(authPath, 'placeholder-missing');
  const placeholder = auth[provider];
  if (!placeholder || typeof placeholder !== 'object' || Array.isArray(placeholder) ||
      (placeholder as Record<string, unknown>).type !== 'oauth' ||
      (placeholder as Record<string, unknown>).access !== 'qlb-managed' ||
      (placeholder as Record<string, unknown>).refresh !== '') throw new Error('placeholder-missing');
  if (provider === 'anthropic' && existsSync(join(agentDir, 'extensions', 'anthropic-pool'))) {
    throw new Error('anthropic-pool-present');
  }
}

const SAFE_FAILURE_CODES = new Set([
  'owner-entry-missing', 'owner-file-malformed', 'placeholder-missing', 'anthropic-pool-present',
  'provider-not-applicable', 'missing-provider-gate', 'credential-unavailable',
]);

function failureCode(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return SAFE_FAILURE_CODES.has(value) || /^phase=(?:pre-cutover|undoing|rolled-back|aborted)$/.test(value)
    ? value
    : 'credential-unavailable';
}

function loadedProvider(provider: PiGateProvider): ProviderGate {
  const loaded = loadGate(provider) as { default?: unknown } | unknown;
  const gate = (loaded && typeof loaded === 'object' && 'default' in loaded ? loaded.default : loaded) as Partial<ProviderGate>;
  if (!gate || typeof gate.read !== 'function') throw new Error('missing-provider-gate');
  return gate as ProviderGate;
}

function recordEvidence(db: DatabaseSync, provider: PiGateProvider, credential: GateCredential, trace?: (sql: string) => void): void {
  trace?.('BEGIN IMMEDIATE');
  db.exec('BEGIN IMMEDIATE');
  try {
    const now = String(Date.now());
    const write = db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    write.run(`pi.${provider}.lastServedFingerprint`, fingerprint(credential.token));
    write.run(`pi.${provider}.lastServedAt`, now);
    if (provider === 'anthropic') write.run('pi.anthropic.lastServedBy', 'qlb-pi');
    trace?.('COMMIT');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve evidence failure */ }
    throw error;
  }
}

/** Value-free persistent record for evidence writes that exhausted busy_timeout. */
export function appendEvidenceGap(dbPath: string, provider: PiGateProvider): void {
  try {
    const directory = dirname(dbPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(join(directory, 'auto.log'), `pi:evidence-gap provider=${provider} at=${Date.now()}\n`, { mode: 0o600 });
  } catch {
    // The credential still must not be withheld merely because its audit sink is unavailable.
  }
}

/** S30/S54 gate boundary. Credential resolution is deliberately outside the evidence transaction. */
export async function runPiGate(providerName: string, deps: PiGateDeps): Promise<number> {
  if (!isProvider(providerName) || !(deps.guard ?? tokenCallAllowed)(deps.env)) return 3;

  let db: DatabaseSync;
  try {
    db = (deps.open ?? ((path) => openStoreConnection(path)))(deps.dbPath);
  } catch {
    deps.stderr?.('store-open-failed');
    return 1;
  }
  try {
    const admission = (deps.admitted ?? (() => defaultAdmission(deps.dbPath)))();
    if (!admission.ok) {
      deps.stderr?.(admission.code ?? 'lifecycle-refused');
      return 3;
    }

    await (deps.prerequisites ?? ((name, connection) => defaultPrerequisites(name, connection, deps.dbPath, deps.piAgentDir)))(providerName, db);
    const gate = deps.provider ?? loadedProvider(providerName);
    await gate.prerequisites?.();
    const credential = await gate.read();
    if (!credential || typeof credential.token !== 'string' || !credential.token || typeof credential.accountId !== 'string' || !credential.accountId) {
      deps.stderr?.('credential-unavailable');
      return 1;
    }

    try {
      recordEvidence(db, providerName, credential, deps.sqlTrace);
    } catch (error) {
      (deps.evidenceGap ?? ((name) => appendEvidenceGap(deps.dbPath, name)))(providerName, error);
      deps.stderr?.(`qlb gate ${providerName}: pi:evidence-gap`);
    }
    // The complete response shares the only unredacted channel. No ordinary
    // stdout/error path receives credential material.
    deps.deliver(JSON.stringify(credential));
    return 0;
  } catch (error) {
    deps.stderr?.(failureCode(error));
    return 1;
  } finally {
    db.close();
  }
}
