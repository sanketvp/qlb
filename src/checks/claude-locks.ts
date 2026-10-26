import { existsSync } from 'node:fs';

import { claudeLockPaths, type ClaudeLockOptions } from '../cc-locks';
import { check } from './_check';

export default check('claude:locks');

export interface ClaudeLocksCheckOptions extends ClaudeLockOptions {
  exists?: (path: string) => boolean;
}

/** Surface Claude Code's short-lived proper-lockfile directories without modifying them. */
export function claudeLocksCheck(options: ClaudeLocksCheckOptions = {}) {
  const paths = claudeLockPaths(options);
  const exists = options.exists ?? existsSync;
  const held = [paths.oauthRefreshLockDir, paths.credentialsLockDir, paths.configLockDir]
    .filter((path) => exists(path));
  if (held.length > 0) {
    return {
      name: 'claude:locks' as const,
      level: 'WARN' as const,
      message: `Claude Code lock${held.length === 1 ? '' : 's'} currently held; retry mutations shortly`,
      detail: { paths: held },
    };
  }
  return { name: 'claude:locks' as const, level: 'PASS' as const, message: 'no Claude Code locks are present' };
}
