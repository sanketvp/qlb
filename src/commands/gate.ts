import { dirname } from 'node:path';

import { runPiGate, type PiGateProvider } from '../pi-gate';
import type { CommandContext, CommandDefinition } from '../registry';

const PROVIDERS = new Set<PiGateProvider>(['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter']);

function parse(args: string[]): PiGateProvider | null {
  const [provider, ...flags] = args;
  if (!provider || !PROVIDERS.has(provider as PiGateProvider) || flags.some((flag) => flag !== '--json')) return null;
  return provider as PiGateProvider;
}

async function execute(args: string[], ctx: CommandContext): Promise<number> {
  const provider = parse(args);
  if (!provider) {
    ctx.stderr('usage: qlb gate anthropic|openai-codex|xai|kimi-coding|openrouter [--json]');
    return 2;
  }
  return runPiGate(provider, {
    dbPath: ctx.config.dbPath,
    env: ctx.env,
    deliver: (value) => ctx.deliverSecret(value),
    stderr: ctx.stderr,
    // The core's default derives from the usual ~/.qlb location; command
    // dispatch has the authoritative configured Pi path.
    piAgentDir: dirname(ctx.config.piAuthJsonPath),
  });
}

const command: CommandDefinition = { name: 'gate', execute };
export default command;
