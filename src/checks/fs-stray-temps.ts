import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
  const backupDir = join(home, '.qlb', 'backups', 'pi-auth');
  const backupRoot = join(backupDir, 'by-auth');
  const directories = [
    join(home, '.qlb'),
    join(home, '.qlb', 'journal'),
    claudeConfigHome({ home }),
    home,
    join(home, 'Library', 'LaunchAgents'),
    join(home, '.codex'),
    join(home, '.pi', 'agent'),
    backupDir,
  ];
  try {
    if (lstatSync(backupRoot).isDirectory()) {
      for (const entry of readdirSync(backupRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[0-9a-f]{16}$/.test(entry.name)) directories.push(join(backupRoot, entry.name));
      }
    }
  } catch {}
  return directories;
}

/** Lists abandoned QLB atomic-write temps without reading their contents or mutating the filesystem. */
export function strayTempsCheck(options: StrayTempsCheckOptions = {}) {
  const exists = options.exists ?? existsSync;
  const list = options.list ?? listStrayTemps;
  const paths: string[] = [];
  const unreadableDirectories: string[] = [];
  const directories = [...new Set((options.directories ?? strayTempDirectories()).map((directory) => resolve(directory)))];
  for (const directory of directories) {
    if (!exists(directory)) continue;
    try {
      paths.push(...list(directory));
    } catch {
      unreadableDirectories.push(directory);
    }
  }
  if (paths.length === 0 && unreadableDirectories.length === 0) {
    return {
      name: 'fs:stray-temps' as const, level: 'PASS' as const, message: 'no stray temporary files found',
    };
  }
  const findings = [
    paths.length > 0 ? `${paths.length} stray temporary ${paths.length === 1 ? 'file' : 'files'} found: ${paths.join(', ')}` : '',
    unreadableDirectories.length > 0 ? `unable to inspect stray temporary files in ${unreadableDirectories.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  return {
    name: 'fs:stray-temps' as const,
    level: 'WARN' as const,
    message: findings,
    detail: { paths, unreadableDirectories },
  };
}
