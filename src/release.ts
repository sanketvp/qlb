import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

import { backupBeforeMigrate } from './store';

const BUILD_STAMP = '.build-sha';
const RELEASE_MANIFEST = 'release.json';

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

export interface ReleaseManifest {
  sha: string;
  digest: string;
}

function assertReleaseSha(sha: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sha)) {
    throw new Error('release SHA must contain only letters, digits, dot, underscore, or hyphen');
  }
}

function ensureReleaseTree(sourceDir: string, sha: string): void {
  const build = join(sourceDir, 'dist');
  if (!existsSync(build) || !lstatSync(build).isDirectory()) {
    throw new Error(`compiled build not found at ${build}; run npm run build first`);
  }
  const stampPath = join(build, BUILD_STAMP);
  if (!existsSync(stampPath) || readFileSync(stampPath, 'utf8').trim() !== sha) {
    throw new Error(`compiled build stamp does not match release SHA ${sha}; run npm run build for that commit`);
  }
}

function packageDependencies(sourceDir: string): string[] {
  const packagePath = join(sourceDir, 'package.json');
  if (!existsSync(packagePath)) return [];
  const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { dependencies?: Record<string, string> };
  return Object.keys(parsed.dependencies ?? {});
}

/** Copies only runtime dependency packages, recursively following their production dependencies. */
function copyRuntimeDependencies(sourceDir: string, destinationDir: string): void {
  const copied = new Set<string>();
  const copyPackage = (name: string): void => {
    if (copied.has(name)) return;
    const sourcePackage = join(sourceDir, 'node_modules', ...name.split('/'));
    const manifestPath = join(sourcePackage, 'package.json');
    if (!existsSync(manifestPath)) throw new Error(`runtime dependency ${name} is not installed`);
    copied.add(name);
    const targetPackage = join(destinationDir, 'node_modules', ...name.split('/'));
    mkdirSync(dirname(targetPackage), { recursive: true, mode: 0o755 });
    cpSync(sourcePackage, targetPackage, { recursive: true });
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) copyPackage(dependency);
  };
  for (const dependency of packageDependencies(sourceDir)) copyPackage(dependency);
}

function digestTree(root: string, paths: string[]): string {
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    hash.update(`${path}\0${stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : 'f'}\0`);
    if (stat.isDirectory()) continue;
    hash.update(stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Returns a stable digest for the bytes shipped in a release (excluding its manifest). */
export function releaseDigest(releaseDir: string): string {
  const paths: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const path = relative(releaseDir, absolute);
      if (path === RELEASE_MANIFEST) continue;
      paths.push(path);
      if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(releaseDir);
  return digestTree(releaseDir, paths);
}

export function readReleaseManifest(releaseDir: string): ReleaseManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(join(releaseDir, RELEASE_MANIFEST), 'utf8')) as Partial<ReleaseManifest>;
    return typeof manifest.sha === 'string' && /^[a-f0-9]{64}$/.test(manifest.digest ?? '')
      ? manifest as ReleaseManifest
      : null;
  } catch {
    return null;
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
  ensureReleaseTree(options.sourceDir, options.sha);
  mkdirSync(options.appDir, { recursive: true, mode: 0o755 });

  let backupPath: string | undefined;
  if (existsSync(options.dbPath)) {
    backupPath = await (options.backup ?? backupBeforeMigrate)(options.dbPath);
  }

  const releaseDir = join(options.appDir, options.sha);
  if (existsSync(releaseDir)) {
    const manifest = readReleaseManifest(releaseDir);
    if (!lstatSync(releaseDir).isDirectory() || !existsSync(join(releaseDir, 'dist', 'cli.js'))
      || !manifest || manifest.sha !== options.sha || manifest.digest !== releaseDigest(releaseDir)) {
      throw new Error(`existing release ${options.sha} is incomplete or altered; refusing to overwrite it`);
    }
  } else {
    const stagingDir = join(options.appDir, `.${options.sha}-${process.pid}-${Date.now()}.tmp`);
    try {
      mkdirSync(stagingDir, { mode: 0o755 });
      cpSync(join(options.sourceDir, 'dist'), join(stagingDir, 'dist'), { recursive: true });
      if (existsSync(join(options.sourceDir, 'package.json'))) cpSync(join(options.sourceDir, 'package.json'), join(stagingDir, 'package.json'));
      copyRuntimeDependencies(options.sourceDir, stagingDir);
      writeFileSync(join(stagingDir, RELEASE_MANIFEST), `${JSON.stringify({ sha: options.sha, digest: releaseDigest(stagingDir) })}\n`, { mode: 0o644 });
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
