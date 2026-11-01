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
};

export type ResolveMigratePathOptions = {
  flag: string;
  kind: MigratePathKind;
  /** Entry paths used with rename/unlink must never be a symlink themselves. */
  entryLeaf?: boolean;
  fs?: MigratePathFs;
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
  physical: string;
  identity: DirectoryIdentity;
  /** Kept with the root so identity checks use the same injectable filesystem. */
  fs: MigratePathFs;
  flag: string;
};

export type ResolveProtectedRootOptions = {
  flag: string;
  cwd: string;
  fs?: MigratePathFs;
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
function assertAbsoluteGrammar(value: string, flag: string): void {
  if (!value.startsWith('/')) pathError(flag, 'path must be absolute after cwd prefixing');
  if (value.startsWith('//')) pathError(flag, 'double-leading slashes are not supported');
  if (value !== '/' && value.includes('//')) pathError(flag, 'repeated separators are not supported');
  assertNoDotSegments(value, flag);
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
  const { flag, kind, cwd } = options;
  if (typeof raw !== 'string') pathError(flag, 'path must be a string');
  assertWellFormed(raw, flag);
  if (raw.length === 0) pathError(flag, 'path is empty');
  if (raw.includes('\0')) pathError(flag, 'path contains NUL');

  if (kind === 'file' && raw.endsWith('/')) pathError(flag, 'file path has a trailing slash');
  const acceptedRaw = kind === 'dir' ? stripDirectoryTrailingSeparators(raw) : raw;
  if (acceptedRaw.startsWith('//')) pathError(flag, 'double-leading slashes are not supported');
  if (acceptedRaw !== '/' && acceptedRaw.includes('//')) pathError(flag, 'repeated separators are not supported');
  assertNoDotSegments(acceptedRaw, flag);

  assertWellFormed(cwd, flag);
  if (cwd.includes('\0')) pathError(flag, 'cwd contains NUL');
  assertAbsoluteGrammar(cwd, flag);
  const absolute = acceptedRaw.startsWith('/')
    ? acceptedRaw
    : cwd === '/' ? `/${acceptedRaw}` : `${cwd}/${acceptedRaw}`;
  assertAbsoluteGrammar(absolute, flag);
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

function symlinkTarget(value: string | Buffer, flag: string): { absolute: boolean; components: string[] } {
  let target: string;
  if (Buffer.isBuffer(value)) {
    try {
      target = new TextDecoder('utf-8', { fatal: true }).decode(value);
    } catch {
      pathError(flag, 'non-UTF-8 symlink target');
    }
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
  return { absolute: target.startsWith('/'), components: body.split('/') };
}

/**
 * Resolve only the deliberately restricted migration pathname grammar. Missing
 * suffixes are returned rather than invented or created.
 */
export function resolveMigratePath(abs: string, options: ResolveMigratePathOptions): ResolvedMigratePath {
  const { flag, kind, entryLeaf = false } = options;
  assertWellFormed(abs, flag);
  if (abs.includes('\0')) pathError(flag, 'path contains NUL');
  assertAbsoluteGrammar(abs, flag);
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
      const target = symlinkTarget(rawTarget, flag);
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
  const auth = validateRawMigratePath(authJsonPathRaw, { flag: options.flag, kind: 'file', cwd: options.cwd });
  const fs = fsOrDefault(options.fs);
  const root = resolveMigratePath(parentPath(auth), { flag: options.flag, kind: 'dir', fs });
  if (root.endpoint !== 'dir') pathError('', 'protected Pi directory is missing');
  return {
    physical: root.physical,
    identity: identityOf(root.physical, fs, options.flag),
    fs,
    flag: options.flag,
  };
}

/** Compare directory device/inode identities, including the candidate anchor itself. */
export function isInsideProtectedRoot(resolved: ResolvedMigratePath, root: ProtectedRoot): boolean {
  let current = resolved.anchor;
  while (true) {
    const identity = identityOf(current, root.fs, root.flag);
    if (identity.dev === root.identity.dev && identity.ino === root.identity.ino) return true;
    if (current === '/') return false;
    current = parentPath(current);
  }
}

/** Migration path protection intentionally supports only POSIX filesystem semantics. */
export function assertSupportedPlatform(platform = process.platform): void {
  if (platform === 'win32') pathError('platform', 'Windows is not supported for migrate path validation');
}
