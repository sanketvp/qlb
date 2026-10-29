import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { withCodexAuthLock, type CodexAuthLockOptions, type HeldCodexAuthLock } from '../cc-locks';
import { attributeLiveDocument } from '../codex-attribution';
import { importActiveCodexSlot, planImportActiveCodex } from '../codex-slots';
import { CodexAdmissionRefused, codexAdmission, ensureCodexSlotAccount, rekeyCodexAccounts, type RekeySummary } from '../codex-rekey';
import { recordRestoreBaseline } from '../codex-restore-baseline';
import { parseCodexAuth, readCodexAuthStable, writeCodexAuthAtomic } from '../codex-auth';
import { QLB_KEYCHAIN_ACCOUNT, platformKeychain, qlbKeychainService, type KeychainBackend } from '../keychain';
import { assertAdmitted } from '../lifecycle';
import { openStore, type Store } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';

function parse(args: string[]): { dryRun: boolean; json: boolean } | null {
  if (args.some((arg) => arg !== '--dry-run' && arg !== '--json') || new Set(args).size !== args.length) return null;
  return { dryRun: args.includes('--dry-run'), json: args.includes('--json') };
}

function codexAuthPath(ctx: CommandContext): string {
  return ctx.env.CODEX_HOME ? join(ctx.env.CODEX_HOME, 'auth.json') : ctx.config.codexAuthJsonPath;
}

/** Reads only the Pi OpenAI Codex entry; malformed/absent input is no match. */
function piBaseline(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return (parsed as Record<string, unknown>)['openai-codex'];
  } catch {
    return undefined;
  }
}

export interface CodexImportActiveCommandDeps {
  readAuth: typeof readCodexAuthStable;
  writeAuth: typeof writeCodexAuthAtomic;
  withAuthLock: <T>(options: CodexAuthLockOptions, fn: (held: HeldCodexAuthLock) => Promise<T> | T) => Promise<T>;
  /** Injectable so command tests never reach the platform Keychain. */
  keychain?: KeychainBackend;
}

/** Read-only view of the store for the admission pre-check, which must write nothing. */
function withReadOnlyDatabase<T>(store: Pick<Store, 'dbPath'>, fn: (db: DatabaseSync) => T): T {
  if (store.dbPath === ':memory:') return fn((store as unknown as { db: DatabaseSync }).db);
  const db = new DatabaseSync(store.dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

const defaultDeps: CodexImportActiveCommandDeps = {
  readAuth: readCodexAuthStable,
  writeAuth: writeCodexAuthAtomic,
  withAuthLock: withCodexAuthLock,
};

export async function runCodexImportActiveCommand(
  args: string[],
  ctx: CommandContext,
  deps: CodexImportActiveCommandDeps = defaultDeps,
): Promise<number> {
  const opts = parse(args);
  if (!opts) {
    ctx.stderr('usage: qlb codex import-active [--dry-run] [--json]');
    return 2;
  }

  const path = codexAuthPath(ctx);
  if (opts.dryRun) {
    const active = await deps.readAuth(path);
    if (active.status !== 'ok') {
      ctx.stderr(`codex import-active refused: auth.json ${active.status}`);
      return 1;
    }
    const plan = planImportActiveCodex(active.doc);
    const result = { ...plan, dryRun: true };
    ctx.stdout(opts.json ? JSON.stringify(result) : `would import ${plan.slotId}`);
    return 0;
  }

  // Read at call time so a swapped platformKeychain export still applies.
  const keychain = deps.keychain ?? platformKeychain;

  // Keep the live read through active-login marking in one QLB-owned critical
  // section. In particular, the lock remains held after SQLite's re-validation
  // commit while attributeLiveDocument republishes a repaired slot.
  return deps.withAuthLock({ home: ctx.home, env: ctx.env }, async (held) => {
    const active = await deps.readAuth(path);
    if (active.status !== 'ok') {
      ctx.stderr(`codex import-active refused: auth.json ${active.status}`);
      return 1;
    }

    const store = openStore(ctx.config.dbPath);
    try {
      const admission = assertAdmitted(store, 'codex-import-active');
      if (!admission.ok) {
        ctx.stderr(`codex import-active refused: ${admission.code}`);
        return 3;
      }
      const plan = planImportActiveCodex(active.doc);
      // The live document's identity decides whether this is a new import. An
      // existing active_login names a different account during ordinary drift;
      // it must not prevent a newly logged-in account from becoming a slot.
      const ownSlot = store.getCodexSlot(plan.slotId);
      if (!ownSlot) {
        held.assertNotCompromised();
        const result = importActiveCodexSlot(active.doc, {
          store,
          keychain,
          piBaseline: piBaseline(ctx.config.piAuthJsonPath),
        });
        ctx.stdout(opts.json ? JSON.stringify(result) : `imported ${result.slotId}`);
        return 0;
      }

      const preliminaryRefusal = withReadOnlyDatabase(store, (db) => codexAdmission(db, {
        slotId: plan.slotId,
        bareAccountId: plan.accountId,
      }));
      if (preliminaryRefusal) {
        ctx.stderr(`codex import-active refused: ${preliminaryRefusal.message}`);
        return 3;
      }

      const activeSlotId = store.getCodexActiveLogin();
      const stored = parseCodexAuth(keychain.getSync(
        qlbKeychainService('openai-codex', ownSlot.accountId), QLB_KEYCHAIN_ACCOUNT,
      ));
      if (!stored.ok) {
        ctx.stderr('codex import-active refused: stored managed slot is malformed');
        return 3;
      }
      let summary: RekeySummary | undefined;
      let attribution;
      try {
        attribution = await attributeLiveDocument({
          store,
          keychain,
          slot: { accountId: ownSlot.accountId, document: stored.doc, fingerprint: ownSlot.fingerprint ?? undefined },
          activeSlotId: activeSlotId != null && store.getCodexSlot(activeSlotId) ? activeSlotId : undefined,
          live: active.doc,
          assertNotCompromised: () => held.assertNotCompromised(),
          republish: (document) => {
            // Keychain/SQLite work can block the event loop long enough for a
            // stale takeover. Do not recreate auth.json after losing this lease.
            held.assertNotCompromised();
            return deps.writeAuth(path, document).then(() => undefined);
          },
          beforeSave: (db, dbPath, slotId) => {
            const refusal = codexAdmission(db, { slotId, bareAccountId: plan.accountId });
            if (refusal) throw new CodexAdmissionRefused(refusal.code, refusal.message);
            const now = Date.now();
            summary = rekeyCodexAccounts(db, { dbPath, now });
            ensureCodexSlotAccount(db, slotId, now);
            return undefined;
          },
          beforeSaveCommit: (db, kind) => {
            if (summary?.backupTaken) {
              recordRestoreBaseline(db, { saveKind: kind, backupPath: summary.backupTaken, keychain });
            }
            return undefined;
          },
        });
      } catch (error) {
        if (error instanceof CodexAdmissionRefused) {
          ctx.stderr(`codex import-active refused: ${error.message}`);
          return 3;
        }
        throw error;
      }
      if (attribution.action === 'slot-split' || attribution.disposition === 'slot-split') {
        ctx.stderr('codex import-active refused: slot-split');
        return 3;
      }
      const result = { ...plan, action: attribution.action };
      ctx.stdout(opts.json ? JSON.stringify(result) : `${attribution.action} ${plan.slotId}`);
      return 0;
    } finally {
      store.close();
    }
  });
}

const command: CommandDefinition = { name: 'codex import-active', execute: runCodexImportActiveCommand };
export default command;
