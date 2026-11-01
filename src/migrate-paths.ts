import * as nodeFs from 'node:fs';

const MAX_SYMLINK_EXPANSIONS = 8;

export type MigratePathKind = 'file' | 'dir';

export class MigratePathError extends Error {
  readonly code = 'UNSAFE_MIGRATE_PATH';
  readonly flag: string;

  constructor(flag: string, detail: string) {
    super(flag.length === 0 ? `unsafe-migrate-path: ${detail}` : `unsafe-migrate-path: ${flag}: ${detail}`);
    this.name = 'MigratePathError';
    this.flag = flag;
  }
}

export type MigratePathFs = Pick<typeof nodeFs, 'lstatSync' | 'readlinkSync' | 'statSync'>;

export type ValidateRawMigratePathOptions = {
  flag: string;
  kind: MigratePathKind;
  /** A previously captured physical working directory. */
  cwd: string;
  /** Injectable for platform-specific pathname grammar tests. */
  platform?: string;
};

export type ResolveMigratePathOptions = {
  flag: string;
  kind: MigratePathKind;
  /** Entry paths used with rename/unlink must never be a symlink themselves. */
  entryLeaf?: boolean;
  fs?: MigratePathFs;
  /** Injectable for platform-specific pathname grammar tests. */
  platform?: string;
};

export type ResolvedMigratePath = {
  /** The accepted spelling after every existing symlink has been expanded. */
  physical: string;
  /** Deepest existing directory on physical. */
  anchor: string;
  /** Validated ordinary components below anchor when endpoint is missing. */
  missingSuffix: string[];
  endpoint: 'file' | 'dir' | 'missing';
  leafWasSymlink: boolean;
};

type DirectoryIdentity = { dev: bigint; ino: bigint };

export type ProtectedRoot = {
  /** Directory containing the configured auth-path spelling. */
  physical: string;
  /** Compatibility alias for the configured auth-path directory identity. */
  identity: DirectoryIdentity;
  /** Both the configured auth directory and a followed auth-leaf target directory. */
  identities: readonly DirectoryIdentity[];
  /** Kept with the root so identity checks use the same injectable filesystem. */
  fs: MigratePathFs;
  flag: string;
};

export type ResolveProtectedRootOptions = {
  flag: string;
  cwd: string;
  fs?: MigratePathFs;
  /** Injectable for platform-specific pathname grammar tests. */
  platform?: string;
};

function pathError(flag: string, detail: string): never {
  throw new MigratePathError(flag, detail);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function assertWellFormed(value: string, flag: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) pathError(flag, 'ill-formed Unicode');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      pathError(flag, 'ill-formed Unicode');
    }
  }
}

function assertNoDotSegments(value: string, flag: string, detail = 'dot segments are not supported'): void {
  if (value.split('/').some((segment) => segment === '.' || segment === '..')) pathError(flag, detail);
}

/** Validate an already-absolute accepted-path spelling without touching the filesystem. */
function assertNoDarwinVol(value: string, flag: string, platform: string): void {
  if (platform !== 'darwin') return;
  const firstComponent = (value.startsWith('/') ? value.slice(1) : value).split('/')[0];
  // volfs can resolve /.vol/<dev>/<ino> even when an earlier lstat says ENOENT.
  if (firstComponent === '.vol') pathError(flag, 'darwin /.vol paths are not supported');
}

function assertAbsoluteGrammar(value: string, flag: string, platform: string = process.platform): void {
  if (!value.startsWith('/')) pathError(flag, 'path must be absolute after cwd prefixing');
  if (value.startsWith('//')) pathError(flag, 'double-leading slashes are not supported');
  if (value !== '/' && value.includes('//')) pathError(flag, 'repeated separators are not supported');
  if (value !== '/' && value.endsWith('/')) pathError(flag, 'path has a trailing slash');
  assertNoDotSegments(value, flag);
  assertNoDarwinVol(value, flag, platform);
}

function stripDirectoryTrailingSeparators(value: string): string {
  let stripped = value;
  while (stripped.length > 1 && stripped.endsWith('/')) stripped = stripped.slice(0, -1);
  return stripped;
}

/**
 * Lexically validate a migration path before any path-library normalization can
 * erase a hostile segment. This function intentionally does no filesystem I/O.
 */
export function validateRawMigratePath(raw: string, options: ValidateRawMigratePathOptions): string {
  const { flag, kind, cwd, platform = process.platform } = options;
  if (typeof raw !== 'string') pathError(flag, 'path must be a string');
  assertWellFormed(raw, flag);
  if (raw.length === 0) pathError(flag, 'path is empty');
  if (raw.includes('\0')) pathError(flag, 'path contains NUL');
  // Check the raw spelling before directory trailing-slash trimming can erase it.
  if (raw.startsWith('//')) pathError(flag, 'double-leading slashes are not supported');
  if (raw !== '/' && raw.includes('//')) pathError(flag, 'repeated separators are not supported');
  assertNoDotSegments(raw, flag);
  assertNoDarwinVol(raw, flag, platform);

  if (kind === 'file' && raw.endsWith('/')) pathError(flag, 'file path has a trailing slash');
  const acceptedRaw = kind === 'dir' ? stripDirectoryTrailingSeparators(raw) : raw;

  assertWellFormed(cwd, flag);
  if (cwd.includes('\0')) pathError(flag, 'cwd contains NUL');
  assertAbsoluteGrammar(cwd, flag, platform);
  const absolute = acceptedRaw.startsWith('/')
    ? acceptedRaw
    : cwd === '/' ? `/${acceptedRaw}` : `${cwd}/${acceptedRaw}`;
  assertAbsoluteGrammar(absolute, flag, platform);
  return absolute;
}

function partsOfAbsolute(path: string): string[] {
  return path === '/' ? [] : path.slice(1).split('/');
}

function childPath(parent: string, child: string): string {
  return parent === '/' ? `/${child}` : `${parent}/${child}`;
}

function parentPath(path: string): string {
  if (path === '/') return '/';
  const slash = path.lastIndexOf('/');
  return slash === 0 ? '/' : path.slice(0, slash);
}

function fsOrDefault(fs: MigratePathFs | undefined): MigratePathFs {
  return fs ?? nodeFs;
}

function lookupFailure(flag: string, error: unknown): never {
  const code = errorCode(error) ?? 'unknown';
  pathError(flag, `lookup failed (${code})`);
}

function symlinkTarget(value: string | Buffer, flag: string, platform: string): { absolute: boolean; components: string[] } {
  let target: string;
  if (Buffer.isBuffer(value)) {
    try {
      // ignoreBOM preserves a leading U+FEFF instead of silently changing its pathname.
      target = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
    } catch {
      pathError(flag, 'non-UTF-8 symlink target');
    }
    if (!Buffer.from(target, 'utf8').equals(value)) pathError(flag, 'non-UTF-8 symlink target');
  } else {
    target = value;
    assertWellFormed(target, flag);
  }
  if (target.length === 0) pathError(flag, 'empty symlink target');
  if (target.includes('\0')) pathError(flag, 'symlink target contains NUL');
  if (target.endsWith('/')) pathError(flag, 'symlink target has a trailing slash');
  if (target.startsWith('//')) pathError(flag, 'symlink target has double-leading slashes');
  const body = target.startsWith('/') ? target.slice(1) : target;
  if (body.includes('//')) pathError(flag, 'symlink target has repeated separators');
  if (body.split('/').some((segment) => segment === '.' || segment === '..')) {
    pathError(flag, 'symlink target contains dot segments');
  }
  assertNoDarwinVol(target, flag, platform);
  return { absolute: target.startsWith('/'), components: body.split('/') };
}

/**
 * Resolve only the deliberately restricted migration pathname grammar. Missing
 * suffixes are returned rather than invented or created.
 */
export function resolveMigratePath(abs: string, options: ResolveMigratePathOptions): ResolvedMigratePath {
  const { flag, kind, entryLeaf = false, platform = process.platform } = options;
  assertWellFormed(abs, flag);
  if (abs.includes('\0')) pathError(flag, 'path contains NUL');
  assertAbsoluteGrammar(abs, flag, platform);
  const fs = fsOrDefault(options.fs);
  let current = '/';
  let pending = partsOfAbsolute(abs).map((component, index, components) => ({
    component,
    originalLeaf: index === components.length - 1,
  }));
  let expansions = 0;
  let leafWasSymlink = false;

  while (pending.length > 0) {
    const pendingComponent = pending.shift()!;
    const { component } = pendingComponent;
    const candidate = childPath(current, component);
    let metadata: ReturnType<MigratePathFs['lstatSync']>;
    try {
      metadata = fs.lstatSync(candidate);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return {
          physical: [candidate, ...pending.map(({ component: suffix }) => suffix)].join('/'),
          anchor: current,
          missingSuffix: [component, ...pending.map(({ component: suffix }) => suffix)],
          endpoint: 'missing',
          leafWasSymlink,
        };
      }
      return lookupFailure(flag, error);
    }

    if (metadata.isSymbolicLink()) {
      if (pendingComponent.originalLeaf) leafWasSymlink = true;
      if (entryLeaf && pendingComponent.originalLeaf) pathError(flag, 'symlinked entry path');
      if (expansions >= MAX_SYMLINK_EXPANSIONS) pathError(flag, 'symlink-depth-limit (ELOOP)');
      expansions += 1;
      let rawTarget: string | Buffer;
      try {
        rawTarget = fs.readlinkSync(candidate, { encoding: 'buffer' }) as Buffer;
      } catch (error) {
        return lookupFailure(flag, error);
      }
      const target = symlinkTarget(rawTarget, flag, platform);
      if (target.absolute) current = '/';
      pending = [...target.components.map((component) => ({ component, originalLeaf: false })), ...pending];
      continue;
    }

    if (pending.length > 0) {
      if (!metadata.isDirectory()) pathError(flag, 'ENOTDIR: non-directory intermediate component');
      current = candidate;
      continue;
    }

    if (kind === 'dir') {
      if (!metadata.isDirectory()) pathError(flag, 'ENOTDIR: expected directory');
      return { physical: candidate, anchor: candidate, missingSuffix: [], endpoint: 'dir', leafWasSymlink };
    }
    if (!metadata.isFile()) pathError(flag, 'endpoint is not a regular file');
    return { physical: candidate, anchor: current, missingSuffix: [], endpoint: 'file', leafWasSymlink };
  }

  // The only absolute pathname with no components is the filesystem root.
  if (kind !== 'dir') pathError(flag, 'ENOTDIR: expected regular file');
  return { physical: '/', anchor: '/', missingSuffix: [], endpoint: 'dir', leafWasSymlink: false };
}

function identityOf(path: string, fs: MigratePathFs, flag: string): DirectoryIdentity {
  try {
    const metadata = fs.statSync(path, { bigint: true }) as unknown as { dev: bigint | number; ino: bigint | number };
    return { dev: BigInt(metadata.dev), ino: BigInt(metadata.ino) };
  } catch (error) {
    return lookupFailure(flag, error);
  }
}

/** Resolve and require the existing directory that contains the configured Pi auth path. */
export function resolveProtectedRoot(authJsonPathRaw: string, options: ResolveProtectedRootOptions): ProtectedRoot {
  const { flag, cwd, platform = process.platform } = options;
  const auth = validateRawMigratePath(authJsonPathRaw, { flag, kind: 'file', cwd, platform });
  const fs = fsOrDefault(options.fs);
  const root = resolveMigratePath(parentPath(auth), { flag, kind: 'dir', fs, platform });
  if (root.endpoint !== 'dir') pathError('', 'protected Pi directory is missing');
  const authTarget = resolveMigratePath(auth, { flag, kind: 'file', fs, platform });
  const identity = identityOf(root.physical, fs, flag);
  const targetIdentity = identityOf(authTarget.anchor, fs, flag);
  const identities = identity.dev === targetIdentity.dev && identity.ino === targetIdentity.ino
    ? [identity]
    : [identity, targetIdentity];
  return {
    physical: root.physical,
    identity,
    identities,
    fs,
    flag,
  };
}

/** Compare directory device/inode identities, including the candidate anchor itself. */
export function isInsideProtectedRoot(resolved: ResolvedMigratePath, root: ProtectedRoot): boolean {
  let current = resolved.anchor;
  while (true) {
    const identity = identityOf(current, root.fs, root.flag);
    if (root.identities.some((protectedIdentity) => (
      identity.dev === protectedIdentity.dev && identity.ino === protectedIdentity.ino
    ))) return true;
    if (current === '/') return false;
    current = parentPath(current);
  }
}

/** Migration path protection intentionally supports only POSIX filesystem semantics. */
export function assertSupportedPlatform(platform = process.platform): void {
  if (platform === 'win32') pathError('platform', 'Windows is not supported for migrate path validation');
}
