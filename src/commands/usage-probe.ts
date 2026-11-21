import type { CommandDefinition } from '../registry';
import { probeCodexUsage, type CodexUsageProbeResult } from '../usage/openai-codex';
import {
  probeKimiCodingUsage,
  type KimiCodingUsageProbeOptions,
  type KimiCodingUsageProbeResult,
} from '../usage/kimi-coding';

export interface UsageProbeCommandDeps {
  probe?: () => Promise<CodexUsageProbeResult>;
  kimiProbe?: (options?: KimiCodingUsageProbeOptions) => Promise<KimiCodingUsageProbeResult>;
  write?: (line: string) => void;
  error?: (line: string) => void;
}

const USAGE = 'qlb usage probe: expected openai-codex|kimi-coding --json [--source pi-auth (kimi-coding only)]';

/** `--source pi-auth` (P5-live) is accepted for kimi-coding only, after `--json`. */
function parseArgs(args: string[]): { provider: 'openai-codex' | 'kimi-coding'; piAuth: boolean } | undefined {
  const [provider, json, ...rest] = args;
  if (json !== '--json' || (provider !== 'openai-codex' && provider !== 'kimi-coding')) return undefined;
  if (rest.length === 0) return { provider, piAuth: false };
  if (provider === 'kimi-coding' && rest.length === 2 && rest[0] === '--source' && rest[1] === 'pi-auth') {
    return { provider, piAuth: true };
  }
  return undefined;
}

/** S52 read-only usage probe. Its output deliberately excludes bodies and credentials. */
export async function runUsageProbe(args: string[], deps: UsageProbeCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const parsed = parseArgs(args);
  if (!parsed) {
    error(USAGE);
    return 1;
  }
  // The probe option doubles as the output label: `credentialSource` appears only for pi-auth.
  const options = parsed.piAuth ? { credentialSource: 'pi-auth' as const } : undefined;

  try {
    const result = parsed.provider === 'kimi-coding'
      ? await (deps.kimiProbe ?? probeKimiCodingUsage)(options)
      : await (deps.probe ?? probeCodexUsage)();
    write(JSON.stringify({ status: result.status, source: result.source, ...options, keys: result.keys }));
    // The default probe keeps its historical exit 0; P5-live fails when no request was answered.
    return parsed.piAuth && result.status === null ? 1 : 0;
  } catch {
    // Never serialize an exception: it may include transport request details.
    write(JSON.stringify({ status: null, source: 'unknown', ...options, keys: [] }));
    return 1;
  }
}

const usageProbeCommand: CommandDefinition = {
  name: 'usage probe',
  execute: (args, ctx) => runUsageProbe(args, { write: ctx.stdout, error: ctx.stderr }),
};

export default usageProbeCommand;
