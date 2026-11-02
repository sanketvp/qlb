import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { isQlbProcessCommand, runUndoCswapCommand } from '../src/commands/undo-cswap';
import { discoverCommands, resolveCommand, type CommandContext } from '../src/registry';
import { openStore, openStoreConnection } from '../src/store';
import { runExecutingCommand } from '../src/cli';
import { beginCutover, phase, transition } from '../src/lifecycle';
import { recordStash } from '../src/unclaimed-index';
import { productionTryAcquireLock } from '../src/cswap-agent';

function credential(account: string, refresh: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `access-${account}`, refreshToken: refresh, expiresAt: 1_800_000_000_000 } });
}

function lineage(refresh: string): string {
  return `sha256:${createHash('sha256').update(refresh, 'utf8').digest('hex')}`;
}

function prefix(refresh: string): string {
  return lineage(refresh).slice(0, 'sha256:'.length + 12);
}

class ReadOnlyKeychain {
  readonly reads: Array<{ service: string; account: string }> = [];
  readonly writes: Array<{ service: string; account: string }> = [];
  private readonly values = new Map<string, string>();

  async set(service: string, account: string, value: string): Promise<void> {
    this.writes.push({ service, account });
    this.values.set(`${service}\0${account}`, value);
  }

  async get(service: string, account: string): Promise<string> {
    this.reads.push({ service, account });
    const value = this.values.get(`${service}\0${account}`);
    if (value === undefined) throw new Error('item not found');
    return value;
  }
}

interface Fixture {
  root: string;
  home: string;
  backup: string;
  dbPath: string;
  keychain: ReadOnlyKeychain;
  output: string[];
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'qlb-cswap-undo-'));
  const home = join(root, 'home');
  const backup = join(home, '.claude-swap-backup');
  const dbPath = join(home, '.qlb', 'qlb.db');
  mkdirSync(join(backup, 'credentials'), { recursive: true });
  const store = openStore(dbPath);
  store.close();
  return { root, home, backup, dbPath, keychain: new ReadOnlyKeychain(), output: [] };
}

function context(f: Fixture): CommandContext {
  return {
    stdout: (line) => f.output.push(line),
    stderr: (line) => f.output.push(`ERR:${line}`),
    env: { QLB_TEST_MODE: '1', QLB_HOME: f.home, HOME: f.home, USER: 'fixture-user' },
    config: { dbPath: f.dbPath, cswapSequencePath: join(f.backup, 'sequence.json') } as CommandContext['config'],
    loadConfig: () => { throw new Error('not used'); },
    home: f.home,
    registerSecret: () => undefined,
    deliverSecret: () => undefined,
    knownSecrets: () => [],
  };
}

function addSlot(f: Fixture, input: { accountId: string; number: number; email: string; refresh: string; source?: string; active?: boolean; dead?: boolean }): void {
  const db = openStoreConnection(f.dbPath);
  try {
    db.prepare(`INSERT INTO claude_slots (account_id, slot_num, email, config_json, fingerprint, added_at, source, dead)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.accountId, input.number, input.email, '{}', lineage(input.refresh), 1, input.source ?? 'cswap-import', input.dead ? 1 : 0,
    );
    f.keychain.set(`qlb:anthropic:${input.accountId}`, 'qlb', credential(input.accountId, input.refresh));
    if (input.active) {
      db.prepare("INSERT INTO active_login (provider, account_id, since, set_by) VALUES ('anthropic', ?, 1, 'test')")
        .run(input.accountId);
    }
  } finally {
    db.close();
  }
}

function snapshot(path: string, relative = ''): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  if (!existsSync(path)) return files;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const name = relative ? join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      for (const [nested, contents] of snapshot(child, name)) files.set(nested, contents);
    } else if (!name.endsWith('-wal') && !name.endsWith('-shm')) {
      files.set(name, readFileSync(child));
    }
  }
  return files;
}

async function dryRun(f: Fixture): Promise<number> {
  return runUndoCswapCommand(['--dry-run', '--json'], context(f), { keychain: f.keychain, backupDir: f.backup });
}

function close(f: Fixture): void {
  rmSync(f.root, { recursive: true, force: true });
}

function beginUndo(f: Fixture): void {
  const store = openStore(f.dbPath);
  try {
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
  } finally { store.close(); }
}

type UndoFakes = Partial<NonNullable<Parameters<typeof runUndoCswapCommand>[2]>>;

async function undo(f: Fixture, fakes: UndoFakes = {}, args: string[] = []): Promise<number> {
  let now = 0;
  return runUndoCswapCommand(args, context(f), {
    keychain: f.keychain,
    bootoutQlbAgent: () => ({ ok: true }),
    listQlbPids: () => [],
    listHeldLocks: () => [],
    pendingStash: () => null,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    deleteEnc: (path) => rmSync(path, { force: true }),
    withActiveLocks: async (fn) => fn(),
    readActiveCredential: async () => ({ credential: await f.keychain.get('qlb:anthropic:account-a', 'qlb'), accountId: 'account-a' }),
    validateActiveSequence: async () => undefined,
    setActiveAccountNumber: async () => undefined,
    ...fakes,
  });
}

describe('qlb undo cswap --dry-run', () => {
  it('a rotated slot plans update', async () => {
    const f = fixture();
    try {
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      f.keychain.set('claude-swap', 'account-1-a@example.test', credential('account-a', 'refresh-stale'));
      writeFileSync(join(f.backup, 'credentials', '.creds-1-a@example.test.enc'), 'stale encrypted fixture');

      assert.equal(await dryRun(f), 0);
      const plan = JSON.parse(f.output[0]!);
      assert.deepEqual(plan, {
        slots: [{
          accountId: 'account-a', accountNumber: 1, email: 'a@example.test', item: 'account-1-a@example.test',
          action: 'update', fingerprint: prefix('refresh-current'),
        }],
        deleteEnc: [join(f.backup, 'credentials', '.creds-1-a@example.test.enc')],
        activeAccountNumber: 1,
        dryRun: true,
      });
      assert.doesNotMatch(f.output.join('\n'), /refresh-current|refresh-stale/);
    } finally {
      close(f);
    }
  });

  it('an equal slot plans noop', async () => {
    const f = fixture();
    try {
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-equal', active: true });
      // Access-token differences must not turn an equal refresh lineage into an update.
      f.keychain.set('claude-swap', 'account-1-a@example.test', credential('other-access', 'refresh-equal'));

      assert.equal(await dryRun(f), 0);
      const plan = JSON.parse(f.output[0]!);
      assert.equal(plan.slots[0].action, 'noop');
      assert.equal(plan.slots[0].fingerprint, prefix('refresh-equal'));
    } finally {
      close(f);
    }
  });

  it('a dead active slot still plans healthy slots', async () => {
    const f = fixture();
    try {
      addSlot(f, { accountId: 'account-dead', number: 1, email: 'dead@example.test', refresh: 'refresh-dead', active: true, dead: true });
      addSlot(f, { accountId: 'account-healthy', number: 2, email: 'healthy@example.test', refresh: 'refresh-healthy' });
      f.keychain.set('claude-swap', 'account-2-healthy@example.test', credential('account-healthy', 'refresh-healthy'));

      assert.equal(await dryRun(f), 0);
      const plan = JSON.parse(f.output[0]!);
      assert.equal(plan.activeAccountNumber, 1);
      assert.deepEqual(plan.slots.map((slot: { accountNumber: number; action: string }) => [slot.accountNumber, slot.action]), [[2, 'noop']]);
    } finally {
      close(f);
    }
  });

  it('lists a stale encrypted credential after its slot email changes', async () => {
    const f = fixture();
    try {
      addSlot(f, { accountId: 'account-a', number: 1, email: 'new@example.test', refresh: 'refresh-current', active: true });
      f.keychain.set('claude-swap', 'account-1-new@example.test', credential('account-a', 'refresh-current'));
      const oldEnc = join(f.backup, 'credentials', '.creds-1-old@example.test.enc');
      writeFileSync(oldEnc, 'stale encrypted fixture');

      assert.equal(await dryRun(f), 0);
      assert.deepEqual(JSON.parse(f.output[0]!).deleteEnc, [oldEnc]);
    } finally {
      close(f);
    }
  });

  it('does not list slot 11 encrypted credentials for slot 1', async () => {
    const f = fixture();
    try {
      addSlot(f, { accountId: 'account-one', number: 1, email: 'one@example.test', refresh: 'refresh-one', active: true });
      f.keychain.set('claude-swap', 'account-1-one@example.test', credential('account-one', 'refresh-one'));
      writeFileSync(join(f.backup, 'credentials', '.creds-11-eleven@example.test.enc'), 'other slot fixture');

      assert.equal(await dryRun(f), 0);
      assert.deepEqual(JSON.parse(f.output[0]!).deleteEnc, []);
    } finally {
      close(f);
    }
  });

  it('refuses emails with terminal control characters', async () => {
    for (const email of ['newline\n@example.test', 'escape\u001b@example.test']) {
      const f = fixture();
      try {
        addSlot(f, { accountId: `account-${email.length}`, number: 1, email, refresh: 'refresh-current', active: true });

        assert.equal(await dryRun(f), 1);
        assert.deepEqual(f.output, ['ERR:qlb undo cswap: hand-back failed']);
      } finally {
        close(f);
      }
    }
  });

  it('a qlb-add slot is refused by name', async () => {
    const f = fixture();
    try {
      addSlot(f, { accountId: 'account-added', number: 2, email: 'added@example.test', refresh: 'refresh-added', source: 'qlb-add', active: true });
      addSlot(f, { accountId: 'account-added-too', number: 3, email: 'also-added@example.test', refresh: 'refresh-added-too', source: 'qlb-add' });

      assert.equal(await runUndoCswapCommand(['--dry-run'], context(f), { keychain: f.keychain, backupDir: f.backup }), 3);
      assert.deepEqual(f.output, ['ERR:qlb undo cswap: refused: qlb-add slots 2 (added@example.test), 3 (also-added@example.test)']);
      f.output.length = 0;
      assert.equal(await dryRun(f), 3);
      assert.deepEqual(JSON.parse(f.output[0]!), {
        dryRun: true,
        refused: 'qlb-add-slot',
        slots: [
          { accountNumber: 2, email: 'added@example.test' },
          { accountNumber: 3, email: 'also-added@example.test' },
        ],
      });
      assert.equal(f.keychain.reads.length, 0, 'a refused qlb-add slot must not read credentials');
    } finally {
      close(f);
    }
  });

  it('a migrated Pi provider is refused before credential reads', async () => {
    const f = fixture();
    try {
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      const store = openStore(f.dbPath);
      try { store.setConfig('pi.openai-codex.state', 'migrated'); } finally { store.close(); }

      assert.equal(await dryRun(f), 3);
      assert.deepEqual(f.output, ['ERR:qlb undo cswap: refused: migrated Pi provider openai-codex']);
      assert.equal(f.keychain.reads.length, 0, 'a migrated provider must be rolled back before credentials are read');
    } finally {
      close(f);
    }
  });

  it('dry run writes nothing', async () => {
    const f = fixture();
    try {
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      f.keychain.set('claude-swap', 'account-1-a@example.test', credential('account-a', 'refresh-old'));
      writeFileSync(join(f.backup, 'credentials', '.creds-1-a@example.test.enc'), 'stale encrypted fixture');
      const before = snapshot(f.root);

      assert.equal(await dryRun(f), 0);

      assert.deepEqual(snapshot(f.root), before);
      assert.deepEqual(f.keychain.reads.map(({ service, account }) => `${service}/${account}`), [
        'qlb:anthropic:account-a/qlb',
        'claude-swap/account-1-a@example.test',
      ]);
    } finally {
      close(f);
    }
  });

  it('the registered resolver admits the exact undo cswap dry-run command', async () => {
    const f = fixture();
    try {
      const commands = discoverCommands();
      assert.ok(commands.some((command) => command.name === 'undo cswap'));
      const match = resolveCommand(['undo', 'cswap', '--dry-run', '--json'], commands);
      assert.ok(match);
      assert.equal(match.command.name, 'undo cswap');

      // The lifecycle starts pre-cutover. This succeeds only if cli.ts maps the
      // resolved command name to `undo-cswap:dry-run`, whose admission bypass is
      // deliberately read-only.
      const before = snapshot(f.root);
      assert.equal(await runExecutingCommand(match, context(f)), 0);
      assert.deepEqual(snapshot(f.root), before, 'the resolver and lifecycle dry-run admission must remain read-only');
      assert.deepEqual(JSON.parse(f.output[0]!), {
        slots: [], deleteEnc: [], activeAccountNumber: null, dryRun: true,
      });
    } finally {
      close(f);
    }
  });
});

describe('QLB process matching', () => {
  it('matches only the executable or Node script position', () => {
    assert.equal(isQlbProcessCommand('node /x/bin/qlb proxy'), true);
    assert.equal(isQlbProcessCommand('node dist/cli.js auto'), true);
    assert.equal(isQlbProcessCommand('/usr/local/bin/qlb auto'), true);
    assert.equal(isQlbProcessCommand('node /x/qlbtool.js'), false);
  });
});

describe('qlb undo cswap hand-back', () => {
  it('undo during an in-flight refresh waits and hands back the successor', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-before', active: true });
      f.keychain.set('claude-swap', 'account-1-a@example.test', credential('old', 'refresh-old'));
      let held = true;
      f.keychain.writes.length = 0;
      assert.equal(await undo(f, {
        listHeldLocks: () => held ? ['consume-anthropic-account-a.lock'] : [],
        sleep: async () => {
          held = false;
          await f.keychain.set('qlb:anthropic:account-a', 'qlb', credential('account-a', 'refresh-successor'));
        },
        readActiveCredential: async () => ({ credential: credential('account-a', 'refresh-successor'), accountId: 'account-a' }),
      }), 0);
      assert.equal(await f.keychain.get('claude-swap', 'account-1-a@example.test'), credential('account-a', 'refresh-successor'));
      assert.equal(f.keychain.writes.filter(({ service }) => service === 'claude-swap').length, 2);
    } finally { close(f); }
  });

  it('hands back a native live rotation attributed by the injected profile oracle', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-slot', active: true });
      const rotated = credential('account-a', 'refresh-native');
      writeFileSync(join(f.home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-a', emailAddress: 'a@example.test' } }));
      await f.keychain.set('Claude Code-credentials', 'fixture-user', rotated);
      let profiles = 0;
      assert.equal(await undo(f, {
        readActiveCredential: async () => ({ credential: rotated, accountId: 'account-a' }),
        getProfile: async () => {
          profiles += 1;
          return { status: 200, body: JSON.stringify({ account: { uuid: 'account-a', email: 'a@example.test' } }) };
        },
      }), 0);
      assert.equal(profiles, 1);
      assert.equal(await f.keychain.get('claude-swap', 'account-1-a@example.test'), rotated);
    } finally { close(f); }
  });

  it('fails closed when the native live rotation cannot be attributed', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-slot', active: true });
      const rotated = credential('account-a', 'refresh-native');
      writeFileSync(join(f.home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-a', emailAddress: 'a@example.test' } }));
      await f.keychain.set('Claude Code-credentials', 'fixture-user', rotated);
      f.keychain.writes.length = 0;
      assert.equal(await undo(f, {
        readActiveCredential: async () => ({ credential: rotated, accountId: 'account-a' }),
        getProfile: async () => { throw new Error('fixture oracle failure'); },
      }), 1);
      assert.match(f.output.at(-1)!, /active account 1: active-login-unattributed/);
      assert.equal(f.keychain.writes.filter(({ service }) => service === 'claude-swap').length, 0);
      const store = openStore(f.dbPath);
      try { assert.equal(phase(store).state, 'undoing'); } finally { store.close(); }
    } finally { close(f); }
  });

  it('refuses structural blockers before fencing or booting out the agent', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'added', number: 1, email: 'added@example.test', refresh: 'refresh-added', source: 'qlb-add', active: true });
      let bootouts = 0;
      assert.equal(await undo(f, { bootoutQlbAgent: () => { bootouts += 1; return { ok: true }; } }), 3);
      assert.equal(bootouts, 0);
      assert.equal(f.keychain.writes.length, 1, 'fixture setup only');
      const store = openStore(f.dbPath);
      try { assert.equal(phase(store).state, 'cutover'); } finally { store.close(); }
    } finally { close(f); }
  });

  it('a failed drain writes nothing, keeps undoing and leaves C-swap stopped', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      const calls: string[] = [];
      f.keychain.writes.length = 0;
      assert.equal(await undo(f, {
        bootoutQlbAgent: () => { calls.push('bootout'); return { ok: true }; },
        listQlbPids: () => [4321],
      }), 3);
      assert.deepEqual(calls, ['bootout']);
      assert.equal(f.keychain.writes.length, 0);
      const store = openStore(f.dbPath);
      try { assert.equal(phase(store).state, 'undoing'); } finally { store.close(); }
    } finally { close(f); }
  });

  it('drains a real flock but ignores its released file and stale lock directory', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      const locks = join(f.home, '.qlb', 'locks');
      mkdirSync(locks, { recursive: true });
      const auto = join(locks, 'auto.lock');
      const release = await productionTryAcquireLock(auto);
      assert.ok(release, 'test flock acquired');
      const stale = join(locks, 'consume-anthropic-account-a.lock');
      mkdirSync(stale);
      utimesSync(stale, new Date(1), new Date(1));
      let released = false;
      assert.equal(await undo(f, {
        listHeldLocks: undefined,
        now: Date.now,
        sleep: async () => { if (!released) { released = true; await release(); } },
      }), 0);
      assert.ok(existsSync(auto), 'flock file remains after release');
      assert.ok(existsSync(stale), 'observation never deletes stale lock directories');
    } finally { close(f); }
  });

  it('no Keychain write precedes the confirmed drain (call order spy)', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      const calls: string[] = [];
      let held = true;
      f.keychain.writes.length = 0;
      const keychain = {
        get: f.keychain.get.bind(f.keychain),
        set: async (service: string, account: string, value: string) => {
          calls.push('keychain-write');
          await f.keychain.set(service, account, value);
        },
      };
      assert.equal(await undo(f, {
        keychain,
        listHeldLocks: () => {
          if (held) { calls.push('held'); return ['switch-anthropic.lock']; }
          calls.push('drain-confirmed');
          return [];
        },
        sleep: async () => { held = false; },
      }), 0);
      assert.ok(calls.indexOf('drain-confirmed') >= 0);
      assert.ok(calls.indexOf('keychain-write') > calls.indexOf('drain-confirmed'), calls.join(','));
    } finally { close(f); }
  });

  it('each slot gets its current lineage', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-active', active: true });
      addSlot(f, { accountId: 'account-b', number: 2, email: 'b@example.test', refresh: 'refresh-before' });
      f.keychain.set('claude-swap', 'account-2-b@example.test', credential('old', 'refresh-old'));
      assert.equal(await undo(f, {
        plan: async (deps) => {
          const { planHandBack: freshPlan } = await import('../src/cswap-undo');
          const plan = await freshPlan(deps);
          await f.keychain.set('qlb:anthropic:account-b', 'qlb', credential('account-b', 'refresh-successor'));
          return plan;
        },
      }), 0);
      assert.equal(await f.keychain.get('claude-swap', 'account-2-b@example.test'), credential('account-b', 'refresh-successor'));
    } finally { close(f); }
  });

  it('the active slot is re-read under the locks', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-before', active: true });
      let underLock = false;
      const reads: string[] = [];
      const keychain = {
        get: async (service: string, account: string) => {
          if (service === 'qlb:anthropic:account-a') reads.push(underLock ? 'locked' : 'unlocked');
          return f.keychain.get(service, account);
        },
        set: f.keychain.set.bind(f.keychain),
      };
      assert.equal(await undo(f, {
        keychain,
        withActiveLocks: async (fn) => { underLock = true; try { return await fn(); } finally { underLock = false; } },
        readActiveCredential: async () => ({ credential: credential('account-a', 'refresh-before'), accountId: 'account-a' }),
      }), 0);
      assert.ok(reads.includes('locked'), `active slot reads: ${reads.join(',')}`);
    } finally { close(f); }
  });

  it('resume after a crash writes 0 duplicates', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      assert.equal(await undo(f), 0);
      f.keychain.writes.length = 0;
      f.output.length = 0;
      assert.equal(await undo(f, {}, ['--resume', '--json']), 0);
      assert.equal(f.keychain.writes.length, 0);
      assert.equal(JSON.parse(f.output[0]!).skipped, 1);
    } finally { close(f); }
  });

  it('a pending indexed stash exits 3 by name with the fence kept', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      await recordStash(join(f.home, '.qlb', 'unclaimed'), {
        provider: 'anthropic', accountId: 'account-a', stashId: 'pending-stash', consumedFp: 'sha256:pending', location: 'keychain', createdAt: 1, pending: 1,
      });
      f.keychain.writes.length = 0;
      assert.equal(await undo(f, { pendingStash: undefined }), 3);
      assert.match(f.output.at(-1)!, /pending-stash/);
      assert.equal(f.keychain.writes.length, 0);
      const store = openStore(f.dbPath);
      try { assert.equal(phase(store).state, 'undoing'); } finally { store.close(); }
    } finally { close(f); }
  });

  it('preserves a slot successor when live still has its spent ancestor', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-successor', active: true });
      const store = openStore(f.dbPath);
      try {
        store.recordLineage({ provider: 'anthropic', accountId: 'account-a', fromFp: lineage('refresh-spent'), toFp: lineage('refresh-successor'), cause: 'resync', by: 'test', evidence: 'lineage' });
      } finally { store.close(); }
      assert.equal(await undo(f, {
        readActiveCredential: async () => ({ credential: credential('account-a', 'refresh-spent'), accountId: 'account-a' }),
      }), 0);
      assert.equal(await f.keychain.get('claude-swap', 'account-1-a@example.test'), credential('account-a', 'refresh-successor'));
    } finally { close(f); }
  });

  it('replaces a malformed C-swap item and retains its readable bytes as prev', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      f.keychain.set('claude-swap', 'account-1-a@example.test', 'malformed fixture');
      assert.equal(await undo(f), 0);
      assert.equal(await f.keychain.get('claude-swap', 'account-1-a@example.test'), credential('account-a', 'refresh-current'));
      assert.equal(await f.keychain.get('claude-swap', 'account-1-a@example.test.prev'), 'malformed fixture');
    } finally { close(f); }
  });

  it('updates sequence.json atomically after the active export and leaves it unchanged on resume', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      const sequence = join(f.backup, 'sequence.json');
      writeFileSync(sequence, JSON.stringify({ accounts: { 1: { email: 'a@example.test' } }, activeAccountNumber: 2, preserved: true }));
      assert.equal(await undo(f, { validateActiveSequence: undefined, setActiveAccountNumber: undefined }), 0);
      assert.deepEqual(JSON.parse(readFileSync(sequence, 'utf8')), { accounts: { 1: { email: 'a@example.test' } }, activeAccountNumber: 1, preserved: true });
      const before = readFileSync(sequence, 'utf8');
      f.output.length = 0;
      assert.equal(await undo(f, { validateActiveSequence: undefined, setActiveAccountNumber: undefined }, ['--resume']), 0);
      assert.equal(readFileSync(sequence, 'utf8'), before);
    } finally { close(f); }
  });

  it('updates sequence.json for a dead active slot before verification', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-dead', number: 1, email: 'dead@example.test', refresh: 'refresh-dead', active: true, dead: true });
      addSlot(f, { accountId: 'account-healthy', number: 2, email: 'healthy@example.test', refresh: 'refresh-healthy' });
      const sequence = join(f.backup, 'sequence.json');
      writeFileSync(sequence, JSON.stringify({ accounts: { 1: {}, 2: {} }, activeAccountNumber: 2 }));
      assert.equal(await undo(f, { validateActiveSequence: undefined, setActiveAccountNumber: undefined }), 0);
      assert.equal(JSON.parse(readFileSync(sequence, 'utf8')).activeAccountNumber, 1);
    } finally { close(f); }
  });

  it('rejects a sequence account removed after pre-fence validation at write time', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      const sequence = join(f.backup, 'sequence.json');
      writeFileSync(sequence, JSON.stringify({ accounts: { 1: {} }, activeAccountNumber: 2 }));
      assert.equal(await undo(f, {
        validateActiveSequence: undefined,
        setActiveAccountNumber: undefined,
        withActiveLocks: async (fn) => {
          writeFileSync(sequence, JSON.stringify({ accounts: {}, activeAccountNumber: 2 }));
          return fn();
        },
      }), 3);
      assert.match(f.output.at(-1)!, /sequence\.json is malformed/);
      assert.deepEqual(JSON.parse(readFileSync(sequence, 'utf8')), { accounts: {}, activeAccountNumber: 2 });
    } finally { close(f); }
  });

  it('revalidates sequence.json under its write lock', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      const sequence = join(f.backup, 'sequence.json');
      writeFileSync(sequence, JSON.stringify({ accounts: { 1: {} }, activeAccountNumber: 1 }));
      const release = await productionTryAcquireLock(join(f.backup, '.lock'));
      assert.ok(release, 'test sequence lock acquired');
      try {
        assert.equal(await undo(f, { validateActiveSequence: undefined, setActiveAccountNumber: undefined }), 1);
      } finally { await release(); }
    } finally { close(f); }
  });

  it('refuses missing, malformed, or wrong-account sequence.json before fencing or writes', async () => {
    for (const contents of [undefined, '[]', JSON.stringify({ accounts: {} }), JSON.stringify({ accounts: [] })]) {
      const f = fixture();
      try {
        beginUndo(f);
        addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
        if (contents !== undefined) writeFileSync(join(f.backup, 'sequence.json'), contents);
        f.keychain.writes.length = 0;
        assert.equal(await undo(f, { validateActiveSequence: undefined, setActiveAccountNumber: undefined }), 3);
        assert.match(f.output.at(-1)!, /sequence\.json is (missing|malformed)/);
        assert.equal(f.keychain.writes.length, 0);
        const store = openStore(f.dbPath);
        try { assert.equal(phase(store).state, 'cutover'); } finally { store.close(); }
      } finally { close(f); }
    }
  });

  it('the production reader rejects a valid stale .enc before its Keychain fallback', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      writeFileSync(join(f.backup, 'credentials', '.creds-1-a@example.test.enc'), Buffer.from(credential('old', 'refresh-stale')).toString('base64'));
      assert.equal(await undo(f, { deleteEnc: () => undefined }), 1);
      const store = openStore(f.dbPath);
      try { assert.equal(phase(store).state, 'undoing'); } finally { store.close(); }
    } finally { close(f); }
  });

  it('a read-back mismatch exits 1 and keeps undoing', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      assert.equal(await undo(f, { readBack: async () => credential('wrong', 'refresh-wrong') }), 1);
      const store = openStore(f.dbPath);
      try { assert.equal(phase(store).state, 'undoing'); } finally { store.close(); }
    } finally { close(f); }
  });

  it('a dead qlb-add slot does not refuse the plan, while a qlb-add slot with no email names its account number', async () => {
    const f = fixture();
    try {
      addSlot(f, { accountId: 'dead-add', number: 1, email: 'dead@example.test', refresh: 'refresh-dead', source: 'qlb-add', active: true, dead: true });
      addSlot(f, { accountId: 'healthy', number: 2, email: 'healthy@example.test', refresh: 'refresh-healthy' });
      assert.equal(await dryRun(f), 0);
      const db = openStoreConnection(f.dbPath);
      try {
        db.prepare(`INSERT INTO claude_slots (account_id, slot_num, email, config_json, fingerprint, added_at, source, dead)
          VALUES ('missing-email', 3, NULL, '{}', ?, 1, 'qlb-add', 0)`).run(lineage('refresh-added'));
      } finally { db.close(); }
      f.output.length = 0;
      assert.equal(await runUndoCswapCommand(['--dry-run'], context(f), { keychain: f.keychain, backupDir: f.backup }), 3);
      assert.match(f.output[0]!, /3 \(no email\)/);
    } finally { close(f); }
  });

  it('refuses encrypted credential names containing control characters', async () => {
    const f = fixture();
    try {
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      writeFileSync(join(f.backup, 'credentials', '.creds-1-bad\u0007.enc'), 'fixture');
      assert.equal(await dryRun(f), 1);
      assert.deepEqual(f.output, ['ERR:qlb undo cswap: hand-back failed']);
    } finally { close(f); }
  });
});
