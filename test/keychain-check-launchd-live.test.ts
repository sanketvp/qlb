import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { liveSwitchEnvironment, runKeychainCommand, runLaunchdLiveSwitch, type KeychainCommandDependencies, type LiveSwitchReceipt } from '../src/commands/keychain';
import { defaultConfig } from '../src/config';
import { beginCutover } from '../src/lifecycle';
import type { CommandContext } from '../src/registry';
import { openStore, Store } from '../src/store';

const OK_RECEIPT: LiveSwitchReceipt = {
  outcome: 'ok', from: 'a', to: 'a', switchId: 1, attempt: 'launchd-republish',
  reason: null, error: null, outgoingKind: 'own-bytes', steps: { cleanup: [] }, injected: false,
};

function fixture(cuttingOver = true): { home: string; context: CommandContext; output: string[]; errors: string[]; cleanup(): void } {
  const home = mkdtempSync(join(tmpdir(), 'qlb-launchd-live-'));
  const config = defaultConfig(home);
  const output: string[] = [];
  const errors: string[] = [];
  const store = openStore(config.dbPath);
  try {
    if (cuttingOver) beginCutover(store);
    store.setActiveLogin('anthropic', 'a', 'manual', 1);
    store.setConfig('keychain.liveItemsReadAuthorizedAt', '1');
    store.setConfig('keychain.liveItemsReadAuthorizedIdentityHash', 'pinned-identity');
  } finally { store.close(); }
  return {
    home,
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
      assert.match(f.output.join('\n'), /run `qlb keychain authorize` in a GUI session, then retry/);
      const store = openStore(f.context.config.dbPath);
      try { assert.equal(store.getConfig('keychain.liveItemsAuthorizedAt'), null); } finally { store.close(); }
    } finally { f.cleanup(); }
  });

  it('a non-step-7 receipt and a timeout write nothing', async () => {
    const f = fixture();
    try {
      const wrongStep = { ...OK_RECEIPT, outcome: 'rolled-back' as const, error: 'keychain-write-failed', steps: { failedStep: 8 } };
      assert.equal(await runKeychainCommand(['check-launchd', '--live'], f.context, liveDeps(wrongStep)), 1);
      assert.match(f.errors.join('\n'), /rolled-back: none/);
      assert.equal(await runKeychainCommand(['check-launchd', '--live'], f.context, liveDeps({ timeout: true })), 1);
      const store = openStore(f.context.config.dbPath);
      try {
        assert.equal(store.getConfig('keychain.liveItemsAuthorizedAt'), null);
        assert.equal(store.getConfig('keychain.liveItemsAuthorizedIdentityHash'), null);
      } finally { store.close(); }
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

  it('refuses a receipt for another account and read authorization for another helper identity', async () => {
    const f = fixture();
    try {
      assert.equal(await runKeychainCommand(['check-launchd', '--live'], f.context, liveDeps({ ...OK_RECEIPT, from: 'b', to: 'b' })), 1);
      assert.match(f.errors.join('\n'), /ok: receipt account mismatch/);
      const store = openStore(f.context.config.dbPath);
      try {
        assert.equal(store.getConfig('keychain.liveItemsAuthorizedAt'), null);
        store.setConfig('keychain.liveItemsReadAuthorizedIdentityHash', 'other-identity');
      } finally { store.close(); }
      const launched: string[] = [];
      assert.equal(await runKeychainCommand(['check-launchd', '--live'], f.context, liveDeps(OK_RECEIPT, launched)), 3);
      assert.deepEqual(launched, []);
      assert.match(f.errors.join('\n'), /live-items-read-authorization-identity-mismatch/);
    } finally { f.cleanup(); }
  });

  it('keeps the generic outcome message when a step-7 restore kept its journal', async () => {
    const f = fixture();
    try {
      const receipt = {
        ...OK_RECEIPT, outcome: 'rolled-back' as const, reason: 'restore-incomplete', error: 'keychain-write-failed',
        steps: { failedStep: 7, restoreFailures: ['credentials'] },
      };
      assert.equal(await runKeychainCommand(['check-launchd', '--live'], f.context, liveDeps(receipt)), 1);
      assert.equal(f.output.length, 0);
      assert.match(f.errors.join('\n'), /rolled-back: restore-incomplete/);
      assert.doesNotMatch(f.errors.join('\n'), /then retry/);
    } finally { f.cleanup(); }
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

describe('runLaunchdLiveSwitch runner seam (K5b-2)', () => {
  function completeOnBootstrap(calls: string[][]): (args: string[]) => void {
    return (args) => {
      calls.push(args);
      if (args[0] === 'bootstrap') {
        const directory = dirname(args[2]!);
        writeFileSync(join(directory, 'receipt.json'), JSON.stringify(OK_RECEIPT));
        writeFileSync(join(directory, 'status'), '0');
      }
    };
  }

  it('copies QLB_HOME only when inherited and makes the required plist arguments and environment', () => {
    const f = fixture();
    const calls: string[][] = [];
    let plist = '';
    try {
      f.context.env.CLAUDE_CONFIG_DIR = '/fixture/claude';
      const complete = completeOnBootstrap(calls);
      const result = runLaunchdLiveSwitch('a', f.context, {
        platform: 'darwin',
        launchdRunner: (args) => {
          if (args[0] === 'bootstrap') plist = readFileSync(args[2]!, 'utf8');
          complete(args);
        },
      });
      assert.deepEqual(result, OK_RECEIPT);
      assert.match(plist, /com\.modus\.qlb-livecheck\./);
      assert.match(plist, /<string>\/bin\/sh<\/string>[\s\S]*<string>-c<\/string>[\s\S]*<string>r="\$1"; s="\$2"; shift 2;/);
      assert.match(plist, /<string>--<\/string>[\s\S]*<string>switch<\/string>[\s\S]*<string>anthropic<\/string>[\s\S]*<string>a<\/string>[\s\S]*<string>--republish<\/string>/);
      assert.match(plist, /<key>QLB_DB_PATH<\/key><string>/);
      assert.match(plist, /<key>QLB_HOME<\/key><string>/);
      assert.match(plist, /<key>CLAUDE_CONFIG_DIR<\/key><string>\/fixture\/claude<\/string>/);
      assert.ok(calls.some(([verb]) => verb === 'bootout'));

      const withoutTestHome = { ...f.context, env: { HOME: f.home, PATH: '/usr/bin:/bin' } };
      assert.equal(liveSwitchEnvironment(withoutTestHome).QLB_HOME, undefined);
    } finally { f.cleanup(); }
  });

  it('sweeps an exited prior run and refuses without launching when launchd says it is running', () => {
    const exited = fixture();
    const stopped = fixture();
    const running = fixture();
    try {
      const oldLabel = 'com.modus.qlb-livecheck.old';
      const exitedDirectory = join(exited.home, '.qlb', 'launchd-live', oldLabel);
      mkdirSync(exitedDirectory, { recursive: true });
      const exitedCalls: string[][] = [];
      const exitedResult = runLaunchdLiveSwitch('a', exited.context, {
        platform: 'darwin',
        launchdRunner: (args) => {
          exitedCalls.push(args);
          if (args[0] === 'print') throw new Error('not loaded');
          completeOnBootstrap(exitedCalls)(args);
        },
      });
      assert.deepEqual(exitedResult, OK_RECEIPT);
      assert.equal(existsSync(exitedDirectory), false);
      assert.deepEqual(exitedCalls.slice(0, 2).map(([verb]) => verb), ['print', 'bootout']);

      const stoppedDirectory = join(stopped.home, '.qlb', 'launchd-live', oldLabel);
      mkdirSync(stoppedDirectory, { recursive: true });
      const stoppedCalls: string[][] = [];
      assert.deepEqual(runLaunchdLiveSwitch('a', stopped.context, {
        platform: 'darwin',
        launchdRunner: (args) => {
          stoppedCalls.push(args);
          if (args[0] === 'print') return 'state = exited';
          completeOnBootstrap(stoppedCalls)(args);
        },
      }), OK_RECEIPT);
      assert.equal(existsSync(stoppedDirectory), false);
      assert.deepEqual(stoppedCalls.slice(0, 2).map(([verb]) => verb), ['print', 'bootout']);

      const runningDirectory = join(running.home, '.qlb', 'launchd-live', oldLabel);
      mkdirSync(runningDirectory, { recursive: true });
      const runningCalls: string[][] = [];
      assert.deepEqual(runLaunchdLiveSwitch('a', running.context, {
        platform: 'darwin', launchdRunner: (args) => { runningCalls.push(args); },
      }), { inProgress: oldLabel });
      assert.deepEqual(runningCalls.map(([verb]) => verb), ['print']);
    } finally {
      exited.cleanup();
      stopped.cleanup();
      running.cleanup();
    }
  });

  it('times out without reading a receipt or booting out the still-running agent', () => {
    const f = fixture();
    const calls: string[][] = [];
    try {
      const result = runLaunchdLiveSwitch('a', f.context, {
        platform: 'darwin',
        now: (() => { let call = 0; return () => call++ === 0 ? 0 : 90_000; })(),
        launchdRunner: (args) => {
          calls.push(args);
          if (args[0] === 'bootstrap') {
            writeFileSync(join(dirname(args[2]!), 'receipt.json'), 'not read without status');
          }
        },
      });
      assert.deepEqual(result, { timeout: true });
      assert.deepEqual(calls.map(([verb]) => verb), ['bootstrap']);
      assert.equal(readdirSync(join(f.home, '.qlb', 'launchd-live')).length, 1);
    } finally { f.cleanup(); }
  });

  it('removes the run directory when bootstrap fails without invoking host launchctl', () => {
    const f = fixture();
    const calls: string[][] = [];
    try {
      assert.throws(() => runLaunchdLiveSwitch('a', f.context, {
        platform: 'darwin',
        launchdRunner: (args) => {
          calls.push(args);
          if (args[0] === 'bootstrap') throw new Error('bootstrap failed');
        },
      }), /bootstrap failed/);
      const root = join(f.home, '.qlb', 'launchd-live');
      assert.deepEqual(existsSync(root) ? readdirSync(root) : [], []);
      assert.deepEqual(calls.map(([verb]) => verb), ['bootstrap', 'bootout']);
    } finally { f.cleanup(); }
  });
});
