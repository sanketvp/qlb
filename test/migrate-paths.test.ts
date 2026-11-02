import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import * as paths from '../src/migrate-paths';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'qlb-migrate-paths-'));
  mkdirSync(join(root, 'live-agent'));
  mkdirSync(join(root, 'safe'));
  return root;
}

function withFixture(run: (root: string) => void): void {
  const root = fixture();
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function file(raw: string, cwd: string): string {
  return paths.validateRawMigratePath(raw, { flag: '--auth-json', kind: 'file', cwd });
}

function dir(raw: string, cwd: string): string {
  return paths.validateRawMigratePath(raw, { flag: '--target-dir', kind: 'dir', cwd });
}

function unsafe(run: () => unknown, expression: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, 'UNSAFE_MIGRATE_PATH');
    assert.match(error.message, /^unsafe-migrate-path:/);
    assert.match(error.message, expression);
    return true;
  });
}

describe('migrate path admission primitives', () => {
  it('11 migrate rejects NUL and malformed path strings before filesystem access', () => withFixture((root) => {
    let accesses = 0;
    const fs = {
      lstatSync: () => { accesses += 1; throw new Error('must not access filesystem'); },
      readlinkSync: () => { accesses += 1; throw new Error('must not access filesystem'); },
      statSync: () => { accesses += 1; throw new Error('must not access filesystem'); },
    };
    unsafe(() => file('bad\0path', join(root, 'safe')), /NUL/);
    unsafe(() => file('', join(root, 'safe')), /empty/);
    unsafe(() => file(`bad${String.fromCharCode(0xd800)}`, join(root, 'safe')), /ill-formed Unicode/);
    unsafe(() => paths.resolveMigratePath('/safe/./x', { flag: '--auth-json', kind: 'file', fs }), /dot segments/);
    assert.equal(accesses, 0);
  }));

  it('12 migrate prefixes a clean relative path with the captured physical cwd', () => withFixture((root) => {
    const cwd = realpathSync.native(join(root, 'safe'));
    const absolute = file('auth.json', cwd);
    assert.equal(absolute, `${cwd}/auth.json`);
    const resolved = paths.resolveMigratePath(absolute, { flag: '--auth-json', kind: 'file' });
    assert.deepEqual(resolved, {
      physical: `${cwd}/auth.json`, anchor: cwd, missingSuffix: ['auth.json'], endpoint: 'missing', leafWasSymlink: false,
    });
  }));

  it('13 migrate rejects cyclic symlinks and pins the eight-expansion cap', () => withFixture((root) => {
    const safe = realpathSync.native(join(root, 'safe'));
    symlinkSync('b', join(safe, 'a'));
    symlinkSync('a', join(safe, 'b'));
    unsafe(() => paths.resolveMigratePath(file('a', safe), { flag: '--auth-json', kind: 'file' }), /symlink-depth-limit \(ELOOP\)/);

    for (let index = 0; index < 8; index += 1) symlinkSync(`eight-${index + 1}`, join(safe, `eight-${index}`));
    writeFileSync(join(safe, 'eight-8'), '{}');
    assert.equal(paths.resolveMigratePath(file('eight-0', safe), { flag: '--auth-json', kind: 'file' }).endpoint, 'file');

    for (let index = 0; index < 9; index += 1) symlinkSync(`nine-${index + 1}`, join(safe, `nine-${index}`));
    writeFileSync(join(safe, 'nine-9'), '{}');
    unsafe(() => paths.resolveMigratePath(file('nine-0', safe), { flag: '--auth-json', kind: 'file' }), /symlink-depth-limit \(ELOOP\)/);
  }));

  it('14 migrate rejects dot segments in existing symlink targets', () => withFixture((root) => {
    const safe = join(root, 'safe');
    symlinkSync('../live-agent', join(safe, 'link'));
    unsafe(() => paths.resolveMigratePath(file('link/auth.json', safe), { flag: '--auth-json', kind: 'file' }), /symlink target contains dot segments/);
  }));

  it('15 migrate rejects dot segments in dangling symlink targets', () => withFixture((root) => {
    const safe = join(root, 'safe');
    symlinkSync('missing/../link/auth.json', join(safe, 'dangling'));
    unsafe(() => paths.resolveMigratePath(file('dangling', safe), { flag: '--auth-json', kind: 'file' }), /symlink target contains dot segments/);
  }));

  it('16 migrate follows an ordinary relative symlink chain', () => withFixture((root) => {
    const safe = join(root, 'safe');
    mkdirSync(join(safe, 'real'));
    writeFileSync(join(safe, 'real', 'auth.json'), '{}');
    symlinkSync('real/auth.json', join(safe, 'hop2'));
    symlinkSync('hop2', join(safe, 'hop1'));
    const resolved = paths.resolveMigratePath(file('hop1', safe), { flag: '--auth-json', kind: 'file' });
    assert.equal(resolved.physical, realpathSync.native(join(safe, 'real', 'auth.json')));
    assert.equal(resolved.anchor, realpathSync.native(join(safe, 'real')));
    assert.equal(resolved.endpoint, 'file');
    assert.equal(resolved.leafWasSymlink, true);
  }));

  it('17 migrate classifies a missing descendant using its existing directory anchor', () => withFixture((root) => {
    const live = join(root, 'live-agent');
    const safe = join(root, 'safe');
    writeFileSync(join(live, 'auth.json'), '{}');
    const protectedRoot = paths.resolveProtectedRoot(join(live, 'auth.json'), { flag: 'QLB_PI_AUTH_JSON_PATH', cwd: safe });
    const inside = paths.resolveMigratePath(file(join(live, 'new', 'sub', 'auth.json'), safe), { flag: '--auth-json', kind: 'file' });
    const outside = paths.resolveMigratePath(file(join(safe, 'new', 'sub', 'auth.json'), safe), { flag: '--auth-json', kind: 'file' });
    assert.equal(inside.anchor, realpathSync.native(live));
    assert.deepEqual(inside.missingSuffix, ['new', 'sub', 'auth.json']);
    assert.equal(paths.isInsideProtectedRoot(inside, protectedRoot), true);
    assert.equal(paths.isInsideProtectedRoot(outside, protectedRoot), false);
    assert.throws(() => lstatSync(join(safe, 'new')), { code: 'ENOENT' });
  }));

  it('18 migrate detects case aliases of the protected directory on case-insensitive APFS', (t) => withFixture((root) => {
    const upper = join(root, 'LiveAgent');
    mkdirSync(upper);
    writeFileSync(join(upper, 'auth.json'), '{}');
    const lower = join(root, 'liveagent');
    try {
      lstatSync(lower);
    } catch {
      t.skip('host volume is case-sensitive');
      return;
    }
    const protectedRoot = paths.resolveProtectedRoot(join(upper, 'auth.json'), { flag: 'QLB_PI_AUTH_JSON_PATH', cwd: join(root, 'safe') });
    const missing = paths.resolveMigratePath(file(`${lower}/new.json`, join(root, 'safe')), { flag: '--auth-json', kind: 'file' });
    const existing = paths.resolveMigratePath(file(`${lower}/auth.json`, join(root, 'safe')), { flag: '--auth-json', kind: 'file' });
    assert.equal(paths.isInsideProtectedRoot(missing, protectedRoot), true);
    assert.equal(paths.isInsideProtectedRoot(existing, protectedRoot), true);
  }));

  it('19 migrate does not classify a prefix sibling as inside Pi', () => withFixture((root) => {
    const live = join(root, 'live-agent');
    const sibling = join(root, 'live-agent-other');
    mkdirSync(sibling);
    writeFileSync(join(live, 'auth.json'), '{}');
    const protectedRoot = paths.resolveProtectedRoot(join(live, 'auth.json'), { flag: 'QLB_PI_AUTH_JSON_PATH', cwd: join(root, 'safe') });
    const resolved = paths.resolveMigratePath(file(join(sibling, 'auth.json'), join(root, 'safe')), { flag: '--auth-json', kind: 'file' });
    assert.equal(paths.isInsideProtectedRoot(resolved, protectedRoot), false);
  }));

  it('20 migrate treats var and private-var aliases identically on macOS', (t) => withFixture((root) => {
    const physical = realpathSync.native(root);
    const alternate = physical.startsWith('/private/var/') ? physical.replace('/private/var/', '/var/')
      : physical.startsWith('/var/') ? physical.replace('/var/', '/private/var/') : undefined;
    if (alternate === undefined) {
      t.skip('fixture is not below a /var alias');
      return;
    }
    try {
      lstatSync(alternate);
    } catch {
      t.skip('host exposes no usable /var and /private/var alias');
      return;
    }
    const protectedRoot = paths.resolveProtectedRoot(`${alternate}/live-agent/auth.json`, { flag: 'QLB_PI_AUTH_JSON_PATH', cwd: join(root, 'safe') });
    const resolved = paths.resolveMigratePath(file(`${physical}/live-agent/new.json`, join(root, 'safe')), { flag: '--auth-json', kind: 'file' });
    assert.equal(paths.isInsideProtectedRoot(resolved, protectedRoot), true);
  }));

  it('21 migrate resolves a symlinked protected root', () => withFixture((root) => {
    const live = join(root, 'live-agent');
    const safe = join(root, 'safe');
    const rootLink = join(root, 'root-link');
    writeFileSync(join(live, 'auth.json'), '{}');
    symlinkSync(live, rootLink);
    const protectedRoot = paths.resolveProtectedRoot(join(rootLink, 'auth.json'), { flag: 'QLB_PI_AUTH_JSON_PATH', cwd: safe });
    const directPhysicalCandidate = paths.resolveMigratePath(file(join(live, 'new.json'), safe), { flag: '--auth-json', kind: 'file' });
    assert.equal(paths.isInsideProtectedRoot(directPhysicalCandidate, protectedRoot), true);
  }));

  it('22 migrate fails closed when the protected root is missing', () => withFixture((root) => {
    const safe = join(root, 'safe');
    assert.throws(
      () => paths.resolveProtectedRoot(join(root, 'missing-root', 'auth.json'), { flag: 'QLB_PI_AUTH_JSON_PATH', cwd: safe }),
      { message: 'unsafe-migrate-path: protected Pi directory is missing' },
    );
    symlinkSync('missing-root', join(root, 'dangling-root'));
    assert.throws(
      () => paths.resolveProtectedRoot(join(root, 'dangling-root', 'auth.json'), { flag: 'QLB_PI_AUTH_JSON_PATH', cwd: safe }),
      { message: 'unsafe-migrate-path: protected Pi directory is missing' },
    );
    assert.throws(() => lstatSync(join(root, 'missing-root')), { code: 'ENOENT' });
  }));

  it('23 migrate refuses lookup errors instead of treating them as outside', () => withFixture((root) => {
    const live = join(root, 'live-agent');
    const safe = join(root, 'safe');
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const io = Object.assign(new Error('io'), { code: 'EIO' });
    unsafe(() => paths.resolveMigratePath('/safe/auth.json', { flag: '--auth-json', kind: 'file', fs: { lstatSync: () => { throw denied; }, readlinkSync, statSync: () => { throw denied; } } }), /EACCES/);
    unsafe(() => paths.resolveMigratePath('/safe/auth.json', { flag: '--auth-json', kind: 'file', fs: { lstatSync: () => { throw io; }, readlinkSync, statSync: () => { throw io; } } }), /EIO/);

    symlinkSync('target', join(safe, 'readlink-error'));
    unsafe(() => paths.resolveMigratePath(join(safe, 'readlink-error'), {
      flag: '--auth-json', kind: 'file', fs: { lstatSync, readlinkSync: () => { throw io; }, statSync },
    }), /EIO/);

    writeFileSync(join(live, 'auth.json'), '{}');
    const protectedRoot = paths.resolveProtectedRoot(join(live, 'auth.json'), { flag: 'QLB_PI_AUTH_JSON_PATH', cwd: safe });
    protectedRoot.fs = { lstatSync, readlinkSync, statSync: () => { throw denied; } };
    const candidate = paths.resolveMigratePath(file(join(live, 'new.json'), safe), { flag: '--auth-json', kind: 'file' });
    unsafe(() => paths.isInsideProtectedRoot(candidate, protectedRoot), /EACCES/);
    protectedRoot.fs = { lstatSync, readlinkSync, statSync };
    (protectedRoot as unknown as { identities: [] }).identities = [];
    unsafe(() => paths.isInsideProtectedRoot(candidate, protectedRoot), /protected root has no identities/);

    writeFileSync(join(safe, 'not-a-directory'), '{}');
    unsafe(() => paths.resolveProtectedRoot(join(safe, 'not-a-directory', 'auth.json'), { flag: 'QLB_PI_AUTH_JSON_PATH', cwd: safe }), /ENOTDIR/);
  }));

  it('entry-oriented leaves reject symlinks while auth leaves may follow them', () => withFixture((root) => {
    const safe = join(root, 'safe');
    writeFileSync(join(safe, 'actual.json'), '{}');
    symlinkSync('actual.json', join(safe, 'entry.json'));
    unsafe(() => paths.resolveMigratePath(file('entry.json', safe), { flag: '--owner-file', kind: 'file', entryLeaf: true }), /symlinked entry path/);
    assert.equal(paths.resolveMigratePath(file('entry.json', safe), { flag: '--auth-json', kind: 'file' }).endpoint, 'file');
  }));

  it('33 migrate handles root and trailing-separator directory arguments without converting them to cwd', () => withFixture((root) => {
    const safe = join(root, 'safe');
    assert.equal(dir('/', safe), '/');
    assert.equal(dir(`${safe}/`, safe), safe);
    unsafe(() => dir('//', safe), /double-leading slashes/);
    unsafe(() => dir('///', safe), /double-leading slashes/);
    unsafe(() => file(`${safe}/auth.json/`, safe), /trailing slash/);
    unsafe(() => paths.resolveMigratePath(`${safe}/auth.json/`, { flag: '--auth-json', kind: 'file' }), /trailing slash/);
  }));

  it('34 migrate rejects a non-UTF8 symlink target rather than decoding a different pathname', () => withFixture((root) => {
    const safe = join(root, 'safe');
    symlinkSync(Buffer.from([0xc3, 0x28]), join(safe, 'bad-link'));
    unsafe(() => paths.resolveMigratePath(file('bad-link', safe), { flag: '--auth-json', kind: 'file' }), /non-UTF-8 symlink target/);
  }));

  it('35 migrate preserves a BOM in a symlink target rather than following the BOM-stripped name', () => withFixture((root) => {
    const safe = join(root, 'safe');
    const bomDirectory = join(safe, '\ufefftarget');
    mkdirSync(bomDirectory);
    mkdirSync(join(safe, 'target'));
    writeFileSync(join(bomDirectory, 'auth.json'), '{}');
    symlinkSync(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('target')]), join(safe, 'bom-link'));
    const protectedRoot = paths.resolveProtectedRoot(join(bomDirectory, 'auth.json'), { flag: 'QLB_PI_AUTH_JSON_PATH', cwd: safe });
    const resolved = paths.resolveMigratePath(file('bom-link/auth.json', safe), { flag: '--auth-json', kind: 'file' });
    assert.equal(resolved.physical, realpathSync.native(join(bomDirectory, 'auth.json')));
    assert.equal(paths.isInsideProtectedRoot(resolved, protectedRoot), true);
  }));

  it('36 migrate refuses every reserved darwin root entry in raw input, symlink targets, and protected roots', () => withFixture((root) => {
    const safe = join(root, 'safe');
    for (const raw of ['/.nofollow/.vol/1/2/auth.json', '/.VOL/1/2/auth.json', '/.Vol/1/2/auth.json', '/.resolve/1/auth.json']) {
      unsafe(() => paths.validateRawMigratePath(raw, {
        flag: '--auth-json', kind: 'file', cwd: safe, platform: 'darwin',
      }), /reserved root entry/);
    }
    assert.equal(paths.validateRawMigratePath(join(root, 'safe', '.config', 'auth.json'), {
      flag: '--auth-json', kind: 'file', cwd: safe, platform: 'darwin',
    }), join(root, 'safe', '.config', 'auth.json'));
    unsafe(() => paths.resolveMigratePath('/.Vol/1/2/auth.json', {
      flag: '--auth-json', kind: 'file', platform: 'darwin',
    }), /reserved root entry/);
    if (process.platform === 'darwin') {
      try {
        lstatSync('/.nofollow');
        unsafe(() => paths.validateRawMigratePath('/.nofollow/.vol/1/2/auth.json', {
          flag: '--auth-json', kind: 'file', cwd: safe,
        }), /reserved root entry/);
      } catch (error) {
        if (error instanceof paths.MigratePathError) throw error;
        assert.equal((error as { code?: string }).code, 'ENOENT');
      }
    }

    symlinkSync(Buffer.from('/.nofollow/target'), join(safe, 'reserved-link'));
    unsafe(() => paths.resolveMigratePath(join(safe, 'reserved-link'), {
      flag: '--auth-json', kind: 'file', platform: 'darwin',
    }), /reserved root entry/);
    unsafe(() => paths.resolveProtectedRoot('/.vol/1/auth.json', {
      flag: 'QLB_PI_AUTH_JSON_PATH', cwd: safe, platform: 'darwin',
    }), /reserved root entry/);
  }));

  it('37 migrate refuses a root-level relative symlink into a reserved Darwin root entry and accepts only grammatically valid physical results', () => {
    const unexpectedLookup = Object.assign(new Error('unexpected lookup'), { code: 'EIO' });
    const fakeFs = {
      lstatSync(path: string) {
        if (path === '/root-link') return { isSymbolicLink: () => true };
        throw unexpectedLookup;
      },
      readlinkSync(path: string) {
        assert.equal(path, '/root-link');
        return Buffer.from('.vol/1/2');
      },
      statSync() { throw unexpectedLookup; },
    };
    unsafe(() => paths.resolveMigratePath('/root-link/auth.json', {
      flag: '--auth-json', kind: 'file', fs: fakeFs as unknown as paths.MigratePathFs, platform: 'darwin',
    }), /reserved root entry/);

    withFixture((root) => {
      const safe = join(root, 'safe');
      const resolved = paths.resolveMigratePath(file('auth.json', safe), { flag: '--auth-json', kind: 'file' });
      assert.equal(paths.validateRawMigratePath(resolved.physical, {
        flag: '--auth-json', kind: 'file', cwd: safe,
      }), resolved.physical);
    });
  });

  it('P7g-1r residual: resolver result grammar post-condition remains', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'migrate-paths.ts'), 'utf8');
    assert.match(source, /const result = \(resolved: ResolvedMigratePath\): ResolvedMigratePath => \{/);
    assert.match(source, /const acceptedPhysical = validateRawMigratePath\(resolved\.physical,/);
    assert.match(source, /if \(acceptedPhysical !== resolved\.physical\) pathError\(flag, 'resolved physical path changed during validation'\);/);
  });

  it('38 migrate protects both a dangling symlinked auth leaf directory and its target anchor directory', () => withFixture((root) => {
    const live = join(root, 'live-agent');
    const safe = join(root, 'safe');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(join(elsewhere, 'missing.json'), join(live, 'auth.json'));
    const protectedRoot = paths.resolveProtectedRoot(join(live, 'auth.json'), { flag: 'QLB_PI_AUTH_JSON_PATH', cwd: safe });
    const linkedDirectoryCandidate = paths.resolveMigratePath(file(join(live, 'new.json'), safe), { flag: '--auth-json', kind: 'file' });
    const targetDirectoryCandidate = paths.resolveMigratePath(file(join(elsewhere, 'new.json'), safe), { flag: '--auth-json', kind: 'file' });
    assert.equal(paths.isInsideProtectedRoot(linkedDirectoryCandidate, protectedRoot), true);
    assert.equal(paths.isInsideProtectedRoot(targetDirectoryCandidate, protectedRoot), true);
  }));

  it('39 migrate protects an existing symlinked auth leaf target directory', () => withFixture((root) => {
    const live = join(root, 'live-agent');
    const safe = join(root, 'safe');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'real-auth.json'), '{}');
    symlinkSync(join(elsewhere, 'real-auth.json'), join(live, 'auth.json'));
    const protectedRoot = paths.resolveProtectedRoot(join(live, 'auth.json'), { flag: 'QLB_PI_AUTH_JSON_PATH', cwd: safe });
    const targetDirectoryCandidate = paths.resolveMigratePath(file(join(elsewhere, 'new.json'), safe), { flag: '--auth-json', kind: 'file' });
    assert.equal(paths.isInsideProtectedRoot(targetDirectoryCandidate, protectedRoot), true);
  }));

  it('40 migrate finds a protected ancestor identity for deep existing and missing candidates', () => withFixture((root) => {
    const live = join(root, 'live-agent');
    const safe = join(root, 'safe');
    mkdirSync(join(live, 'sub'));
    mkdirSync(join(live, 'sub', 'deep'));
    writeFileSync(join(live, 'auth.json'), '{}');
    writeFileSync(join(live, 'sub', 'deep', 'existing.json'), '{}');
    const protectedRoot = paths.resolveProtectedRoot(join(live, 'auth.json'), { flag: 'QLB_PI_AUTH_JSON_PATH', cwd: safe });
    const existing = paths.resolveMigratePath(file(join(live, 'sub', 'deep', 'existing.json'), safe), { flag: '--auth-json', kind: 'file' });
    const missing = paths.resolveMigratePath(file(join(live, 'sub', 'deep', 'missing.json'), safe), { flag: '--auth-json', kind: 'file' });
    const deep = realpathSync.native(join(live, 'sub', 'deep'));
    assert.equal(existing.anchor, deep);
    assert.equal(missing.anchor, deep);
    assert.equal(paths.isInsideProtectedRoot(existing, protectedRoot), true);
    assert.equal(paths.isInsideProtectedRoot(missing, protectedRoot), true);
  }));

  it('refuses Windows explicitly through the exported platform check', () => {
    unsafe(() => paths.assertSupportedPlatform('win32'), /Windows/);
    assert.doesNotThrow(() => paths.assertSupportedPlatform('linux'));
  });
});
