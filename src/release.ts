import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { backupBeforeMigrate } from './store';

export interface ReleaseInstallOptions {
  /** Repository root containing the compiled `dist/` build. */
  sourceDir: string;
  /** QLB's `app/` directory, normally `~/.qlb/app`. */
  appDir: string;
  sha: string;
  dbPath: string;
  backup?: typeof backupBeforeMigrate;
}

export interface ReleaseInstallResult {
  releaseDir: string;
  currentPath: string;
  backupPath?: string;
}

function assertReleaseSha(sha: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sha)) {
    throw new Error('release SHA must contain only letters, digits, dot, underscore, or hyphen');
  }
}

function ensureReleaseTree(sourceDir: string): void {
  const build = join(sourceDir, 'dist');
  if (!existsSync(build) || !lstatSync(build).isDirectory()) {
    throw new Error(`compiled build not found at ${build}; run npm run build first`);
  }
}

function publishCurrent(appDir: string, sha: string): string {
  const currentPath = join(appDir, 'current');
  const temporaryPath = join(appDir, `.current-${process.pid}-${Date.now()}.tmp`);
  try {
    symlinkSync(sha, temporaryPath);
    renameSync(temporaryPath, currentPath);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
  return currentPath;
}

/**
 * Installs the compiled build in an immutable SHA-named directory and then
 * atomically swaps the relative `current` symlink. A pre-existing release is
 * never overwritten; this makes repeated installs of the same SHA safe.
 */
export async function installRelease(options: ReleaseInstallOptions): Promise<ReleaseInstallResult> {
  assertReleaseSha(options.sha);
  ensureReleaseTree(options.sourceDir);
  mkdirSync(options.appDir, { recursive: true, mode: 0o755 });

  let backupPath: string | undefined;
  if (existsSync(options.dbPath)) {
    backupPath = await (options.backup ?? backupBeforeMigrate)(options.dbPath);
  }

  const releaseDir = join(options.appDir, options.sha);
  if (existsSync(releaseDir)) {
    if (!lstatSync(releaseDir).isDirectory() || !existsSync(join(releaseDir, 'dist', 'cli.js'))) {
      throw new Error(`existing release ${options.sha} is incomplete; refusing to overwrite it`);
    }
  } else {
    const stagingDir = join(options.appDir, `.${options.sha}-${process.pid}-${Date.now()}.tmp`);
    try {
      mkdirSync(stagingDir, { mode: 0o755 });
      cpSync(join(options.sourceDir, 'dist'), join(stagingDir, 'dist'), { recursive: true });
      if (existsSync(join(options.sourceDir, 'package.json'))) {
        cpSync(join(options.sourceDir, 'package.json'), join(stagingDir, 'package.json'));
      }
      renameSync(stagingDir, releaseDir);
    } catch (err) {
      rmSync(stagingDir, { recursive: true, force: true });
      throw err;
    }
  }

  return { releaseDir, currentPath: publishCurrent(options.appDir, options.sha), backupPath };
}

/** Extracts the installed release name without resolving outside `app/`. */
export function currentReleaseSha(appDir: string): string | null {
  const currentPath = join(appDir, 'current');
  try {
    if (!lstatSync(currentPath).isSymbolicLink()) return null;
    const target = readlinkSync(currentPath);
    if (target.includes('/') || target.includes('\\') || basename(target) !== target) return null;
    return target;
  } catch {
    return null;
  }
}

/** Returns the repository root whether this module is run from `src` or `dist`. */
export function releaseSourceDir(moduleDir: string = __dirname): string {
  return dirname(moduleDir);
}
