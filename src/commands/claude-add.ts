import { join } from 'node:path';

import { addClaudeLogin, type ClaudeAddInput, type ClaudeAddResult } from '../cc-add';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../cc-slots';
import { claudePaths } from '../cc-paths';
import { readClaudeConfig, readLiveClaudeCredentials } from '../cc-credentials';
import { qlbHomeDir } from '../home';
import { platformKeychain } from '../keychain';
import { assertAdmitted } from '../lifecycle';
import type { CommandContext, CommandDefinition } from '../registry';
import { openStore } from '../store';

export interface ClaudeAddCommandDeps {
  readLive(): Promise<Pick<ClaudeAddInput, 'credential' | 'config'>>;
  add(input: Omit<ClaudeAddInput, 'credential' | 'config' | 'replace' | 'alias' | 'slots'> & {
    credential: string;
    config: unknown;
    replace?: string;
    alias?: string;
  }): Promise<ClaudeAddResult>;
}

type ParsedArgs = { replace?: string; alias?: string };

function parse(args: string[]): ParsedArgs | null {
  const result: ParsedArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if ((flag !== '--replace' && flag !== '--alias') || i + 1 >= args.length) return null;
    const value = args[++i];
    if (!value || value.startsWith('--') || (flag === '--replace' && /[\0/\\:]/.test(value))) return null;
    if (flag === '--replace') {
      if (result.replace != null) return null;
      result.replace = value;
    } else {
      if (result.alias != null) return null;
      result.alias = value;
    }
  }
  return result;
}

function defaultDeps(ctx: CommandContext): ClaudeAddCommandDeps {
  const paths = claudePaths({ home: ctx.home, env: ctx.env });
  return {
    async readLive() {
      return {
        credential: await readLiveClaudeCredentials({ backend: platformKeychain, paths }),
        config: readClaudeConfig(paths.globalConfigPath),
      };
    },
    async add(input) {
      // Open this only after the live read succeeds, so a read failure cannot
      // retain a database handle. Store owns migrations before the slot adapter.
      const store = openStore(ctx.config.dbPath);
      store.close();
      const repository = SqliteClaudeSlotRepository.open(ctx.config.dbPath);
      const slots = new ClaudeSlots({
        backend: platformKeychain,
        repository,
        stashDir: join(qlbHomeDir(ctx.env), '.qlb', 'unclaimed'),
      });
      try {
        return await addClaudeLogin({ ...input, slots });
      } finally {
        repository.close();
      }
    },
  };
}

/** `qlb claude add [--replace <id>] [--alias <a>]` (§4.13 / AC32). */
export async function runClaudeAddCommand(
  args: string[],
  ctx: CommandContext,
  dependencies?: ClaudeAddCommandDeps,
): Promise<number> {
  const parsed = parse(args);
  if (!parsed) {
    ctx.stderr('usage: qlb claude add [--replace <id>] [--alias <a>]');
    return 2;
  }

  const store = openStore(ctx.config.dbPath);
  try {
    const admission = assertAdmitted(store, 'claude-add');
    if (!admission.ok) {
      ctx.stderr(`qlb claude add: refused: ${admission.code}`);
      return 3;
    }
  } finally {
    store.close();
  }

  const deps = dependencies ?? defaultDeps(ctx);
  try {
    const live = await deps.readLive();
    // Register before add() can throw, so the normal registry boundary can redact
    // any unexpected backend error without ever rendering the credential.
    ctx.registerSecret(live.credential);
    const result = await deps.add({ ...live, replace: parsed.replace, alias: parsed.alias });
    ctx.stdout(`${result.kind === 'added' ? 'added' : 'replaced'} Claude account ${result.accountId}`);
    return 0;
  } catch (error) {
    // Errors emitted by cc-add are deliberately payload-free. Do not pass through
    // backend/file errors, which could contain credential or path fragments.
    const message = error instanceof Error && /^(active Claude login is an API key|Claude config has no |invalid |Claude slot already exists|replace target belongs|Claude replace slot not found)/.test(error.message)
      ? error.message
      : 'could not add active Claude login';
    ctx.stderr(`qlb claude add: refused: ${message}`);
    return 3;
  }
}

const command: CommandDefinition = { name: 'claude add', execute: runClaudeAddCommand };
export default command;
