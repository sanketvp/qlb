import { probeCodexUsage, type CodexUsageProbeResult } from '../usage/openai-codex';
import { legacyCommand } from './_legacy';

export interface UsageProbeCommandDeps {
  probe?: () => Promise<CodexUsageProbeResult>;
  write?: (line: string) => void;
  error?: (line: string) => void;
}

/** S52 read-only usage probe. Its output deliberately excludes bodies and credentials. */
export async function runUsageProbe(args: string[], deps: UsageProbeCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  if (args.length !== 2 || args[0] !== 'openai-codex' || args[1] !== '--json') {
    error('qlb usage probe: expected openai-codex --json');
    return 1;
  }

  try {
    const result = await (deps.probe ?? probeCodexUsage)();
    write(JSON.stringify({ status: result.status, source: result.source, keys: result.keys }));
    return 0;
  } catch {
    // Never serialize an exception: it may include transport request details.
    write(JSON.stringify({ status: null, source: 'unknown', keys: [] }));
    return 1;
  }
}

export default legacyCommand('usage probe', ['usage-probe']);
