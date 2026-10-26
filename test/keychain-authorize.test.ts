import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/config';
import { beginCutover } from '../src/lifecycle';
import { runKeychainCommand } from '../src/commands/keychain';
import { openStore } from '../src/store';
import type { CommandContext } from '../src/registry';

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
