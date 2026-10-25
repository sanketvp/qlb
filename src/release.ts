import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

import { backupBeforeMigrate } from './store';

const BUILD_STAMP = '.build-sha';
const RELEASE_MANIFEST = 'release.json';
const DEPENDENCY_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

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

interface BuildStamp {
  sha: string;
  dirty: boolean;
  buildDigest: string;
}

/** A build/release integrity failure is a deliberate, operator-actionable refusal (exit 3). */
export class ReleaseIntegrityError extends Error {}

function assertReleaseSha(sha: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sha)) {
    throw new Error('release SHA must contain only letters, digits, dot, underscore, or hyphen');
  }
}

function readBuildStamp(path: string): BuildStamp {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BuildStamp>;
    if (typeof parsed.sha === 'string' && typeof parsed.dirty === 'boolean'
      && typeof parsed.buildDigest === 'string' && /^[a-f0-9]{64}$/.test(parsed.buildDigest)) {
      return { sha: parsed.sha, dirty: parsed.dirty, buildDigest: parsed.buildDigest };
    }
  } catch {
    // The clear refusal below tells the operator to rebuild with the current stamp writer.
  }
  throw new ReleaseIntegrityError('compiled build stamp is invalid; run npm run build from a clean tree');
}

function ensureReleaseTree(sourceDir: string, sha: string): BuildStamp {
  const build = join(sourceDir, 'dist');
  if (!existsSync(build)) {
    throw new Error(`compiled build not found at ${build}; run npm run build first`);
  }
  const stampPath = join(build, BUILD_STAMP);
  if (!existsSync(stampPath)) {
    throw new ReleaseIntegrityError('compiled build stamp is missing; run npm run build from a clean tree');
  }
  const stamp = readBuildStamp(stampPath);
  if (stamp.dirty) {
    throw new ReleaseIntegrityError('compiled build was produced from a dirty source tree; rebuild from a clean tree');
  }
  if (stamp.sha !== sha) {
    throw new ReleaseIntegrityError(`compiled build stamp SHA ${stamp.sha} does not match requested release SHA ${sha}; rebuild or pass the stamped SHA`);
  }
  return stamp;
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readPackageManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

function assertDependencyName(name: string): void {
  if (isAbsolute(name) || name.includes('..') || !DEPENDENCY_NAME.test(name)) {
    throw new ReleaseIntegrityError(`runtime dependency name ${JSON.stringify(name)} is invalid`);
  }
}

function packageDependencyNames(manifest: PackageManifest): Array<{ name: string; optional: boolean }> {
  // npm treats optionalDependencies as an override when a name appears in both maps.
  const optionalNames = new Set(Object.keys(manifest.optionalDependencies ?? {}));
  const required = Object.keys(manifest.dependencies ?? {}).filter((name) => !optionalNames.has(name));
  return [
    ...required.map((name) => ({ name, optional: false })),
    ...[...optionalNames].map((name) => ({ name, optional: true })),
  ];
}

/** Resolves a package exactly as Node does from the directory containing its requiring package. */
function resolveRuntimeDependency(sourceDir: string, requiringDir: string, name: string): string | null {
  assertDependencyName(name);
  const parts = name.split('/');
  let current = requiringDir;
  while (true) {
    // Node skips a duplicate node_modules component while walking upward.
    if (basename(current) !== 'node_modules') {
      const candidate = join(current, 'node_modules', ...parts);
      const fromSource = relative(sourceDir, candidate);
      if (fromSource && !fromSource.startsWith('..') && !isAbsolute(fromSource)
        && existsSync(join(candidate, 'package.json'))) return candidate;
    }
    if (current === sourceDir) break;
    const parent = dirname(current);
    const fromSource = relative(sourceDir, parent);
    if (fromSource.startsWith('..') || isAbsolute(fromSource)) break;
    current = parent;
  }
  return null;
}

/** Copies only runtime packages, preserving Node's nested dependency resolution layout. */
function copyRuntimeDependencies(sourceDir: string, destinationDir: string): void {
  const copied = new Set<string>();
  const copyPackage = (name: string, requiringDir: string, optional: boolean): void => {
    const sourcePackage = resolveRuntimeDependency(sourceDir, requiringDir, name);
    if (!sourcePackage) {
      if (optional) return;
      throw new Error(`runtime dependency ${name} is not installed`);
    }
    const sourceRelative = relative(sourceDir, sourcePackage);
    if (!sourceRelative || sourceRelative.startsWith('..') || isAbsolute(sourceRelative)) {
      throw new ReleaseIntegrityError(`runtime dependency ${name} resolves outside the source tree`);
    }
    const realPackage = realpathSync(sourcePackage);
    assertPathInside(sourceDir, realPackage, sourcePackage);
    if (copied.has(realPackage)) return;
    copied.add(realPackage);
    const targetPackage = join(destinationDir, sourceRelative);
    // A release must not retain a link back to the mutable checkout. This also makes the
    // release digest cover the actual bytes Node will load.
    copyContained(sourcePackage, targetPackage, realPackage);
    const manifest = readPackageManifest(join(sourcePackage, 'package.json'));
    for (const dependency of packageDependencyNames(manifest)) {
      copyPackage(dependency.name, sourcePackage, dependency.optional);
    }
  };

  const packagePath = join(sourceDir, 'package.json');
  if (!existsSync(packagePath)) return;
  for (const dependency of packageDependencyNames(readPackageManifest(packagePath))) {
    copyPackage(dependency.name, sourceDir, dependency.optional);
  }
}

function pathIsInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
}

function assertPathInside(root: string, target: string, linkPath: string): void {
  const realRoot = realpathSync(root);
  if (!pathIsInside(realRoot, target)) {
    throw new ReleaseIntegrityError(`symlink ${linkPath} resolves to ${target} outside ${realRoot}`);
  }
}

/** Copies a tree only after every dereferenced link is confined to `allowedRoot`. */
function copyContained(source: string, destination: string, allowedRoot: string): void {
  const realRoot = realpathSync(allowedRoot);
  const visitedDirectories = new Set<string>();
  const visit = (input: string, output: string): void => {
    let sourcePath = input;
    let stat = lstatSync(sourcePath);
    const linked = stat.isSymbolicLink();
    if (linked) {
      try {
        sourcePath = realpathSync(sourcePath);
      } catch {
        throw new ReleaseIntegrityError(`cannot resolve symlink ${input}`);
      }
      assertPathInside(realRoot, sourcePath, input);
      stat = lstatSync(sourcePath);
    }
    if (stat.isDirectory()) {
      const realDirectory = realpathSync(sourcePath);
      assertPathInside(realRoot, realDirectory, input);
      if (visitedDirectories.has(realDirectory)) {
        throw new ReleaseIntegrityError(`cyclic directory symlink at ${input} resolves to ${realDirectory}`);
      }
      visitedDirectories.add(realDirectory);
      mkdirSync(output, { recursive: true, mode: 0o755 });
      for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
        visit(join(sourcePath, entry.name), join(output, entry.name));
      }
      return;
    }
    if (!stat.isFile()) {
      throw new ReleaseIntegrityError(`unsupported source entry at ${input}`);
    }
    mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
    copyFileSync(sourcePath, output);
  };
  visit(source, destination);
}

function copyReleaseContents(sourceDir: string, stagingDir: string): void {
  const checkoutRoot = realpathSync(sourceDir);
  copyContained(join(sourceDir, 'dist'), join(stagingDir, 'dist'), checkoutRoot);
  if (existsSync(join(sourceDir, 'package.json'))) {
    copyContained(join(sourceDir, 'package.json'), join(stagingDir, 'package.json'), checkoutRoot);
  }
  // `doctor` resolves its repo root from package.json and reads both of these paths for Pi rows.
  if (existsSync(join(sourceDir, 'extensions'))) {
    copyContained(join(sourceDir, 'extensions'), join(stagingDir, 'extensions'), checkoutRoot);
  }
  if (existsSync(join(sourceDir, 'src', 'redact.ts'))) {
    copyContained(join(sourceDir, 'src', 'redact.ts'), join(stagingDir, 'src', 'redact.ts'), checkoutRoot);
  }
  copyRuntimeDependencies(sourceDir, stagingDir);
}

function digestTree(root: string, paths: string[]): string {
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new ReleaseIntegrityError(`release contains a symlink at ${path}; refusing to hash mutable link targets`);
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new ReleaseIntegrityError(`release contains an unsupported file at ${path}`);
    }
    hash.update(`${path}\0${stat.isDirectory() ? 'd' : 'f'}\0`);
    if (!stat.isDirectory()) hash.update(readFileSync(absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function buildOutputDigest(root: string): string {
  const paths: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const path = relative(root, absolute);
      // The stamp authenticates the payload and cannot authenticate itself.
      if (path === join('dist', BUILD_STAMP)) continue;
      paths.push(path);
      if (entry.isDirectory()) visit(absolute);
    }
  };
  for (const output of ['dist', 'extensions']) {
    const path = join(root, output);
    if (existsSync(path)) visit(path);
  }
  return digestTree(root, paths);
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

function assertExistingRelease(releaseDir: string, sha: string, sourceDigest: string): void {
  const manifest = readReleaseManifest(releaseDir);
  if (!lstatSync(releaseDir).isDirectory() || !existsSync(join(releaseDir, 'dist', 'cli.js'))
    || !manifest || manifest.sha !== sha || manifest.digest !== releaseDigest(releaseDir)) {
    throw new ReleaseIntegrityError(`existing release ${sha} is incomplete or altered; refusing to overwrite it`);
  }
  if (manifest.digest !== sourceDigest) {
    throw new ReleaseIntegrityError(`existing release ${sha} has different build bytes; refusing to reuse it`);
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
 * reused only when its manifest attests to exactly the bytes just prepared.
 */
export async function installRelease(options: ReleaseInstallOptions): Promise<ReleaseInstallResult> {
  assertReleaseSha(options.sha);
  const stamp = ensureReleaseTree(options.sourceDir, options.sha);
  mkdirSync(options.appDir, { recursive: true, mode: 0o755 });

  const releaseDir = join(options.appDir, options.sha);
  const stagingDir = join(options.appDir, `.${options.sha}-${process.pid}-${Date.now()}.tmp`);
  let staged = true;
  try {
    mkdirSync(stagingDir, { mode: 0o755 });
    copyReleaseContents(options.sourceDir, stagingDir);
    const stagedBuildDigest = buildOutputDigest(stagingDir);
    if (stagedBuildDigest !== stamp.buildDigest) {
      throw new ReleaseIntegrityError('compiled build output digest differs from its stamp; rebuild from a clean tree');
    }
    const sourceDigest = releaseDigest(stagingDir);
    if (existsSync(releaseDir)) assertExistingRelease(releaseDir, options.sha, sourceDigest);

    let backupPath: string | undefined;
    if (existsSync(options.dbPath)) {
      backupPath = await (options.backup ?? backupBeforeMigrate)(options.dbPath);
    }

    if (!existsSync(releaseDir)) {
      writeFileSync(join(stagingDir, RELEASE_MANIFEST), `${JSON.stringify({ sha: options.sha, digest: sourceDigest })}\n`, { mode: 0o644 });
      renameSync(stagingDir, releaseDir);
      staged = false;
    }
    return { releaseDir, currentPath: publishCurrent(options.appDir, options.sha), backupPath };
  } finally {
    if (staged && existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
  }
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
