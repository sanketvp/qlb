import { dirname } from 'node:path';

import { runPiGate, type PiGateProvider } from '../pi-gate';
import type { CommandContext, CommandDefinition } from '../registry';

const PROVIDERS = new Set<PiGateProvider>(['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter']);

const ACCESS_FINGERPRINT = /^sha256-at:[a-f0-9]{64}$/;

function parse(args: string[]): { provider: PiGateProvider; retryAfter401Fp?: string } | null {
  const [provider, ...flags] = args;
  if (!provider || !PROVIDERS.has(provider as PiGateProvider)) return null;
  let retryAfter401Fp: string | undefined;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === '--json') continue;
    if (flag === '--retry-after-401' && retryAfter401Fp === undefined) {
      const value = flags[index + 1];
      if (!value || !ACCESS_FINGERPRINT.test(value)) return null;
      retryAfter401Fp = value;
      index += 1;
      continue;
    }
    return null;
  }
  return { provider: provider as PiGateProvider, ...(retryAfter401Fp === undefined ? {} : { retryAfter401Fp }) };
}

async function execute(args: string[], ctx: CommandContext): Promise<number> {
  const provider = parse(args);
  if (!provider) {
    ctx.stderr('usage: qlb gate anthropic|openai-codex|xai|kimi-coding|openrouter [--json] [--retry-after-401 sha256-at:…]');
    return 2;
  }
  return runPiGate(provider.provider, {
    dbPath: ctx.config.dbPath,
    env: ctx.env,
    deliver: (value) => ctx.deliverSecret(value),
    registerSecret: ctx.registerSecret,
    stderr: ctx.stderr,
    // The core's default derives from the usual ~/.qlb location; command
    // dispatch has the authoritative configured Pi path.
    piAgentDir: dirname(ctx.config.piAuthJsonPath),
    ...(provider.retryAfter401Fp === undefined ? {} : { retryAfter401Fp: provider.retryAfter401Fp }),
  });
}

const command: CommandDefinition = { name: 'gate', execute };
export default command;
