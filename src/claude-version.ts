import { execFileSync } from 'node:child_process';

import { redactSecrets } from './redact';

export type ClaudeVersionRunner = () => string;

function redactVersion(output: string): string {
  const version = redactSecrets(output, []).trim();
  if (version === '') throw new Error('claude-version-empty');
  return version;
}

/** Reads Claude Code's version without allowing tests to invoke a real process. */
export function readClaudeVersion(
  runner?: ClaudeVersionRunner,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (runner) return redactVersion(runner());
  if (env.QLB_TEST_MODE === '1') throw new Error('exec-seam-required');
  return redactVersion(String(execFileSync('claude', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  })));
}
