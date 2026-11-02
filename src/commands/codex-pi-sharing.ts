import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { codexFingerprint, readCodexAuthStable, type CodexAuthDocument } from '../codex-auth';
import { resolveCodexAuthPath } from './codex-import-active';
import type { CommandContext, CommandDefinition } from '../registry';
import type { CodexSlotLineageChainRow } from '../store';

const FINGERPRINT_PREFIX_LENGTH = 'sha256:'.length + 12;

type PiSharingStatus = 'shared' | 'separate' | 'no-pi-entry';

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

/** Reads only the Pi entry's refresh token long enough to derive its fingerprint. */
function readPiFingerprint(path: string): string | null {
  let root: unknown;
  try {
    root = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
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
  // codexFingerprint intentionally hashes only this field. Supplying no other
  // token value ensures this command never retains or formats credential text.
  return codexFingerprint({ tokens: { refresh_token: entry.refresh } } as CodexAuthDocument);
}

/**
 * Read-only form of Store.listCodexSlotLineageChains.  The normal Store
 * constructor runs migrations, so this probe uses a read-only SQLite handle
 * and the same lineage traversal rather than risking a QLB_HOME mutation.
 */
function listCodexSlotLineageChains(dbPath: string): CodexSlotLineageChainRow[] {
  if (!existsSync(dbPath)) return [];
  // immutable=1 prevents SQLite from creating WAL/SHM sidecars for this
  // inspection. The probe deliberately takes no lock and never writes.
  const db = new DatabaseSync(`${pathToFileURL(dbPath).href}?immutable=1`, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const slots = db.prepare(`SELECT account_id AS accountId, source, fingerprint, prev_fingerprint AS prevFingerprint
      FROM codex_slots WHERE archived_at IS NULL AND dead = 0 ORDER BY account_id`).all() as Array<{
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
    const piFingerprint = readPiFingerprint(ctx.config.piAuthJsonPath);
    if (piFingerprint === null) {
      const result = report('no-pi-entry');
      ctx.stdout(options.json ? JSON.stringify(result) : formatHuman(result));
      return 0;
    }

    const live = await readCodexAuthStable(resolveCodexAuthPath(ctx.env, ctx.config));
    if (live.status !== 'ok') throw new Error('live Codex auth is unavailable');
    const liveFingerprint = codexFingerprint(live.doc);
    const shared = piFingerprint === liveFingerprint || listCodexSlotLineageChains(ctx.config.dbPath)
      .some((slot) => slot.lineages.includes(piFingerprint) && slot.lineages.includes(liveFingerprint));
    const result = report(shared ? 'shared' : 'separate', piFingerprint, liveFingerprint);
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
