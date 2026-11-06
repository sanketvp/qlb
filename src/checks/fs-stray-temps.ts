import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { claudeConfigHome } from '../cc-paths';
import { listStrayTemps } from '../fsutil';
import { qlbHomeDir } from '../home';
import { check } from './_check';

export default check('fs:stray-temps');

export interface StrayTempsCheckOptions {
  directories?: readonly string[];
  exists?: (path: string) => boolean;
  list?: (path: string) => string[];
}

/** Published directories where QLB's atomic writes can leave an interrupted temp. */
export function strayTempDirectories(home = qlbHomeDir()): string[] {
  return [
    join(home, '.qlb'),
    claudeConfigHome({ home }),
    join(home, 'Library', 'LaunchAgents'),
  ];
}

/** Lists abandoned QLB atomic-write temps without reading their contents or mutating the filesystem. */
export function strayTempsCheck(options: StrayTempsCheckOptions = {}) {
  const exists = options.exists ?? existsSync;
  const list = options.list ?? listStrayTemps;
  const paths: string[] = [];
  for (const directory of options.directories ?? strayTempDirectories()) {
    if (!exists(directory)) continue;
    try {
      paths.push(...list(directory));
    } catch {
      return {
        name: 'fs:stray-temps' as const,
        level: 'WARN' as const,
        message: `unable to inspect stray temporary files in ${directory}`,
      };
    }
  }
  return paths.length === 0
    ? { name: 'fs:stray-temps' as const, level: 'PASS' as const, message: 'no stray temporary files found' }
    : {
      name: 'fs:stray-temps' as const,
      level: 'WARN' as const,
      message: `${paths.length} stray temporary ${paths.length === 1 ? 'file' : 'files'} found: ${paths.join(', ')}`,
      detail: { paths },
    };
}
