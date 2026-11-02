import { lstatSync, readFileSync } from 'node:fs';

import { codexFingerprint, codexIdentity, codexSlotIdFromAccessToken, readCodexAuthStable, type CodexAuthDocument } from '../codex-auth';
import { resolveCodexAuthPath } from './codex-import-active';
import type { CommandContext, CommandDefinition } from '../registry';
import { openStoreConnection, type CodexSlotLineageChainRow } from '../store';

const FINGERPRINT_PREFIX_LENGTH = 'sha256:'.length + 12;

type PiSharingStatus = 'shared' | 'separate' | 'cannot-tell' | 'no-pi-entry';

type PiSharingReport = {
  status: PiSharingStatus;
  piFingerprint?: string;
  codexFingerprint?: string;
};

function parse(args: string[]): { json: boolean } | null {
  if (args.length === 0) return { json: false };
  return args.length === 1 && args[0] === '--json' ? { json: true } : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type PiCredential = { access: string; refresh: string };
type PiCredentialRead = { text: string; credential: PiCredential } | null;

/** Read one Pi credential without ever exposing its parsed contents in an error. */
function readPiCredentialOnce(path: string): PiCredentialRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling symlink also reports ENOENT from readFileSync. It is an
    // unavailable input, not an absent Pi entry.
    try {
      lstatSync(path);
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw statError;
    }
    throw error;
  }

  let root: unknown;
  try {
    root = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Pi auth is invalid');
  }
  if (!isObject(root)) throw new Error('Pi auth is invalid');
  const entry = root['openai-codex'];
  if (entry === undefined) return null;
  if (!isObject(entry)
    || typeof entry.access !== 'string' || entry.access.length === 0
    || typeof entry.refresh !== 'string' || entry.refresh.length === 0
    || typeof entry.expires !== 'number' || !Number.isFinite(entry.expires)) {
    throw new Error('Pi OpenAI Codex entry is invalid');
  }
  return { text, credential: { access: entry.access, refresh: entry.refresh } };
}

/** Fails closed if the Pi credential changes between observations. */
function readPiCredentialStable(path: string): PiCredential | null {
  const first = readPiCredentialOnce(path);
  if (first === null) return null;
  const second = readPiCredentialOnce(path);
  if (second === null || first.text !== second.text) throw new Error('Pi auth is unstable');
  return first.credential;
}

function fingerprintPiCredential(credential: PiCredential): string {
  // codexFingerprint intentionally hashes only this field. Supplying no other
  // token value ensures this command never retains or formats credential text.
  return codexFingerprint({ tokens: { refresh_token: credential.refresh } } as CodexAuthDocument);
}

/**
 * Read-only form of Store.listCodexSlotLineageChains.  The normal Store
 * constructor runs migrations, so this probe uses a read-only SQLite handle
 * and the same lineage traversal rather than risking a QLB_HOME mutation.
 */
function listCodexSlotLineageChains(dbPath: string): CodexSlotLineageChainRow[] {
  // This must see committed rows still in SQLite's WAL. The shared store
  // opener uses a read-only connection and performs no migrations or writes.
  const db = openStoreConnection(dbPath, true);
  try {
    const slots = db.prepare(`SELECT account_id AS accountId, source, fingerprint, prev_fingerprint AS prevFingerprint
      FROM codex_slots ORDER BY account_id`).all() as Array<{
      accountId: string; source: string | null; fingerprint: string | null; prevFingerprint: string | null;
    }>;
    const transitions = db.prepare(`SELECT account_id AS accountId, from_fp AS fromFp, to_fp AS toFp
      FROM lineage_log WHERE provider = 'openai-codex' ORDER BY id`).all() as Array<{
      accountId: string; fromFp: string | null; toFp: string;
    }>;
    return slots.map((slot) => {
      const lineages = new Set<string>();
      if (slot.fingerprint) lineages.add(slot.fingerprint);
      if (slot.prevFingerprint) lineages.add(slot.prevFingerprint);
      let changed = true;
      while (changed) {
        changed = false;
        for (const edge of transitions) {
          if (edge.accountId !== slot.accountId) continue;
          if (edge.fromFp && lineages.has(edge.fromFp) && !lineages.has(edge.toFp)) {
            lineages.add(edge.toFp);
            changed = true;
          }
          if (edge.fromFp && lineages.has(edge.toFp) && !lineages.has(edge.fromFp)) {
            lineages.add(edge.fromFp);
            changed = true;
          }
        }
      }
      return { accountId: slot.accountId, source: slot.source, lineages: [...lineages] };
    });
  } finally {
    db.close();
  }
}

function fingerprintPrefix(fingerprint: string): string {
  return fingerprint.slice(0, FINGERPRINT_PREFIX_LENGTH);
}

function report(status: PiSharingStatus, piFingerprint?: string, liveFingerprint?: string): PiSharingReport {
  return {
    status,
    ...(piFingerprint ? { piFingerprint: fingerprintPrefix(piFingerprint) } : {}),
    ...(liveFingerprint ? { codexFingerprint: fingerprintPrefix(liveFingerprint) } : {}),
  };
}

function formatHuman(result: PiSharingReport): string {
  if (result.status === 'no-pi-entry') return result.status;
  return `${result.status} pi=${result.piFingerprint} codex=${result.codexFingerprint}`;
}

/** `qlb codex pi-sharing [--json]`: read-only Pi/Codex lineage comparison. */
export async function runCodexPiSharingCommand(args: string[], ctx: CommandContext): Promise<number> {
  const options = parse(args);
  if (!options) {
    ctx.stderr('usage: qlb codex pi-sharing [--json]');
    return 2;
  }

  try {
    const piCredential = readPiCredentialStable(ctx.config.piAuthJsonPath);
    if (piCredential === null) {
      const result = report('no-pi-entry');
      ctx.stdout(options.json ? JSON.stringify(result) : formatHuman(result));
      return 0;
    }

    const live = await readCodexAuthStable(resolveCodexAuthPath(ctx.env, ctx.config));
    if (live.status !== 'ok') throw new Error('live Codex auth is unavailable');
    const piFingerprint = fingerprintPiCredential(piCredential);
    const liveFingerprint = codexFingerprint(live.doc);
    const chains = listCodexSlotLineageChains(ctx.config.dbPath);
    const shared = piFingerprint === liveFingerprint || chains
      .some((slot) => slot.lineages.includes(piFingerprint) && slot.lineages.includes(liveFingerprint));
    const piAccountId = codexSlotIdFromAccessToken(piCredential.access);
    const liveAccountId = codexIdentity(live.doc);
    const status = shared
      ? 'shared'
      : piAccountId !== null && liveAccountId !== null && piAccountId !== liveAccountId
        ? 'separate'
        : 'cannot-tell';
    const result = report(status, piFingerprint, liveFingerprint);
    ctx.stdout(options.json ? JSON.stringify(result) : formatHuman(result));
    return 0;
  } catch {
    // Parsing and filesystem messages may include raw file bytes.  The probe
    // fails closed without exposing them or claiming that the logins differ.
    ctx.stderr('qlb codex pi-sharing: input unavailable');
    return 1;
  }
}

const command: CommandDefinition = { name: 'codex pi-sharing', execute: runCodexPiSharingCommand };
export default command;
