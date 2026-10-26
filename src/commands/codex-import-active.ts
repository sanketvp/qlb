import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

async function execute(args: string[], ctx: CommandContext): Promise<number> {
  const opts = parse(args);
  if (!opts) {
    ctx.stderr('usage: qlb codex import-active [--dry-run] [--json]');
    return 2;
  }

  const active = await readCodexAuthStable(codexAuthPath(ctx));
  if (active.status !== 'ok') {
    ctx.stderr(`codex import-active refused: auth.json ${active.status}`);
    return 1;
  }

  if (opts.dryRun) {
    const plan = planImportActiveCodex(active.doc);
    const result = { ...plan, dryRun: true };
    ctx.stdout(opts.json ? JSON.stringify(result) : `would import ${plan.slotId}`);
    return 0;
  }

  const store = openStore(ctx.config.dbPath);
  try {
    const admission = assertAdmitted(store, 'codex-import-active');
    if (!admission.ok) {
      ctx.stderr(`codex import-active refused: ${admission.code}`);
      return 3;
    }
    const plan = planImportActiveCodex(active.doc);
    // Attribute against the slot active_login names, not merely the live
    // identity, so S56 can move ownership when native Codex drifted.
    const activeSlotId = store.getCodexActiveLogin();
    const existing = (activeSlotId == null ? null : store.getCodexSlot(activeSlotId))
      ?? store.getCodexSlot(plan.slotId);
    if (!existing) {
      const result = importActiveCodexSlot(active.doc, {
        store,
        keychain: platformKeychain,
        piBaseline: piBaseline(ctx.config.piAuthJsonPath),
      });
      ctx.stdout(opts.json ? JSON.stringify(result) : `imported ${result.slotId}`);
      return 0;
    }

    const stored = parseCodexAuth(platformKeychain.getSync(
      qlbKeychainService('openai-codex', existing.accountId), QLB_KEYCHAIN_ACCOUNT,
    ));
    if (!stored.ok) {
      ctx.stderr('codex import-active refused: stored managed slot is malformed');
      return 3;
    }
    const attribution = await attributeLiveDocument({
      store,
      keychain: platformKeychain,
      slot: { accountId: existing.accountId, document: stored.doc, fingerprint: existing.fingerprint ?? undefined },
      live: active.doc,
      republish: (document) => writeCodexAuthAtomic(codexAuthPath(ctx), document).then(() => undefined),
    });
    const result = { ...plan, action: attribution.action };
    ctx.stdout(opts.json ? JSON.stringify(result) : `${attribution.action} ${plan.slotId}`);
    return 0;
  } finally {
    store.close();
  }
}

const command: CommandDefinition = { name: 'codex import-active', execute };
export default command;
