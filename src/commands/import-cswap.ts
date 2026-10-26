import { dirname, join } from 'node:path';

import { claudePaths } from '../cc-paths';
import { SqliteClaudeSlotRepository } from '../cc-slots';
import { importCswap, planCswapImport } from '../cswap-import';
import { readLiveClaudeCredentials } from '../cc-credentials';
import { assertAdmitted } from '../lifecycle';
import { isSuccessor } from '../lineage-log';
import { platformKeychain } from '../keychain';
import { openStore } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';

function parse(args: string[]): { dryRun: boolean; replace: boolean; json: boolean } | null {
  const allowed = new Set(['--dry-run', '--replace', '--json']);
  if (args.some((arg) => !allowed.has(arg)) || new Set(args).size !== args.length) return null;
  return { dryRun: args.includes('--dry-run'), replace: args.includes('--replace'), json: args.includes('--json') };
}

function print(ctx: CommandContext, value: unknown, json: boolean): void {
  if (json) ctx.stdout(JSON.stringify(value));
  else {
    const plan = value as { slots: unknown[]; keychainItems: number; encFiles: number };
    ctx.stdout(`slots=${plan.slots.length}; keychainItems=${plan.keychainItems}; encFiles=${plan.encFiles}`);
  }
}

async function execute(args: string[], ctx: CommandContext): Promise<number> {
  const opts = parse(args);
  if (!opts) {
    ctx.stderr('usage: qlb import cswap [--dry-run] [--replace] [--json]');
    return 2;
  }

  const store = openStore(ctx.config.dbPath);
  const admission = assertAdmitted(store, opts.dryRun ? 'import-cswap:dry-run' : 'import-cswap');
  if (!admission.ok) {
    store.close();
    ctx.stderr(`import cswap refused: ${admission.code}`);
    return 3;
  }

  let repository: SqliteClaudeSlotRepository;
  try {
    repository = SqliteClaudeSlotRepository.open(ctx.config.dbPath);
  } catch {
    store.close();
    ctx.stderr('import cswap failed');
    return 1;
  }
  try {
    const base = {
      backupDir: dirname(ctx.config.cswapSequencePath),
      journalDir: join(ctx.home, '.qlb', 'backups'),
      keychain: platformKeychain,
      repository,
      replace: opts.replace,
      isSuccessor: (accountId: string, ancestor: string, descendant: string) =>
        isSuccessor(store, 'anthropic', accountId, ancestor, descendant),
    };
    if (opts.dryRun) {
      const plan = await planCswapImport(base);
      print(ctx, { ...plan, dryRun: true }, opts.json);
      return 0;
    }
    const paths = claudePaths({ home: ctx.home, env: ctx.env });
    const result = await importCswap({
      ...base,
      liveCredential: () => readLiveClaudeCredentials({ backend: platformKeychain, paths, env: ctx.env }),
    });
    print(ctx, { ...result.plan, runId: result.runId, phase: result.phase }, opts.json);
    return 0;
  } catch (error) {
    // Credential values are never reflected in the importer's errors. Do not
    // render arbitrary backend errors, which may contain sensitive bytes.
    ctx.stderr('import cswap failed');
    return 1;
  } finally {
    repository.close();
    store.close();
  }
}

const command: CommandDefinition = { name: 'import cswap', execute };
export default command;
