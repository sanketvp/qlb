import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { withCodexAuthLock, type CodexAuthLockOptions } from '../cc-locks';
import { attributeLiveDocument } from '../codex-attribution';
import { importActiveCodexSlot, planImportActiveCodex } from '../codex-slots';
import { parseCodexAuth, readCodexAuthStable, writeCodexAuthAtomic } from '../codex-auth';
import { QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../keychain';
import { assertAdmitted } from '../lifecycle';
import { platformKeychain } from '../keychain';
import { openStore } from '../store';
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
  withAuthLock: <T>(options: CodexAuthLockOptions, fn: () => Promise<T> | T) => Promise<T>;
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

  // Keep the live read through active-login marking in one QLB-owned critical
  // section. In particular, the lock remains held after SQLite's re-validation
  // commit while attributeLiveDocument republishes a repaired slot.
  return deps.withAuthLock({ home: ctx.home, env: ctx.env }, async () => {
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
        const result = importActiveCodexSlot(active.doc, {
          store,
          keychain: platformKeychain,
          piBaseline: piBaseline(ctx.config.piAuthJsonPath),
        });
        ctx.stdout(opts.json ? JSON.stringify(result) : `imported ${result.slotId}`);
        return 0;
      }

      const activeSlotId = store.getCodexActiveLogin();
      const stored = parseCodexAuth(platformKeychain.getSync(
        qlbKeychainService('openai-codex', ownSlot.accountId), QLB_KEYCHAIN_ACCOUNT,
      ));
      if (!stored.ok) {
        ctx.stderr('codex import-active refused: stored managed slot is malformed');
        return 3;
      }
      const attribution = await attributeLiveDocument({
        store,
        keychain: platformKeychain,
        slot: { accountId: ownSlot.accountId, document: stored.doc, fingerprint: ownSlot.fingerprint ?? undefined },
        activeSlotId: activeSlotId != null && store.getCodexSlot(activeSlotId) ? activeSlotId : undefined,
        live: active.doc,
        republish: (document) => deps.writeAuth(path, document).then(() => undefined),
      });
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
