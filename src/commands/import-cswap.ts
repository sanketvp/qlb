import { dirname, join } from 'node:path';

import { claudePaths } from '../cc-paths';
import { withClaudeConfigPathLock, withClaudeCredentialLocks } from '../cc-locks';
import { SqliteClaudeSlotRepository } from '../cc-slots';
import { CswapImportRefusalError, importCswap, planCswapImport } from '../cswap-import';
import { readClaudeConfig, readLiveClaudeCredentials } from '../cc-credentials';
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

function configuredOauthAccountId(path: string): string | null {
  const oauth = readClaudeConfig(path).oauthAccount;
  if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) return null;
  const record = oauth as Record<string, unknown>;
  const accountId = record.accountUuid ?? record.account_id;
  return typeof accountId === 'string' && accountId ? accountId : null;
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
    // Resolve once: Claude's legacy/global selection is filesystem-dependent,
    // so every lock and read below must use this exact path.
    const paths = claudePaths({ home: ctx.home, env: ctx.env });
    const withLiveStateLocks = <T,>(fn: () => Promise<T> | T) => withClaudeCredentialLocks({ home: ctx.home, env: ctx.env }, () =>
      withClaudeConfigPathLock(paths.globalConfigPath, { home: ctx.home, env: ctx.env }, fn));
    const readLiveSnapshot = async () => ({
      credential: await readLiveClaudeCredentials({ backend: platformKeychain, paths, env: ctx.env }),
      // Claude's Keychain OAuth blob intentionally has no account UUID. The
      // config identity and credential are read under the enclosing lock hold.
      accountId: configuredOauthAccountId(paths.globalConfigPath),
    });
    const result = await importCswap({ ...base, liveSnapshot: readLiveSnapshot, withLiveStateLocks });
    print(ctx, { ...result.plan, runId: result.runId, phase: result.phase }, opts.json);
    return 0;
  } catch (error) {
    // Credential values are never reflected in the importer's errors. Do not
    // render arbitrary backend errors, which may contain sensitive bytes.
    if (error instanceof CswapImportRefusalError) {
      ctx.stderr(`import cswap refused: ${error.code}`);
      return 3;
    }
    ctx.stderr('import cswap failed');
    return 1;
  } finally {
    repository.close();
    store.close();
  }
}

const command: CommandDefinition = { name: 'import cswap', execute };
export default command;
