import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';

import {
  consumeCodexSlot,
  hasCodexSlotIdentity,
  type CodexConsumeResult,
  type CodexRefreshResponse,
} from '../codex-consume';
import { codexIdentity } from '../codex-auth';
import { list, renewers, type CodexLiveObservation, type CodexSwitchLogRow } from '../codex-sessions';
import { CodexSlots } from '../codex-slots';
import { ClaudeCodeLockTimeout, withProperLockfile } from '../cc-locks';
import { platformKeychain } from '../keychain';
import { openStore, type Store } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';

interface Parsed {
  accountId: string;
  force: boolean;
  c9: boolean;
  json: boolean;
}

interface CommandConsumeInput {
  accountId: string;
  force: boolean;
  allowHeld: boolean;
  c9: boolean;
}

export interface CodexRefreshCommandDeps {
  getConfig: (key: string) => string | null;
  consume: (input: CommandConsumeInput) => Promise<CodexConsumeResult>;
  /** Test seam for the active-login guard; production reads it under the locks. */
  isActive?: (accountId: string) => boolean;
  write?: (line: string) => void;
  error?: (line: string) => void;
}

function parse(args: string[]): Parsed | null {
  if (args.length < 2 || args.length > 4) return null;
  const [accountId, ...flags] = args;
  if (!accountId || !flags.includes('--force') || new Set(flags).size !== flags.length
    || flags.some((flag) => flag !== '--force' && flag !== '--c9' && flag !== '--json')) return null;
  return { accountId, force: true, c9: flags.includes('--c9'), json: flags.includes('--json') };
}

/** S47 permits its holder bypass only for the outstanding, recorded C9 proof. */
function c9Allowed(getConfig: (key: string) => string | null): boolean {
  const aJwtExp = getConfig('codex.l13.aJwtExp');
  return aJwtExp !== null && aJwtExp.length > 0 && getConfig('codex.l13VerifiedAt') === null;
}

/** Testable command boundary; output deliberately contains no credential material. */
export async function runCodexRefreshCommand(args: string[], deps: CodexRefreshCommandDeps): Promise<number> {
  const parsed = parse(args);
  const write = deps.write ?? console.log;
  const error = deps.error ?? console.error;
  if (!parsed) {
    error('usage: qlb codex refresh <slot-id> --force [--c9] [--json]');
    return 2;
  }
  if (deps.isActive?.(parsed.accountId)) {
    error('codex refresh refused: active-slot');
    return 3;
  }
  if (parsed.c9 && !c9Allowed(deps.getConfig)) {
    error('codex refresh refused: c9-unavailable');
    return 3;
  }

  const result = await deps.consume({
    accountId: parsed.accountId,
    force: parsed.force,
    allowHeld: parsed.c9,
    c9: parsed.c9,
  });
  const output = { accountId: parsed.accountId, status: result.status };
  write(parsed.json ? JSON.stringify(output) : `${parsed.accountId}: ${result.status}`);
  if (result.stashId) error(`codex refresh successor stash: ${result.stashId}`);
  if (result.status === 'successor-unpersisted') {
    error('codex refresh failed: successor-unpersisted');
  }
  if (result.status === 'c9-unavailable' || result.status === 'active-slot') return 3;
  // S47's receipt exists only after the forced POST committed with its metadata.
  if (parsed.c9) return result.status === 'refreshed' ? 0 : 1;
  return result.status === 'refreshed' || result.status === 'fresh' || result.status === 'codex-won-inactive' ? 0 : 1;
}

function withHistory<T>(store: Pick<Store, 'dbPath'>, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(store.dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

function history(store: Pick<Store, 'dbPath'>): { rows: CodexSwitchLogRow[]; observations: CodexLiveObservation[] } {
  return withHistory(store, (db) => ({
    rows: db.prepare(`SELECT id, provider, from_account, to_account, outcome, published_at, ts
      FROM switch_log WHERE provider = 'openai-codex' ORDER BY published_at, ts, id`).all()
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: Number(r.id), provider: String(r.provider),
          fromAccountId: typeof r.from_account === 'string' ? r.from_account : null,
          toAccountId: String(r.to_account), outcome: r.outcome as CodexSwitchLogRow['outcome'],
          publishedAt: typeof r.published_at === 'number' ? r.published_at : null,
          attemptedAt: typeof r.ts === 'number' ? r.ts : null,
        };
      }),
    observations: db.prepare('SELECT ts, identity, lineage_fp, by FROM codex_live_observations ORDER BY ts, id').all()
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          ts: Number(r.ts), identity: typeof r.identity === 'string' ? r.identity : null,
          lineageFp: typeof r.lineage_fp === 'string' ? r.lineage_fp : null,
          by: String(r.by),
        };
      }),
  }));
}

async function sendRefresh(request: { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }): Promise<CodexRefreshResponse> {
  const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
  return { status: response.status, body: await response.text() };
}

function activeCodexSlot(store: Store): string | null {
  return withHistory(store, (db) => {
    const row = db.prepare("SELECT account_id FROM active_login WHERE provider = 'openai-codex'").get() as { account_id?: string | null } | undefined;
    return typeof row?.account_id === 'string' ? row.account_id : null;
  });
}

async function execute(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parse(args);
  if (!parsed) return runCodexRefreshCommand(args, {
    getConfig: () => null,
    consume: async () => ({ status: 'transient' }),
    write: ctx.stdout,
    error: ctx.stderr,
  });

  const store = openStore(ctx.config.dbPath);
  try {
    const slots = new CodexSlots({ keychain: platformKeychain });
    return runCodexRefreshCommand(args, {
      getConfig: store.getConfig.bind(store),
      isActive: (accountId) => activeCodexSlot(store) === accountId,
      write: ctx.stdout,
      error: ctx.stderr,
      consume: async ({ accountId, force, allowHeld, c9 }) => {
        // C6 and C10 share this provider lock for every read/CAS/write. The
        // consume lock additionally ensures only one process can spend a slot.
        const locks = join(dirname(store.dbPath), 'locks');
        const consumeLock = join(locks, `consume-openai-codex-${encodeURIComponent(accountId)}.lock`);
        const switchLock = join(locks, 'switch-openai-codex.lock');
        try {
          return await withProperLockfile(consumeLock, { timeoutMs: 10_000 }, async () =>
            withProperLockfile(switchLock, { timeoutMs: 10_000 }, async () => {
              // Re-check every mutable receipt and active state after lock acquisition.
              if (activeCodexSlot(store) === accountId) return { status: 'active-slot' as const };
              if (c9 && !c9Allowed(store.getConfig.bind(store))) return { status: 'c9-unavailable' as const };
              let snapshot;
              try { snapshot = slots.readSlot(accountId, { fresh: true }).document; } catch { return { status: 'slot-removed' as const }; }
              if (!hasCodexSlotIdentity(snapshot, accountId)) return { status: 'slot-removed' as const };
              return consumeCodexSlot({
                accountId, snapshot, trigger: 'force', force, allowHeld, slots, store, transport: sendRefresh,
                holders: async (document) => {
                  const identity = codexIdentity(document);
                  if (!identity) throw new Error('Codex slot identity is invalid');
                  const separator = identity.indexOf(':');
                  const prior = history(store);
                  return renewers(
                    { chatgpt_user_id: identity.slice(0, separator), account_id: identity.slice(separator + 1) },
                    await list(), prior.rows, prior.observations,
                  );
                },
              });
            }));
        } catch (error) {
          // `busy` means no consume work ran. Do not hide a post-POST
          // persistence failure behind lock contention.
          if (error instanceof ClaudeCodeLockTimeout) return { status: 'busy' };
          throw error;
        }
      },
    });
  } finally {
    store.close();
  }
}

const command: CommandDefinition = { name: 'codex refresh', execute };
export default command;
