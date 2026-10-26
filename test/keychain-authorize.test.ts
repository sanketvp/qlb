import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('stages and verifies a helper copy before a CAS payload reaches it', () => {
    const source = readFileSync('src/commands/keychain.ts', 'utf8');
    assert.match(source, /function withAuthorizedHelper[\s\S]*copyFileSync\(path, staged\)[\s\S]*assertAuthorizationHelper\(staged, dbPath, dependencies\)/);
    assert.match(source, /withAuthorizedHelper\(helper, ctx\.config\.dbPath, dependencies, \(authorizedHelper\) => \{[\s\S]*runner\(authorizedHelper, \['set', '--if-sha256'/);
  });

  it('keeps probe data in the helper and makes CAS compare the stored bytes before update', () => {
    const source = readFileSync('native/keychain-helper/main.swift', 'utf8');
    assert.match(source, /private func probeRead[\s\S]*kSecReturnData[\s\S]*resetBytes[\s\S]*probe-read/);
    const cas = source.match(/private func setIfSha256[\s\S]*?\n}\n\n\/\*\* Reads a protected item/)?.[0] ?? '';
    assert.match(cas, /SecItemCopyMatching[\s\S]*SHA256[\s\S]*SecItemUpdate\(query\(service, account\)/);
    assert.doesNotMatch(cas, /compareQuery|\[kSecValueData\] = stored/);
    assert.match(cas, /developer\.apple\.com\/documentation\/security\/secitemupdate/);
    assert.match(source, /case \(5, "set"\) where args\[1\] == "--if-sha256"/);
  });
});
