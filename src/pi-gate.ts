import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { tokenCallAllowed } from './commands/token';
import { loadGate } from './gate';
import { isPiPlaceholder, isPiQlbOwnerEntry } from './pi-migrate';
import { openStoreConnection } from './store';

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

/** A stable, value-free failure cause surfaced by a provider gate module. */
export class GateFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'GateFailure';
  }
}

export interface PiGateDeps {
  dbPath: string;
  env: NodeJS.ProcessEnv;
  deliver(value: string): void;
  /** Registers a bare credential before the JSON envelope reaches stdout. */
  registerSecret?(value: string): void;
  stderr?(message: string): void;
  guard?: (env: NodeJS.ProcessEnv) => boolean;
  /** Test seam; command dispatch performs production lifecycle admission. */
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

function parsedObject(path: string, code: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
    return value as Record<string, unknown>;
  } catch {
    throw new Error(code);
  }
}

function legacyAnthropicOwner(owner: Record<string, unknown>): boolean {
  if (owner.owner !== 'qlb' || !Array.isArray(owner.accounts)) return false;
  return owner.accounts.some((account) => !!account && typeof account === 'object' && !Array.isArray(account)
    && (account as Record<string, unknown>).provider === 'anthropic');
}

function defaultPrerequisites(provider: PiGateProvider, db: DatabaseSync, dbPath: string, piAgentDir?: string): void {
  const state = db.prepare('SELECT value FROM config WHERE key = ?').get(`pi.${provider}.state`) as { value?: unknown } | undefined;
  if (state?.value === 'not-applicable') throw new GateFailure('provider-not-applicable');

  const agentDir = piAgentDir ?? join(dirname(dbPath), '..', '.pi', 'agent');
  const ownerPath = join(agentDir, 'qlb-owner.json');
  if (!existsSync(ownerPath)) throw new GateFailure('owner-entry-missing');
  const owner = parsedObject(ownerPath, 'owner-file-malformed');
  if (provider === 'anthropic') {
    // The current Anthropic writer is Migration's legacy OwnerFile. Its
    // account metadata is the provider ownership record; it writes no Pi
    // auth.json placeholder, unlike the P7a single-provider writer.
    if (!legacyAnthropicOwner(owner)) throw new GateFailure('owner-entry-missing');
    if (existsSync(join(agentDir, 'extensions', 'anthropic-pool'))) {
      throw new GateFailure('anthropic-pool-present');
    }
    return;
  }

  const providers = owner.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) throw new GateFailure('owner-file-malformed');
  if (!isPiQlbOwnerEntry((providers as Record<string, unknown>)[provider])) {
    throw new GateFailure('owner-entry-missing');
  }
  if (provider === 'openrouter') return;
  const auth = parsedObject(join(agentDir, 'auth.json'), 'placeholder-missing');
  if (!isPiPlaceholder(auth[provider])) throw new GateFailure('placeholder-missing');
}

const SAFE_FAILURE_CODES = new Set([
  'owner-entry-missing', 'owner-file-malformed', 'placeholder-missing', 'anthropic-pool-present',
  'provider-not-applicable', 'missing-provider-gate', 'credential-unavailable',
]);

function failureCode(error: unknown): string {
  if (error instanceof GateFailure && /^[a-z][a-z0-9-]*$/.test(error.code)) return error.code;
  const value = error instanceof Error ? error.message : '';
  return SAFE_FAILURE_CODES.has(value) || /^phase=(?:pre-cutover|undoing|rolled-back|aborted)$/.test(value)
    ? value
    : 'credential-unavailable';
}

function loadedProvider(provider: PiGateProvider): ProviderGate {
  let loaded: unknown;
  try {
    loaded = loadGate(provider);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'MODULE_NOT_FOUND') {
      throw new GateFailure('missing-provider-gate');
    }
    throw error;
  }
  const gate = (loaded && typeof loaded === 'object' && 'default' in loaded ? loaded.default : loaded) as Partial<ProviderGate>;
  if (!gate || typeof gate.read !== 'function') throw new GateFailure('missing-provider-gate');
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
    // runExecutingCommand has already admitted production calls. Keeping this
    // seam preserves direct-core tests without opening another Store.
    const admission = (deps.admitted ?? (() => ({ ok: true })))();
    if (!admission.ok) {
      deps.stderr?.(admission.code ?? 'lifecycle-refused');
      return 3;
    }

    await (deps.prerequisites ?? ((name, connection) => defaultPrerequisites(name, connection, deps.dbPath, deps.piAgentDir)))(providerName, db);
    const gate = deps.provider ?? loadedProvider(providerName);
    await gate.prerequisites?.();
    const credential = await gate.read();
    if (!credential || typeof credential.token !== 'string' || !credential.token ||
        typeof credential.accountId !== 'string' || !credential.accountId ||
        typeof credential.source !== 'string' || !credential.source) {
      deps.stderr?.('credential-unavailable');
      return 1;
    }
    // This is the complete S30-authorized output shape. Provider modules may
    // retain grants or refresh metadata internally, but none crosses stdout.
    const delivered: GateCredential = {
      token: credential.token,
      accountId: credential.accountId,
      source: credential.source,
    };
    if (typeof credential.chatgptAccountId === 'string') delivered.chatgptAccountId = credential.chatgptAccountId;
    if (typeof credential.expiresAt === 'number' && Number.isFinite(credential.expiresAt)) delivered.expiresAt = credential.expiresAt;

    try {
      recordEvidence(db, providerName, delivered, deps.sqlTrace);
    } catch (error) {
      (deps.evidenceGap ?? ((name) => appendEvidenceGap(deps.dbPath, name)))(providerName, error);
      deps.stderr?.(`qlb gate ${providerName}: pi:evidence-gap`);
    }
    // The complete response shares the only unredacted channel. No ordinary
    // stdout/error path receives credential material.
    deps.registerSecret?.(delivered.token);
    deps.deliver(JSON.stringify(delivered));
    return 0;
  } catch (error) {
    const code = failureCode(error);
    deps.stderr?.(code);
    return code === 'missing-provider-gate' ? 3 : 1;
  } finally {
    db.close();
  }
}
