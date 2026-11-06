import { readClaudeVersion, type ClaudeVersionRunner } from '../claude-version';
import { check } from './_check';

export default check('claude:version-drift');

export function claudeVersionDriftCheck(
  recordedVersion: string | null,
  runner?: ClaudeVersionRunner,
  env: NodeJS.ProcessEnv = process.env,
): { name: 'claude:version-drift'; level: 'PASS' | 'WARN' | 'INFO'; message: string } {
  if (recordedVersion === null || recordedVersion === '') {
    return { name: 'claude:version-drift', level: 'INFO', message: 'not recorded' };
  }
  try {
    const installed = readClaudeVersion(runner, env);
    return installed === recordedVersion
      ? { name: 'claude:version-drift', level: 'PASS', message: `Claude Code version matches recorded value: ${recordedVersion}` }
      : { name: 'claude:version-drift', level: 'WARN', message: `Claude Code version drift: recorded ${recordedVersion}; installed ${installed}` };
  } catch {
    return { name: 'claude:version-drift', level: 'WARN', message: 'Claude Code version unknown' };
  }
}
