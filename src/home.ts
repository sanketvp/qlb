import { homedir } from 'node:os';

/** Test-only home override; production always resolves paths from the OS home. */
export function qlbHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.QLB_TEST_MODE === '1' && typeof env.QLB_HOME === 'string' && env.QLB_HOME.length > 0
    ? env.QLB_HOME
    : homedir();
}
