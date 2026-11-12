import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import childProcess = require('node:child_process');
import { closeSync, existsSync, openSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { mock } from 'node:test';
import { defaultHelperRunner } from '../src/commands/keychain';
import { keychainRequestFromArgv, runKeychainClientSync } from '../src/keychain-client';
import { portableLockf } from './support/portable-lockf';

import { defaultConfig } from '../src/config';
import { beginCutover } from '../src/lifecycle';
import { runKeychainCommand } from '../src/commands/keychain';
import { openStore } from '../src/store';
import type { CommandContext } from '../src/registry';
import { KeychainClientNotStarted, KeychainRequestStillWaiting } from '../src/keychain-client';

function fixture(): { home: string; context: CommandContext; cleanup(): void } {
  const home = mkdtempSync(join(tmpdir(), 'qlb-keychain-authorize-'));
  const config = defaultConfig(home);
  const context: CommandContext = {
    config,
    env: { USER: 'fixture-user' },
    home,
    stdout: () => {},
    stderr: () => {},
    loadConfig: () => config,
    registerSecret: () => {},
    deliverSecret: () => {},
    knownSecrets: () => [],
  };
  mkdirSync(join(home, '.claude-swap-backup'), { recursive: true });
  writeFileSync(config.cswapSequencePath, JSON.stringify({
    sequence: [1],
    accounts: { '1': { email: 'one@example.test' } },
  }));
  return { home, context, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('keychain authorize (AC55)', () => {
  it('uses read probes only for live items and records the authorization', async () => {
    const f = fixture();
    const calls: string[][] = [];
    try {
      const exit = await runKeychainCommand(['authorize'], f.context, {
        helperPath: () => '/fixture/qlb-keychain-helper',
        helperRunner: (_path, args) => { calls.push([...args]); },
      });

      assert.equal(exit, 0);
      assert.deepEqual(calls, [
        ['probe-read', 'Claude Code-credentials', 'fixture-user'],
        ['probe-read', 'claude-swap', 'account-1-one@example.test'],
      ]);
      assert.equal(calls.some(([verb]) => verb === 'set'), false);
      const store = openStore(f.context.config.dbPath);
      try { assert.ok(store.getConfig('keychain.liveItemsReadAuthorizedAt')); } finally { store.close(); }
    } finally { f.cleanup(); }
  });

  it('records the signed helper identity with read authorization', async () => {
    const f = fixture();
    try {
      const exit = await runKeychainCommand(['authorize'], f.context, {
        helperPath: () => '/fixture/qlb-keychain-helper',
        helperRunner: () => {},
        helperSigning: () => ({ authority: 'QLB Keychain Helper', binaryHash: 'binary-hash', identityHash: 'identity-hash' }),
      });

      assert.equal(exit, 0);
      const store = openStore(f.context.config.dbPath);
      try { assert.equal(store.getConfig('keychain.liveItemsReadAuthorizedIdentityHash'), 'identity-hash'); } finally { store.close(); }
    } finally { f.cleanup(); }
  });

  it('falls through an absent default-profile service to Claude Code’s unsuffixed fallback', async () => {
    const f = fixture();
    const calls: string[][] = [];
    const configDirectory = join(f.home, '.claude');
    mkdirSync(configDirectory);
    f.context.env.CLAUDE_CONFIG_DIR = configDirectory;
    const suffixed = `Claude Code-credentials-${createHash('sha256').update(configDirectory.normalize('NFC'), 'utf8').digest('hex').slice(0, 8)}`;
    try {
      const exit = await runKeychainCommand(['authorize'], f.context, {
        helperPath: () => '/fixture/qlb-keychain-helper',
        helperRunner: (_path, args) => {
          calls.push([...args]);
          if (args[1] === suffixed) throw Object.assign(new Error('not found'), { exitCode: 4 });
        },
      });

      assert.equal(exit, 0);
      assert.deepEqual(calls, [
        ['probe-read', suffixed, 'fixture-user'],
        ['probe-read', 'Claude Code-credentials', 'fixture-user'],
        ['probe-read', 'claude-swap', 'account-1-one@example.test'],
      ]);
    } finally { f.cleanup(); }
  });

  it('requires cutting-over and a drained C-swap process table before every CAS write', async () => {
    const f = fixture();
    const calls: string[][] = [];
    const value = Buffer.from('R0');
    try {
      const preCutover = await runKeychainCommand(['authorize', 'cswap'], f.context, {
        helperPath: () => '/fixture/qlb-keychain-helper',
        helperRunner: (_path, args) => { calls.push([...args]); },
        readCswapItem: () => Buffer.from(value),
        listCswapProcesses: () => [],
      });
      assert.equal(preCutover, 3);
      assert.equal(calls.length, 0);

      const store = openStore(f.context.config.dbPath);
      beginCutover(store);
      store.close();
      const exit = await runKeychainCommand(['authorize', 'cswap'], f.context, {
        helperPath: () => '/fixture/qlb-keychain-helper',
        helperRunner: (_path, args, input) => {
          calls.push([...args]);
          assert.deepEqual(input, Buffer.from('R0'));
        },
        readCswapItem: () => Buffer.from(value),
        listCswapProcesses: () => [],
      });

      assert.equal(exit, 0);
      assert.deepEqual(calls, [[
        'set', '--if-sha256', createHash('sha256').update('R0').digest('hex'),
        'claude-swap', 'account-1-one@example.test',
      ]]);
      const reopened = openStore(f.context.config.dbPath);
      try { assert.ok(reopened.getConfig('keychain.cswapItemsAuthorizedAt')); } finally { reopened.close(); }
    } finally { f.cleanup(); }
  });

  it('leaves a rotation during the authorization prompt in place when CAS detects it', async () => {
    const f = fixture();
    let stored = Buffer.from('R0');
    try {
      const store = openStore(f.context.config.dbPath);
      beginCutover(store);
      store.close();
      const exit = await runKeychainCommand(['authorize', 'cswap'], f.context, {
        helperPath: () => '/fixture/qlb-keychain-helper',
        readCswapItem: () => Buffer.from(stored),
        listCswapProcesses: () => [],
        helperRunner: (_path, args) => {
          stored = Buffer.from('R1'); // Rotation during the authorization prompt.
          const expected = args[2]!;
          if (createHash('sha256').update(stored).digest('hex') !== expected) {
            throw Object.assign(new Error('changed'), { exitCode: 3 });
          }
        },
      });

      assert.equal(exit, 3);
      assert.deepEqual(stored, Buffer.from('R1'));
      const reopened = openStore(f.context.config.dbPath);
      try { assert.equal(reopened.getConfig('keychain.cswapItemsAuthorizedAt'), null); } finally { reopened.close(); }
    } finally { f.cleanup(); }
  });

  it('detects a staged-helper pathname replacement after spawn before it writes the payload to stdin', async () => {
    const f = fixture();
    const helpers = mkdtempSync(join(f.home, 'helpers-'));
    const source = join(helpers, 'trusted-helper');
    const replacementOutput = join(helpers, 'replacement-stdin');
    // The replacement writes its stdin only if the process executes its pathname.
    writeFileSync(source, '#!/bin/sh\nexit 0\n', { mode: 0o500 });
    chmodSync(source, 0o500);
    try {
      const store = openStore(f.context.config.dbPath);
      beginCutover(store);
      store.close();
      const exit = await runKeychainCommand(['authorize', 'cswap'], f.context, {
        helperPath: () => source,
        stageAuthorizedHelper: true,
        helperSigning: () => ({ authority: 'QLB Keychain Helper', binaryHash: 'binary-hash', identityHash: 'identity-hash' }),
        readCswapItem: () => Buffer.from('R0'),
        listCswapProcesses: () => [],
        afterAuthorizedHelperVerified: (staged) => {
          const replacement = join(helpers, 'replacement-helper');
          writeFileSync(replacement, `#!/bin/sh\ncat > ${replacementOutput}\n`, { mode: 0o500 });
          chmodSync(replacement, 0o500);
          renameSync(replacement, staged);
        },
      });

      assert.equal(exit, 1);
      assert.equal(readFileSync(replacementOutput, { encoding: 'utf8', flag: 'a+' }), '');
    } finally { f.cleanup(); }
  });

  it('leaves an intervening fake-keychain rotation in place when the update query matches its observed version', () => {
    class FakeKeychain {
      value = Buffer.from('R0');
      modificationDate = 1;

      copyMatching(): { data: Buffer; modificationDate: number; persistentRef: string } {
        return { data: Buffer.from(this.value), modificationDate: this.modificationDate, persistentRef: 'item-1' };
      }

      rotate(value: string): void {
        this.value = Buffer.from(value);
        this.modificationDate += 1;
      }

      update(query: { modificationDate: number; persistentRef: string }, replacement: Buffer): boolean {
        if (query.persistentRef !== 'item-1' || query.modificationDate !== this.modificationDate) return false;
        this.value = Buffer.from(replacement);
        this.modificationDate += 1;
        return true;
      }
    }

    const keychain = new FakeKeychain();
    const expected = createHash('sha256').update('R0').digest('hex');
    const observed = keychain.copyMatching();
    assert.equal(createHash('sha256').update(observed.data).digest('hex'), expected);
    keychain.rotate('R1'); // The competing writer wins after read/compare but before update.
    const wrote = keychain.update({ modificationDate: observed.modificationDate, persistentRef: observed.persistentRef }, Buffer.from('QLB'));

    assert.equal(wrote, false);
    assert.deepEqual(keychain.value, Buffer.from('R1'));
  });

  it('keeps probe data in the helper and makes CAS match the observed Keychain record version before update', () => {
    const source = readFileSync('native/keychain-helper/main.swift', 'utf8');
    assert.match(source, /private func probeRead[\s\S]*kSecReturnData[\s\S]*resetBytes[\s\S]*probe-read/);
    const cas = source.match(/private func setIfSha256[\s\S]*?\n}\n\n\/\*\* Reads a protected item/)?.[0] ?? '';
    assert.match(cas, /kSecReturnAttributes[\s\S]*kSecReturnPersistentRef[\s\S]*SecItemCopyMatching[\s\S]*SHA256/);
    assert.match(cas, /casQuery\[kSecAttrModificationDate\] = modificationDate[\s\S]*casQuery\[kSecValuePersistentRef\] = persistentRef[\s\S]*SecItemUpdate\(casQuery/);
    assert.doesNotMatch(cas, /compareQuery|\[kSecValueData\] = stored/);
    assert.match(cas, /developer\.apple\.com\/documentation\/security\/secitemupdate/);
    assert.match(cas, /developer\.apple\.com\/documentation\/security\/ksecattrmodificationdate/);
    assert.match(source, /case \(5, "set"\) where args\[1\] == "--if-sha256"/);
  });
});

describe('keychain authorize S3 error messages', () => {
  for (const [name, error, message] of [
    ['still waiting', new KeychainRequestStillWaiting('claude-swap'), 'qlb keychain: a Keychain request for claude-swap is still waiting for an answer'],
    ['not started', new KeychainClientNotStarted('claude-swap', 'x'), 'qlb keychain: Keychain request for claude-swap was not started: x'],
  ] as const) {
    it(`prints the C-swap ${name} message`, async () => {
      const f = fixture();
      const errors: string[] = [];
      f.context.stderr = (line) => errors.push(line);
      try {
        const store = openStore(f.context.config.dbPath);
        beginCutover(store);
        store.close();
        const exit = await runKeychainCommand(['authorize', 'cswap'], f.context, {
          readCswapItem: () => { throw error; },
          listCswapProcesses: () => [],
        });
        assert.equal(exit, 1);
        assert.deepEqual(errors, [message]);
      } finally { f.cleanup(); }
    });
  }
});

function s4State(): { dir: string; lockfPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-s4-helper-'));
  return { dir, lockfPath: portableLockf(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function s4Fake(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function boundedPoll(path: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  assert.ok(existsSync(path), `expected ${path}`);
}

describe('keychain authorize S4 async helper runner', () => {
  it('holds the service lock without signalling a long probe', { timeout: 30_000 }, async () => {
    const s = s4State();
    const signalled = join(s.dir, 'signalled');
    const fake = s4Fake(s.dir, 'slow-probe', `trap 'echo signal > "${signalled}"' TERM HUP
sleep 7`);
    try {
      const started = Date.now();
      await defaultHelperRunner(fake, ['probe-read', 'svc-s4-long', 'a'], undefined, undefined, null, { lockfPath: s.lockfPath });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 6_500 && elapsed < 20_000, `elapsed ${elapsed}ms`);
      assert.equal(existsSync(signalled), false);
    } finally { s.cleanup(); }
  });

  it('passes set payload on stdin after the pre-spawn checks', { timeout: 30_000 }, async () => {
    const s = s4State();
    const copied = join(s.dir, 'stdin-copy');
    const fake = s4Fake(s.dir, 'stdin-helper', `cat > "${copied}"`);
    const payload = Buffer.from('s4-fixture-payload');
    try {
      await defaultHelperRunner(fake, ['set', '--if-sha256', 'd', 'svc-s4-payload', 'a'], payload, undefined, null, { lockfPath: s.lockfPath });
      assert.deepEqual(readFileSync(copied), payload);
    } finally { s.cleanup(); }
  });

  it('rejects replacement, signing, and symlink mismatches before spawning', async () => {
    const s = s4State();
    const trusted = s4Fake(s.dir, 'trusted', 'exit 0');
    const replacementRuns = join(s.dir, 'replacement-runs');
    const replacement = s4Fake(s.dir, 'replacement', `echo ran > "${replacementRuns}"`);
    const fd = openSync(trusted, 'r');
    const spawnMock = mock.method(childProcess, 'spawn');
    try {
      await assert.rejects(defaultHelperRunner(replacement, ['probe-read', 'svc-s4-mismatch', 'a'], undefined, fd, null, { lockfPath: s.lockfPath }), /keychain helper changed after verification/);
      await assert.rejects(defaultHelperRunner(trusted, ['probe-read', 'svc-s4-signing', 'a'], undefined, fd, { authority: 'x', binaryHash: 'x', identityHash: 'x' }, { lockfPath: s.lockfPath }), /keychain helper changed after verification/);
      const linked = join(s.dir, 'linked');
      symlinkSync(trusted, linked);
      await assert.rejects(defaultHelperRunner(linked, ['probe-read', 'svc-s4-link', 'a'], undefined, fd, null, { lockfPath: s.lockfPath }), /keychain helper changed after verification/);
      assert.equal(existsSync(replacementRuns), false);
      assert.equal(spawnMock.mock.callCount(), 0);
    } finally {
      spawnMock.mock.restore();
      closeSync(fd);
      s.cleanup();
    }
  });

  it('shares the sync lock and fails fast while a sync client remains alive', { timeout: 30_000 }, async () => {
    const s = s4State();
    const startedFile = join(s.dir, 'started');
    const secondRuns = join(s.dir, 'second-runs');
    const hold = s4Fake(s.dir, 'hold', `echo started > "${startedFile}"
sleep 8`);
    const second = s4Fake(s.dir, 'second', `echo ran > "${secondRuns}"`);
    try {
      assert.throws(() => runKeychainClientSync(keychainRequestFromArgv('security', hold, ['find-generic-password', '-a', 'a', '-w', '-s', 'svc-s4-shared'], { timeoutMs: 3_000, lockfPath: s.lockfPath })), (err: unknown) => (err as { code?: unknown }).code === 'ETIMEDOUT');
      boundedPoll(startedFile, 5_000);
      const began = Date.now();
      await assert.rejects(defaultHelperRunner(second, ['probe-read', 'svc-s4-shared', 'a'], undefined, undefined, null, { lockfPath: s.lockfPath }), KeychainRequestStillWaiting);
      assert.ok(Date.now() - began < 2_000);
      assert.equal(existsSync(secondRuns), false);
    } finally { s.cleanup(); }
  });

  it('keeps a detached helper lock after its QLB parent dies', { timeout: 30_000 }, async () => {
    const s = s4State();
    const ran = join(s.dir, 'ran');
    const after = join(s.dir, 'after');
    const hold = s4Fake(s.dir, 'death-hold', `echo ran > "${ran}"
sleep 6
echo after > "${after}"`);
    const next = s4Fake(s.dir, 'death-next', 'exit 0');
    const caller = join(s.dir, 'caller.cjs');
    writeFileSync(caller, `const { defaultHelperRunner } = require(process.argv[2]);
defaultHelperRunner(process.argv[3], ['probe-read', 'svc-s4-death', 'a'], undefined, undefined, null, { lockfPath: process.argv[4] }).catch(() => {});\n`);
    const child = childProcess.spawn(process.execPath, [caller, resolve('dist-test/src/commands/keychain.js'), hold, s.lockfPath], {
      env: { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: process.env.QLB_HOME!, HOME: process.env.HOME! }, stdio: 'ignore',
    });
    try {
      boundedPoll(ran, 5_000);
      child.kill('SIGKILL');
      const began = Date.now();
      await assert.rejects(defaultHelperRunner(next, ['probe-read', 'svc-s4-death', 'a'], undefined, undefined, null, { lockfPath: s.lockfPath }), KeychainRequestStillWaiting);
      assert.ok(Date.now() - began < 2_000);
      boundedPoll(after, 15_000);
      await defaultHelperRunner(next, ['probe-read', 'svc-s4-death', 'a'], undefined, undefined, null, { lockfPath: s.lockfPath });
    } finally { s.cleanup(); }
  });

  it('surfaces a waiting authorize probe and preserves helper exit mappings', async () => {
    const f = fixture();
    const errors: string[] = [];
    f.context.stderr = (line) => errors.push(line);
    const s = s4State();
    try {
      const exit = await runKeychainCommand(['authorize'], f.context, {
        helperPath: () => '/fixture/qlb-keychain-helper',
        helperRunner: () => Promise.reject(new KeychainRequestStillWaiting('Claude Code-credentials')),
      });
      assert.equal(exit, 1);
      assert.deepEqual(errors, ['qlb keychain: a Keychain request for Claude Code-credentials is still waiting for an answer']);
      for (const [name, status, expected] of [['exit-3', 3, 3], ['exit-4', 4, 4]] as const) {
        const fake = s4Fake(s.dir, name, `exit ${status}`);
        await assert.rejects(defaultHelperRunner(fake, ['probe-read', `svc-s4-${name}`, 'a'], undefined, undefined, null, { lockfPath: s.lockfPath }), (err: unknown) => (err as { exitCode?: unknown }).exitCode === expected);
      }
      const exit75 = s4Fake(s.dir, 'exit-75', 'exit 75');
      await assert.rejects(defaultHelperRunner(exit75, ['probe-read', 'svc-s4-exit-75', 'a'], undefined, undefined, null, { lockfPath: s.lockfPath }), /keychain helper failed/);
    } finally {
      f.cleanup();
      s.cleanup();
    }
  });
});
