import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { tokenCallAllowed } from './commands/token';
import { loadGate } from './gate';
import { assertAdmittedInConnection } from './lifecycle';
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

type OwnerFormat = 'v1' | 'v2';

function legacyOwnerEntry(owner: Record<string, unknown>, provider: PiGateProvider): boolean {
  if (owner.owner !== 'qlb' || !Array.isArray(owner.accounts)) return false;
  return owner.accounts.some((account) => !!account && typeof account === 'object' && !Array.isArray(account)
    && (account as Record<string, unknown>).provider === provider);
}

/** Returns every writer format in this file that claims this provider. */
function ownerFormats(path: string, provider: PiGateProvider): OwnerFormat[] {
  const owner = parsedObject(path, 'owner-file-malformed');
  const formats: OwnerFormat[] = [];
  let recognized = false;
  if ('providers' in owner) {
    recognized = true;
    const providers = owner.providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
      throw new GateFailure('owner-file-malformed');
    }
    if (isPiQlbOwnerEntry((providers as Record<string, unknown>)[provider])) formats.push('v2');
  }
  if ('owner' in owner || 'accounts' in owner) {
    recognized = true;
    if (typeof owner.owner !== 'string' || !Array.isArray(owner.accounts)) {
      throw new GateFailure('owner-file-malformed');
    }
    if (legacyOwnerEntry(owner, provider)) formats.push('v1');
  }
  if (!recognized) throw new GateFailure('owner-file-malformed');
  return formats;
}

function isShadowRetainedEntry(entry: unknown): boolean {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof (entry as Record<string, unknown>).access === 'string'
    && typeof (entry as Record<string, unknown>).refresh === 'string';
}

function defaultPrerequisites(provider: PiGateProvider, db: DatabaseSync, dbPath: string, piAgentDir?: string): void {
  const agentDir = piAgentDir ?? join(dirname(dbPath), '..', '.pi', 'agent');
  const ownerPaths = [
    join(agentDir, 'qlb-owner.json'),
    join(agentDir, `qlb-owner-${provider}.json`),
  ];
  const formats = ownerPaths.flatMap((path) => existsSync(path) ? ownerFormats(path, provider) : []);
  const state = db.prepare('SELECT value FROM config WHERE key = ?').get(`pi.${provider}.state`) as { value?: unknown } | undefined;
  if (formats.length === 0) {
    if (state?.value === 'not-applicable') throw new GateFailure('provider-not-applicable');
    throw new GateFailure('owner-entry-missing');
  }

  if (provider === 'anthropic' && existsSync(join(agentDir, 'extensions', 'anthropic-pool'))) {
    throw new GateFailure('anthropic-pool-present');
  }
  // Migration's v1 Anthropic writer owns the pool only; it has no auth.json
  // entry to replace. Static-key OpenRouter has no auth.json entry either.
  if (provider === 'openrouter' || (provider === 'anthropic' && formats.includes('v1'))) return;

  const auth = parsedObject(join(agentDir, 'auth.json'), 'placeholder-missing');
  if (formats.includes('v2') && isPiPlaceholder(auth[provider])) return;
  if (formats.includes('v1') && isShadowRetainedEntry(auth[provider])) return;
  throw new GateFailure('placeholder-missing');
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

function isLifecycleRefusal(code: string): boolean {
  return code === 'undo-in-progress' || code === 'cutover-begin-in-progress'
    || /^phase=(?:pre-cutover|undoing|rolled-back|aborted)$/.test(code);
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
    const admission = assertAdmittedInConnection(db, 'gate');
    if (!admission.ok) throw new GateFailure(admission.code ?? 'lifecycle-refused');
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
      const code = failureCode(error);
      if (isLifecycleRefusal(code)) throw error;
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
    return code === 'missing-provider-gate' || isLifecycleRefusal(code) ? 3 : 1;
  } finally {
    db.close();
  }
}
