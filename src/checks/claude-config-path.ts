import { existsSync } from 'node:fs';

import { claudePaths, type ClaudePathOptions } from '../cc-paths';
import { check } from './_check';

export default check('claude:config-path');

export interface ClaudeConfigPathCheckOptions extends ClaudePathOptions {
  exists?: (path: string) => boolean;
}

/** Reports the exact config directory Claude Code path resolution selected. */
export function claudeConfigPathCheck(options: ClaudeConfigPathCheckOptions = {}) {
  const paths = claudePaths(options);
  const exists = options.exists ?? existsSync;
  if (!exists(paths.configHome)) {
    return {
      name: 'claude:config-path' as const,
      level: 'WARN' as const,
      message: `Claude config directory is absent: ${paths.configHome}`,
    };
  }
  return {
    name: 'claude:config-path' as const,
    level: 'PASS' as const,
    message: `Claude config directory resolves to ${paths.configHome}`,
    detail: { globalConfigPath: paths.globalConfigPath, credentialsPath: paths.credentialsPath },
  };
}
