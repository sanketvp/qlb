import assert from 'node:assert/strict';
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

type Fsutil = {
  atomicWriteBytes(path: string, data: Uint8Array, options?: { mode?: number; followSymlinks?: boolean }): number;
  atomicWriteText(path: string, text: string, options?: { mode?: number; followSymlinks?: boolean }): number;
  publishTarget(path: string): string;
  sweepStrayTemps(dir: string): number;
};

// Kept as require so this red-first test compiles before src/fsutil.ts exists.
const fsutil = require('../src/fsutil') as Fsutil;
const mutableFs = require('node:fs') as {
  renameSync: typeof renameSync;
  fchmodSync: typeof fchmodSync;
  fsyncSync: typeof fsyncSync;
  fstatSync: typeof fstatSync;
  statSync: typeof statSync;
};

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'qlb-fsutil-'));
}

function withFixture(run: (dir: string) => void): void {
  const dir = fixture();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('fsutil atomic publish primitives', () => {
  it('publishes by rename, returns its fd inode, and has no fallible path stat after rename', () => withFixture((dir) => {
    const target = join(dir, '.claude.json');
    writeFileSync(target, 'old');
    const before = statSync(target).ino;
    const originalRename = mutableFs.renameSync;
    const originalFstat = mutableFs.fstatSync;
    const originalStat = mutableFs.statSync;
    const calls: string[] = [];
    let inode: number;
    mutableFs.fstatSync = ((fd: number) => {
      calls.push('fstat');
      return originalFstat(fd);
    }) as typeof fstatSync;
    mutableFs.renameSync = ((...args: Parameters<typeof renameSync>) => {
      calls.push('rename');
      return originalRename(...args);
    }) as typeof renameSync;
    mutableFs.statSync = (() => {
      throw new Error('post-rename stat must not run');
    }) as typeof statSync;
    try {
      inode = fsutil.atomicWriteText(target, 'new');
    } finally {
      mutableFs.fstatSync = originalFstat;
      mutableFs.renameSync = originalRename;
      mutableFs.statSync = originalStat;
    }

    assert.deepEqual(calls, ['fstat', 'rename']);
    assert.equal(readFileSync(target, 'utf8'), 'new');
    assert.equal(inode!, statSync(target).ino);
    assert.notEqual(inode!, before);
    assert.deepEqual(readdirSync(dir), ['.claude.json']);
  }));

  it('leaves the destination untouched and removes its temp when rename fails', () => withFixture((dir) => {
    const target = join(dir, 'config.json');
    writeFileSync(target, 'old');
    const original = mutableFs.renameSync;
    mutableFs.renameSync = () => {
      const error = new Error('injected rename failure') as NodeJS.ErrnoException;
      error.code = 'ENOSPC';
      throw error;
    };
    try {
      assert.throws(() => fsutil.atomicWriteText(target, 'new'));
    } finally {
      mutableFs.renameSync = original;
    }
    assert.equal(readFileSync(target, 'utf8'), 'old');
    assert.deepEqual(readdirSync(dir), ['config.json']);
  }));

  it('creates the temp private before any chmod and honors the requested final mode', () => withFixture((dir) => {
    const target = join(dir, 'secret.json');
    const original = mutableFs.fchmodSync;
    let creationMode: number | undefined;
    mutableFs.fchmodSync = (fd, mode) => {
      creationMode = fstatSync(fd).mode & 0o777;
      return original(fd, mode);
    };
    try {
      fsutil.atomicWriteText(target, '{}', { mode: 0o640 });
    } finally {
      mutableFs.fchmodSync = original;
    }
    assert.equal(creationMode, 0o600);
    assert.equal(statSync(target).mode & 0o777, 0o640);
  }));

  it('aborts before publishing when setting the final mode fails', () => withFixture((dir) => {
    const target = join(dir, 'secret.json');
    writeFileSync(target, 'old');
    const original = mutableFs.fchmodSync;
    mutableFs.fchmodSync = () => {
      const error = new Error('fchmod denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    };
    try {
      assert.throws(() => fsutil.atomicWriteText(target, 'new'), { code: 'EPERM' });
    } finally {
      mutableFs.fchmodSync = original;
    }
    assert.equal(readFileSync(target, 'utf8'), 'old');
    assert.deepEqual(readdirSync(dir), ['secret.json']);
  }));

  it('cleans up after an interrupted fsync', () => withFixture((dir) => {
    const target = join(dir, 'config.json');
    writeFileSync(target, 'old');
    const original = mutableFs.fsyncSync;
    mutableFs.fsyncSync = () => { throw new Error('interrupted'); };
    try {
      assert.throws(() => fsutil.atomicWriteText(target, 'new'));
    } finally {
      mutableFs.fsyncSync = original;
    }
    assert.equal(readFileSync(target, 'utf8'), 'old');
    assert.deepEqual(readdirSync(dir), ['config.json']);
  }));

  it('tolerates unsupported fsync but surfaces real fsync errors', () => withFixture((dir) => {
    const target = join(dir, 'config.json');
    const original = mutableFs.fsyncSync;
    mutableFs.fsyncSync = () => {
      const error = new Error('unsupported') as NodeJS.ErrnoException;
      error.code = 'EINVAL';
      throw error;
    };
    try {
      fsutil.atomicWriteText(target, 'new');
    } finally {
      mutableFs.fsyncSync = original;
    }
    assert.equal(readFileSync(target, 'utf8'), 'new');

    mutableFs.fsyncSync = () => {
      const error = new Error('io failure') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    };
    try {
      assert.throws(() => fsutil.atomicWriteText(target, 'newer'));
    } finally {
      mutableFs.fsyncSync = original;
    }
    assert.equal(readFileSync(target, 'utf8'), 'new');
  }));

  it('does not create a missing parent', () => withFixture((dir) => {
    const parent = join(dir, 'missing');
    assert.throws(() => fsutil.atomicWriteText(join(parent, 'config.json'), '{}'), { code: 'ENOENT' });
    assert.throws(() => statSync(parent), { code: 'ENOENT' });
  }));

  it('round-trips bytes', () => withFixture((dir) => {
    const target = join(dir, 'blob.bin');
    const payload = Buffer.from(Array.from({ length: 76800 }, (_, index) => index % 256));
    fsutil.atomicWriteBytes(target, payload);
    assert.deepEqual(readFileSync(target), payload);
  }));

  it('writes through a symlink and preserves it', () => withFixture((dir) => {
    const tracked = join(dir, 'tracked.json');
    const link = join(dir, '.claude.json');
    writeFileSync(tracked, 'old');
    symlinkSync(tracked, link);

    fsutil.atomicWriteText(link, 'new');

    assert.equal(readFileSync(tracked, 'utf8'), 'new');
    assert.equal(statSync(link).isSymbolicLink(), false, 'stat follows links');
    assert.equal(require('node:fs').lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(readdirSync(dir).sort(), ['.claude.json', 'tracked.json']);
  }));

  it('follows a relative two-hop symlink chain', () => withFixture((dir) => {
    const real = join(dir, 'real');
    require('node:fs').mkdirSync(real);
    const final = join(real, 'final.json');
    writeFileSync(final, 'old');
    symlinkSync(join('real', 'final.json'), join(dir, 'hop2'));
    symlinkSync('hop2', join(dir, 'hop1'));

    fsutil.atomicWriteText(join(dir, 'hop1'), 'new');

    assert.equal(readFileSync(final, 'utf8'), 'new');
    assert.equal(fsutil.publishTarget(join(dir, 'hop1')), realpathSync.native(final));
  }));

  it('writes a dangling symlink at its intended final referent', () => withFixture((dir) => {
    const gone = join(dir, 'gone');
    require('node:fs').mkdirSync(gone);
    const link = join(dir, '.claude.json');
    const destination = join(gone, 'config.json');
    symlinkSync(destination, link);

    fsutil.atomicWriteText(link, '{}');

    assert.equal(require('node:fs').lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(destination, 'utf8'), '{}');
  }));

  it('replaces rather than follows a link when followSymlinks is false', () => withFixture((dir) => {
    const target = join(dir, 'target.json');
    const link = join(dir, 'export.json');
    writeFileSync(target, 'untouched');
    symlinkSync(target, link);

    fsutil.atomicWriteText(link, 'export', { followSymlinks: false });

    assert.equal(require('node:fs').lstatSync(link).isSymbolicLink(), false);
    assert.equal(readFileSync(link, 'utf8'), 'export');
    assert.equal(readFileSync(target, 'utf8'), 'untouched');
  }));

  it('refuses a symlink loop hidden behind dotdot without creating a temp', () => withFixture((dir) => {
    const victim = join(dir, 'victim.json');
    const loop = join(dir, 'loop');
    const config = join(dir, 'config.json');
    writeFileSync(victim, 'victim');
    symlinkSync('loop', loop);
    symlinkSync('loop/../victim.json', config);

    assert.throws(() => fsutil.atomicWriteText(config, '{}'), { code: 'ELOOP' });

    assert.equal(readFileSync(victim, 'utf8'), 'victim');
    assert.deepEqual(readdirSync(dir).sort(), ['config.json', 'loop', 'victim.json']);
  }));

  it('refuses a symlink loop without creating a temp', () => withFixture((dir) => {
    const loop = join(dir, 'loop.json');
    symlinkSync('loop.json', loop);

    assert.throws(() => fsutil.atomicWriteText(loop, '{}'), { code: 'ELOOP' });

    assert.deepEqual(readdirSync(dir), ['loop.json']);
  }));

  it('returns a plain path unchanged from publishTarget', () => withFixture((dir) => {
    const target = join(dir, 'plain.json');
    assert.equal(fsutil.publishTarget(target), target);
    writeFileSync(target, 'x');
    assert.equal(fsutil.publishTarget(target), target);
  }));

  it('keeps temporary names bounded for destinations near NAME_MAX', () => withFixture((dir) => {
    const target = join(dir, `${'x'.repeat(245)}.cswap`);
    writeFileSync(target, 'old');
    fsutil.atomicWriteText(target, 'new');
    assert.equal(readFileSync(target, 'utf8'), 'new');
    assert.deepEqual(readdirSync(dir), [`${'x'.repeat(245)}.cswap`]);
  }));

  it('sweeps only old qlb temporary files and never follows symlinks', () => withFixture((dir) => {
    const oldTemp = join(dir, '.qlb-config.json.a.tmp');
    const freshTemp = join(dir, '.qlb-other.b.tmp');
    const protectedTarget = join(dir, 'protected.json');
    const tempSymlink = join(dir, '.qlb-link.c.tmp');
    writeFileSync(oldTemp, 'orphan');
    writeFileSync(freshTemp, 'live writer');
    writeFileSync(protectedTarget, 'keep');
    symlinkSync(protectedTarget, tempSymlink);
    const old = new Date(Date.now() - 61_000);
    utimesSync(oldTemp, old, old);

    assert.equal(fsutil.sweepStrayTemps(dir), 1);
    assert.deepEqual(readdirSync(dir).sort(), ['.qlb-link.c.tmp', '.qlb-other.b.tmp', 'protected.json']);
    assert.equal(lstatSync(tempSymlink).isSymbolicLink(), true);
    assert.equal(readFileSync(protectedTarget, 'utf8'), 'keep');
  }));
});
