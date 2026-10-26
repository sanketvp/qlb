import { existsSync, readFileSync } from 'node:fs';

import { claudePaths, type ClaudePathOptions } from '../cc-paths';
import { readClaudeConfig } from '../cc-credentials';
import { check } from './_check';

export default check('claude:config-file');

export interface ClaudeConfigFileCheckOptions extends ClaudePathOptions {
  exists?: (path: string) => boolean;
  readText?: (path: string) => string;
}

/** S22: a present but malformed global config is unsafe to splice and must fail doctor. */
export function claudeConfigFileCheck(options: ClaudeConfigFileCheckOptions = {}) {
  const paths = claudePaths(options);
  const exists = options.exists ?? existsSync;
  if (!exists(paths.globalConfigPath)) {
    return { name: 'claude:config-file' as const, level: 'WARN' as const, message: `Claude global config is absent: ${paths.globalConfigPath}` };
  }
  try {
    readClaudeConfig(paths.globalConfigPath, options.readText ?? ((path) => readFileSync(path, 'utf8')));
    return { name: 'claude:config-file' as const, level: 'PASS' as const, message: 'Claude global config is parseable' };
  } catch (error) {
    return {
      name: 'claude:config-file' as const,
      level: 'FAIL' as const,
      message: `Claude global config is unparseable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
