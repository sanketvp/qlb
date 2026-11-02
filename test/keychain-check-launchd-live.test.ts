import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runKeychainCommand, type KeychainCommandDependencies, type LiveSwitchReceipt } from '../src/commands/keychain';
import { defaultConfig } from '../src/config';
import { beginCutover } from '../src/lifecycle';
import type { CommandContext } from '../src/registry';
import { openStore, Store } from '../src/store';

const OK_RECEIPT: LiveSwitchReceipt = {
  outcome: 'ok', from: 'a', to: 'a', switchId: 1, attempt: 'launchd-republish',
  reason: null, error: null, outgoingKind: 'own-bytes', steps: { cleanup: [] }, injected: false,
};

function fixture(cuttingOver = true): { context: CommandContext; output: string[]; errors: string[]; cleanup(): void } {
  const home = mkdtempSync(join(tmpdir(), 'qlb-launchd-live-'));
  const config = defaultConfig(home);
  const output: string[] = [];
  const errors: string[] = [];
  const store = openStore(config.dbPath);
  try {
    if (cuttingOver) beginCutover(store);
    store.setActiveLogin('anthropic', 'a', 'manual', 1);
    store.setConfig('keychain.liveItemsReadAuthorizedAt', '1');
  } finally { store.close(); }
  return {
    context: {
      config,
      env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home },
      home,
      stdout: (message) => output.push(message),
      stderr: (message) => errors.push(message),
      loadConfig: () => config,
      registerSecret: () => {},
      deliverSecret: () => {},
      knownSecrets: () => [],
    },
    output,
    errors,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function liveDeps(receipt: LiveSwitchReceipt | { timeout: true } | { inProgress: string }, launched: string[] = []): KeychainCommandDependencies {
  return {
    helperPath: () => '/fixture/qlb-keychain-helper',
    helperConfigReader: (key: string) => key === 'keychain.helperCheckIdentityHash' ? 'pinned-identity' : null,
    helperIdentityVerifier: (): { trusted: true } => ({ trusted: true }),
    runLaunchdLiveSwitch: (activeId: string) => { launched.push(activeId); return receipt; },
  };
}

describe('keychain check-launchd --live (K5b-2)', () => {
  it('an ok receipt records liveItemsAuthorizedAt and the identity hash in one transaction', async () => {
    const f = fixture();
    const launched: string[] = [];
    const original = Store.prototype.runImmediate;
    let transactions = 0;
    Store.prototype.runImmediate = function <T>(work: () => T): T { transactions += 1; return original.call(this, work) as T; };
    try {
      assert.equal(await runKeychainCommand(['check-launchd', '--live'], f.context, liveDeps(OK_RECEIPT, launched)), 0);
      assert.deepEqual(launched, ['a']);
      assert.equal(transactions, 1);
      const store = openStore(f.context.config.dbPath);
      try {
        assert.equal(store.getConfig('keychain.liveItemsAuthorizedIdentityHash'), 'pinned-identity');
        assert.ok(store.getConfig('keychain.liveItemsAuthorizedAt'));
      } finally { store.close(); }
    } finally {
      Store.prototype.runImmediate = original;
      f.cleanup();
    }
  });

  it('a rolled-back step-7 Keychain failure writes nothing and prints the GUI re-authorization hint', async () => {
    const f = fixture();
    try {
      const receipt = { ...OK_RECEIPT, outcome: 'rolled-back' as const, error: 'keychain-write-failed', steps: { failedStep: 7 } };
      assert.equal(await runKeychainCommand(['check-launchd', '--live'], f.context, liveDeps(receipt)), 1);
      assert.match(f.errors.join('\n'), /re-authorize in the GUI/);
      const store = openStore(f.context.config.dbPath);
      try { assert.equal(store.getConfig('keychain.liveItemsAuthorizedAt'), null); } finally { store.close(); }
    } finally { f.cleanup(); }
  });

  it('a non-step-7 receipt and a timeout write nothing', async () => {
    const f = fixture();
    try {
      const wrongStep = { ...OK_RECEIPT, outcome: 'rolled-back' as const, error: 'keychain-write-failed', steps: { failedStep: 8 } };
      assert.equal(await runKeychainCommand(['check-launchd', '--live'], f.context, liveDeps(wrongStep)), 1);
      assert.equal(await runKeychainCommand(['check-launchd', '--live'], f.context, liveDeps({ timeout: true })), 1);
      const store = openStore(f.context.config.dbPath);
      try { assert.equal(store.getConfig('keychain.liveItemsAuthorizedAt'), null); } finally { store.close(); }
    } finally { f.cleanup(); }
  });

  it('is refused outside cutting-over and before read authorization, without launching the agent', async () => {
    const outside = fixture(false);
    const beforeAuthorization = fixture();
    const launched: string[] = [];
    try {
      assert.equal(await runKeychainCommand(['check-launchd', '--live'], outside.context, liveDeps(OK_RECEIPT, launched)), 3);
      const store = openStore(beforeAuthorization.context.config.dbPath);
      try { store.setConfig('keychain.liveItemsReadAuthorizedAt', ''); } finally { store.close(); }
      assert.equal(await runKeychainCommand(['check-launchd', '--live'], beforeAuthorization.context, liveDeps(OK_RECEIPT, launched)), 3);
      assert.deepEqual(launched, []);
      assert.match(beforeAuthorization.errors.join('\n'), /live-items-read-not-authorized/);
    } finally {
      outside.cleanup();
      beforeAuthorization.cleanup();
    }
  });

  it('accepts --json and rejects malformed live command flags', async () => {
    const f = fixture();
    try {
      assert.equal(await runKeychainCommand(['check-launchd', '--live', '--json'], f.context, liveDeps(OK_RECEIPT)), 0);
      assert.deepEqual(JSON.parse(f.output[0]!), { command: 'check-launchd --live', liveItemsAuthorized: true });
      assert.equal(await runKeychainCommand(['matrix', '--live'], f.context, liveDeps(OK_RECEIPT)), 2);
    } finally { f.cleanup(); }
  });
});
