import { execFileSync } from 'node:child_process';

import { redactSecrets } from './redact';

export type ClaudeVersionRunner = () => string;

export class ClaudeVersionSeamRequiredError extends Error {
  code = 'exec-seam-required';

  constructor() {
    super('exec-seam-required');
  }
}

/** Reads Claude Code's version without allowing tests to invoke a real process. */
export function readClaudeVersion(
  runner?: ClaudeVersionRunner,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (runner) return redactSecrets(runner(), []).trim();
  if (env.QLB_TEST_MODE === '1') throw new ClaudeVersionSeamRequiredError();
  return redactSecrets(String(execFileSync('claude', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  })), []).trim();
}
