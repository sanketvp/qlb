import type { CommandDefinition } from '../registry';
import { probeCodexUsage, type CodexUsageProbeResult } from '../usage/openai-codex';
import { probeKimiCodingUsage, type KimiCodingUsageProbeResult } from '../usage/kimi-coding';

export interface UsageProbeCommandDeps {
  probe?: () => Promise<CodexUsageProbeResult>;
  kimiProbe?: () => Promise<KimiCodingUsageProbeResult>;
  write?: (line: string) => void;
  error?: (line: string) => void;
}

/** S52 read-only usage probe. Its output deliberately excludes bodies and credentials. */
export async function runUsageProbe(args: string[], deps: UsageProbeCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  if (args.length !== 2 || args[1] !== '--json' || (args[0] !== 'openai-codex' && args[0] !== 'kimi-coding')) {
    error('qlb usage probe: expected openai-codex|kimi-coding --json');
    return 1;
  }

  try {
    const result = args[0] === 'kimi-coding'
      ? await (deps.kimiProbe ?? probeKimiCodingUsage)()
      : await (deps.probe ?? probeCodexUsage)();
    write(JSON.stringify({ status: result.status, source: result.source, keys: result.keys }));
    return 0;
  } catch {
    // Never serialize an exception: it may include transport request details.
    write(JSON.stringify({ status: null, source: 'unknown', keys: [] }));
    return 1;
  }
}

const usageProbeCommand: CommandDefinition = {
  name: 'usage probe',
  execute: (args, ctx) => runUsageProbe(args, { write: ctx.stdout, error: ctx.stderr }),
};

export default usageProbeCommand;
