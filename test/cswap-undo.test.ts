import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { defaultHeldLocks, isQlbProcessCommand, restoreCswap, runUndoCswapCommand, type TerminalHandBack } from '../src/commands/undo-cswap';
import { undoIncompleteCheck } from '../src/checks/undo-incomplete';
import { discoverCommands, resolveCommand, type CommandContext } from '../src/registry';
import { openStore, openStoreConnection } from '../src/store';
import { runExecutingCommand } from '../src/app';
import {
  CSWAP_RESTORE_PENDING,
  CUTOVER_BEGIN_IN_PROGRESS,
  abortCutoverBegin,
  beginCutover,
  closeLifecycle,
  phase,
  transition,
} from '../src/lifecycle';
import { recordStash } from '../src/unclaimed-index';
import { FlockHelperExitedError, productionTryAcquireLock } from '../src/cswap-agent';

const support = join(__dirname, '..', '..', 'test', 'support');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildV4Store } = require(join(support, 'v4-fixture.cjs')) as {
  buildV4Store: (path: string, rows?: Array<Record<string, unknown>>) => string;
};

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

function userVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | number | undefined;
    return typeof row === 'number' ? row : row?.user_version ?? 0;
  } finally { db.close(); }
}

async function admitOnly(f: Fixture, command: string, args: string[]): Promise<{ code: number; executed: boolean }> {
  let executed = false;
  const code = await runExecutingCommand({
    command: { name: command, execute: async () => { executed = true; return 0; } },
    args,
  }, context(f));
  return { code, executed };
}

function beginUndo(f: Fixture): void {
  const store = openStore(f.dbPath);
  try {
    beginCutover(store, 1);
    assert.equal(transition(store, 'cutover', 2).ok, true);
  } finally { store.close(); }
}

type UndoFakes = Partial<NonNullable<Parameters<typeof runUndoCswapCommand>[2]>>;

async function undo(f: Fixture, fakes: UndoFakes = {}, args: string[] = [], ctx: CommandContext = context(f)): Promise<number> {
  let now = 0;
  return runUndoCswapCommand(args, ctx, {
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
    // Most G17 cases isolate the ordered hand-back. Native-resync cases below
    // explicitly opt back into the production resync path.
    resyncActive: async () => undefined,
    moveQlbPlist: () => ({ ok: true }),
    cswapAgent: { restorePlist: () => ({ ok: true }) },
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

  it('the real command returns an empty plan for a missing store without creating it', async () => {
    const f = fixture();
    try {
      unlinkSync(f.dbPath);
      const match = resolveCommand(['undo', 'cswap', '--dry-run', '--json'], discoverCommands());
      assert.ok(match);

      assert.equal(await runExecutingCommand(match, context(f)), 0);
      assert.equal(existsSync(f.dbPath), false);
      assert.deepEqual(JSON.parse(f.output[0]!), {
        slots: [], deleteEnc: [], activeAccountNumber: null, dryRun: true,
      });
    } finally { close(f); }
  });

  it('the lifecycle admission refuses an old schema without changing its bytes or mtime', async () => {
    const f = fixture();
    try {
      unlinkSync(f.dbPath);
      buildV4Store(f.dbPath);
      const before = readFileSync(f.dbPath);
      const beforeMtime = statSync(f.dbPath).mtimeMs;

      const result = await admitOnly(f, 'undo cswap', ['--dry-run']);

      assert.deepEqual(result, { code: 3, executed: false });
      assert.deepEqual(readFileSync(f.dbPath), before);
      assert.equal(statSync(f.dbPath).mtimeMs, beforeMtime);
      assert.deepEqual(f.output, ['ERR:qlb undo cswap: refused: schema-migration-required']);
    } finally { close(f); }
  });

  it('the lifecycle admission refuses a newer schema with Store\'s upgrade guidance', async () => {
    const f = fixture();
    try {
      const db = openStoreConnection(f.dbPath);
      try { db.exec('PRAGMA user_version = 6'); } finally { db.close(); }

      const result = await admitOnly(f, 'undo cswap', ['--dry-run']);

      assert.deepEqual(result, { code: 1, executed: false });
      assert.match(f.output[0]!, /qlb\.db schema user_version=6 is newer than this binary \(5\); upgrade qlb/);
    } finally { close(f); }
  });

  it('write lifecycle admission still opens old schemas read-write and migrates', async () => {
    const f = fixture();
    try {
      unlinkSync(f.dbPath);
      buildV4Store(f.dbPath);
      assert.equal(userVersion(f.dbPath), 4);

      const result = await admitOnly(f, 'cutover', ['begin']);

      assert.deepEqual(result, { code: 0, executed: true });
      assert.equal(userVersion(f.dbPath), 5);
    } finally { close(f); }
  });

  it('doctor lifecycle admission still opens old schemas read-write and migrates', async () => {
    const f = fixture();
    try {
      unlinkSync(f.dbPath);
      buildV4Store(f.dbPath);
      assert.equal(userVersion(f.dbPath), 4);

      const result = await admitOnly(f, 'doctor', []);

      assert.deepEqual(result, { code: 0, executed: true });
      assert.equal(userVersion(f.dbPath), 5);
      assert.doesNotMatch(f.output.join('\n'), /schema-migration-required/);
    } finally { close(f); }
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
        resyncActive: undefined,
        getProfile: async () => {
          profiles += 1;
          return { status: 200, body: JSON.stringify({ account: { uuid: 'account-a', email: 'a@example.test' } }) };
        },
      }), 0);
      assert.equal(profiles, 1);
      assert.equal(await f.keychain.get('claude-swap', 'account-1-a@example.test'), rotated);
    } finally { close(f); }
  });

  it('writes same-lineage live bytes to the active slot before exporting them', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-shared', active: true });
      const live = credential('live-access', 'refresh-shared');
      await f.keychain.set('qlb:anthropic:account-a', 'qlb', credential('slot-access', 'refresh-shared'));
      writeFileSync(join(f.home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-a', emailAddress: 'a@example.test' } }));
      await f.keychain.set('Claude Code-credentials', 'fixture-user', live);
      assert.equal(await undo(f, {
        readActiveCredential: async () => ({ credential: live, accountId: 'account-a' }),
        resyncActive: undefined,
      }), 0);
      assert.equal(await f.keychain.get('qlb:anthropic:account-a', 'qlb'), live);
      assert.equal(await f.keychain.get('claude-swap', 'account-1-a@example.test'), live);
    } finally { close(f); }
  });

  it('allows a missing stored email or org when the locked account id matches', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-slot', active: true });
      const live = credential('account-a', 'refresh-live');
      writeFileSync(join(f.home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-a', emailAddress: 'live@example.test', organizationUuid: 'live-org' } }));
      await f.keychain.set('Claude Code-credentials', 'fixture-user', live);
      assert.equal(await undo(f, {
        plan: async (deps) => {
          const plan = await import('../src/cswap-undo').then(({ planHandBack }) => planHandBack(deps));
          const db = openStoreConnection(f.dbPath);
          try { db.prepare('UPDATE claude_slots SET email = NULL, org_uuid = NULL WHERE account_id = ?').run('account-a'); } finally { db.close(); }
          return plan;
        },
        readActiveCredential: async () => ({ credential: live, accountId: 'account-a' }),
        resyncActive: undefined,
        getProfile: async () => ({ status: 200, body: JSON.stringify({ account: { uuid: 'account-a', organization_uuid: 'live-org' } }) }),
      }), 0);
      assert.equal(await f.keychain.get('claude-swap', 'account-1-a@example.test'), live);
    } finally { close(f); }
  });

  it('fails closed when a known active identity value differs', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-slot', active: true });
      const live = credential('account-a', 'refresh-live');
      writeFileSync(join(f.home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-a', emailAddress: 'other@example.test' } }));
      await f.keychain.set('Claude Code-credentials', 'fixture-user', live);
      f.keychain.writes.length = 0;
      assert.equal(await undo(f, {
        readActiveCredential: async () => ({ credential: live, accountId: 'account-a' }),
        resyncActive: undefined,
      }), 1);
      assert.match(f.output.at(-1)!, /active account 1: active-login-unattributed/);
      assert.equal(f.keychain.writes.filter(({ service }) => service === 'claude-swap').length, 0);
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
        resyncActive: undefined,
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

  it('an exited auto flock probe counts auto.lock as held and the drain retries', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      const locks = join(f.home, '.qlb', 'locks');
      mkdirSync(locks, { recursive: true });
      writeFileSync(join(locks, 'auto.lock'), '');
      const calls: string[] = [];
      const failures: unknown[] = [
        new FlockHelperExitedError(17),
        { code: 'flock-helper-exited' },
        new Error('generic probe failure'),
      ];
      let probes = 0;

      assert.equal(await undo(f, {
        bootoutQlbAgent: () => { calls.push('bootout'); return { ok: true }; },
        listHeldLocks: () => defaultHeldLocks(f.home, () => 0, async () => {
          calls.push(`probe-${++probes}`);
          const failure = failures.shift();
          if (failure !== undefined) throw failure;
          if (probes === 4) return async () => {
            calls.push('release-failed');
            throw new Error('generic probe release failure');
          };
          return async () => { calls.push('release'); };
        }),
        sleep: async (ms) => { calls.push(`sleep-${ms}`); },
      }), 0);
      assert.deepEqual(calls, [
        'bootout',
        'probe-1', 'sleep-1000',
        'probe-2', 'sleep-1000',
        'probe-3', 'sleep-1000',
        'probe-4', 'release-failed', 'sleep-1000',
        'probe-5', 'release',
      ]);
    } finally { close(f); }
  });

  it('a drain whose auto.lock probe keeps failing exits 3 naming auto.lock with the fence kept', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      const locks = join(f.home, '.qlb', 'locks');
      mkdirSync(locks, { recursive: true });
      writeFileSync(join(locks, 'auto.lock'), '');
      f.keychain.writes.length = 0;
      const calls: string[] = [];
      let now = 0;
      let probes = 0;

      assert.equal(await undo(f, {
        bootoutQlbAgent: () => { calls.push('bootout'); return { ok: true }; },
        listHeldLocks: () => defaultHeldLocks(f.home, () => now, async () => {
          calls.push(`probe-${++probes}`);
          throw new FlockHelperExitedError(17);
        }),
        now: () => now,
        sleep: async (ms) => { calls.push(`sleep-${ms}`); now += ms; },
      }), 3);
      assert.equal(calls[0], 'bootout');
      assert.equal(probes, 61);
      assert.equal(calls.filter((call) => call === 'sleep-1000').length, 60);
      assert.match(f.output.at(-1)!, /drain timeout \(locks auto\.lock\)/);
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
      assert.deepEqual(JSON.parse(f.output[0]!), {
        resumed: true,
        state: 'rolled-back',
        nextStep: 'qlb lifecycle close 1',
      });
    } finally { close(f); }
  });

  it('the production plist mover treats a missing QLB agent as nothing to move', async () => {
    const f = fixture();
    const savedTestMode = process.env.QLB_TEST_MODE;
    delete process.env.QLB_TEST_MODE;
    try {
      const store = openStore(f.dbPath);
      try { beginCutover(store, 1); } finally { store.close(); }
      const source = join(f.home, 'Library', 'LaunchAgents', 'com.modus.qlb-auto.plist');
      const target = join(f.home, '.qlb', 'backups', 'qlb-plist', 'com.modus.qlb-auto.plist');
      assert.ok(source.startsWith(`${f.home}/`));
      assert.ok(target.startsWith(`${f.home}/`));
      const productionContext = { ...context(f), env: { QLB_HOME: f.home, HOME: f.home } };
      let restored = 0;
      assert.equal(await undo(f, {
        moveQlbPlist: undefined,
        cswapAgent: { restorePlist: () => { restored += 1; return { ok: true }; } },
      }, [], productionContext), 0);
      assert.equal(restored, 1);
      const completed = openStore(f.dbPath);
      try {
        assert.equal(phase(completed).state, 'aborted');
        assert.equal(phase(completed).note, null);
      } finally { completed.close(); }
    } finally {
      if (savedTestMode === undefined) delete process.env.QLB_TEST_MODE;
      else process.env.QLB_TEST_MODE = savedTestMode;
      close(f);
    }
  });

  it('the production plist mover accepts a plist already in its backup', async () => {
    const f = fixture();
    const savedTestMode = process.env.QLB_TEST_MODE;
    delete process.env.QLB_TEST_MODE;
    try {
      beginUndo(f);
      const source = join(f.home, 'Library', 'LaunchAgents', 'com.modus.qlb-auto.plist');
      const target = join(f.home, '.qlb', 'backups', 'qlb-plist', 'com.modus.qlb-auto.plist');
      assert.ok(source.startsWith(`${f.home}/`));
      assert.ok(target.startsWith(`${f.home}/`));
      mkdirSync(join(f.home, '.qlb', 'backups', 'qlb-plist'), { recursive: true });
      writeFileSync(target, 'fixture plist');
      const productionContext = { ...context(f), env: { QLB_HOME: f.home, HOME: f.home } };
      assert.equal(await undo(f, { moveQlbPlist: undefined }, [], productionContext), 0);
      assert.equal(readFileSync(target, 'utf8'), 'fixture plist');
      const store = openStore(f.dbPath);
      try { assert.equal(phase(store).state, 'rolled-back'); } finally { store.close(); }
    } finally {
      if (savedTestMode === undefined) delete process.env.QLB_TEST_MODE;
      else process.env.QLB_TEST_MODE = savedTestMode;
      close(f);
    }
  });

  it('the production plist mover refuses both missing paths after a committed cutover', async () => {
    const f = fixture();
    const savedTestMode = process.env.QLB_TEST_MODE;
    delete process.env.QLB_TEST_MODE;
    try {
      beginUndo(f);
      const productionContext = { ...context(f), env: { QLB_HOME: f.home, HOME: f.home } };
      assert.equal(await undo(f, { moveQlbPlist: undefined }, [], productionContext), 1);
      assert.match(f.output.at(-1)!, /qlb-plist-missing; state=undoing/);
      const store = openStore(f.dbPath);
      try { assert.equal(phase(store).state, 'undoing'); } finally { store.close(); }
    } finally {
      if (savedTestMode === undefined) delete process.env.QLB_TEST_MODE;
      else process.env.QLB_TEST_MODE = savedTestMode;
      close(f);
    }
  });

  it('undo ends rolled-back with the agent stopped and C-swap restored', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      const calls: string[] = [];
      assert.equal(await undo(f, {
        bootoutQlbAgent: () => { calls.push('bootout-qlb'); return { ok: true }; },
        moveQlbPlist: () => { calls.push('move-qlb-plist'); return { ok: true }; },
        cswapAgent: { restorePlist: () => { calls.push('restore-cswap'); return { ok: true }; } },
      }), 0);
      assert.deepEqual(calls, ['bootout-qlb', 'move-qlb-plist', 'restore-cswap']);
      const store = openStore(f.dbPath);
      try { assert.equal(phase(store).state, 'rolled-back'); } finally { store.close(); }
      assert.match(f.output.at(-1)!, /qlb lifecycle close \d+/);
    } finally { close(f); }
  });

  it('a failed plist move reports the fenced state and resume hint', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      assert.equal(await undo(f, { moveQlbPlist: () => ({ ok: false, code: 'fixture-move-failed' }) }), 1);
      assert.match(f.output.at(-1)!, /state=undoing; run qlb undo cswap --resume/);
      const store = openStore(f.dbPath);
      try { assert.equal(phase(store).state, 'undoing'); } finally { store.close(); }
    } finally { close(f); }
  });

  it('C-swap is restored only after verify succeeds', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      const calls: string[] = [];
      assert.equal(await undo(f, {
        readBack: async (slot) => {
          calls.push('verify');
          return f.keychain.get('claude-swap', slot.item);
        },
        moveQlbPlist: () => { calls.push('move-qlb-plist'); return { ok: true }; },
        cswapAgent: { restorePlist: () => { calls.push('restore-cswap'); return { ok: true }; } },
      }), 0);
      assert.deepEqual(calls, ['verify', 'move-qlb-plist', 'restore-cswap']);
    } finally { close(f); }
  });

  it('resume restores a legacy terminal row with its plist already live before allowing close', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      const store = openStore(f.dbPath);
      let lifecycleId = 0;
      try {
        assert.equal(transition(store, 'undoing', 20).ok, true);
        assert.equal(transition(store, 'rolled-back', 30).ok, true);
        lifecycleId = phase(store).id;
      } finally { store.close(); }
      // The old row has no fence and its plist is already live, but its agent
      // is unloaded. Resume must still run the injected restore operation.
      const source = join(f.home, 'Library', 'LaunchAgents', 'com.cswap.auto.plist');
      mkdirSync(dirname(source), { recursive: true });
      writeFileSync(source, 'fixture C-swap plist');
      let restores = 0;
      assert.equal(await undo(f, {
        cswapAgent: { restorePlist: () => {
          restores += 1;
          const duringRestore = openStore(f.dbPath);
          try {
            assert.equal(phase(duringRestore).note, CSWAP_RESTORE_PENDING);
            assert.equal(closeLifecycle(duringRestore, lifecycleId, 'fixture', 40).code, CSWAP_RESTORE_PENDING);
          } finally { duringRestore.close(); }
          return { ok: true };
        } },
      }, ['--resume']), 0);
      assert.equal(restores, 1);
      const completed = openStore(f.dbPath);
      try {
        assert.equal(closeLifecycle(completed, lifecycleId, 'fixture', 40).ok, true);
      } finally { completed.close(); }
    } finally { close(f); }
  });

  it('resume restores an aborted cutover-begin failure and preserves its note', async () => {
    const f = fixture();
    try {
      const store = openStore(f.dbPath);
      let lifecycleId = 0;
      try {
        const begun = beginCutover(store, 1, CUTOVER_BEGIN_IN_PROGRESS);
        assert.equal(abortCutoverBegin(store, begun.id, 'drain-timeout', 2).ok, true);
        lifecycleId = phase(store).id;
      } finally { store.close(); }

      assert.equal(await undo(f, {
        cswapAgent: { restorePlist: () => {
          const duringRestore = openStore(f.dbPath);
          try { assert.equal(phase(duringRestore).note, CSWAP_RESTORE_PENDING); } finally { duringRestore.close(); }
          return { ok: true };
        } },
      }, ['--resume']), 0);
      const completed = openStore(f.dbPath);
      try {
        assert.equal(phase(completed).id, lifecycleId);
        assert.equal(phase(completed).note, 'cutover begin failed: drain-timeout');
      } finally { completed.close(); }
    } finally { close(f); }
  });

  it('refuses to reclaim a restore fence observed after a stale terminal phase read', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      const store = openStore(f.dbPath);
      let staleTerminal: TerminalHandBack;
      try {
        assert.equal(transition(store, 'undoing', 20).ok, true);
        assert.equal(transition(store, 'rolled-back', 30).ok, true);
        const current = phase(store);
        staleTerminal = { state: 'rolled-back', lifecycleId: current.id, restorePending: false, previousNote: current.note };
      } finally { store.close(); }
      const raced = openStoreConnection(f.dbPath);
      try { raced.prepare('UPDATE lifecycle SET note = ? WHERE id = ?').run(CSWAP_RESTORE_PENDING, staleTerminal!.lifecycleId); } finally { raced.close(); }

      let restores = 0;
      await assert.rejects(
        restoreCswap(context(f), { cswapAgent: { restorePlist: () => { restores += 1; return { ok: true }; } } }, staleTerminal!),
        { name: 'CswapUndoFinalizationError', message: 'hand-back finalization failed' },
      );
      assert.equal(restores, 0);
      const pending = openStore(f.dbPath);
      try { assert.equal(phase(pending).note, CSWAP_RESTORE_PENDING); } finally { pending.close(); }
    } finally { close(f); }
  });

  it('keeps a newly written restore fence when a legacy terminal resume fails', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      const store = openStore(f.dbPath);
      let lifecycleId = 0;
      try {
        assert.equal(transition(store, 'undoing', 20).ok, true);
        assert.equal(transition(store, 'rolled-back', 30).ok, true);
        lifecycleId = phase(store).id;
      } finally { store.close(); }
      assert.equal(await undo(f, {
        cswapAgent: { restorePlist: () => {
          const duringRestore = openStore(f.dbPath);
          try {
            assert.equal(closeLifecycle(duringRestore, lifecycleId, 'fixture', 40).code, CSWAP_RESTORE_PENDING);
          } finally { duringRestore.close(); }
          return { ok: false, code: 'fixture-restore-failed' };
        } },
      }, ['--resume']), 1);
      const pending = openStore(f.dbPath);
      try { assert.equal(phase(pending).note, CSWAP_RESTORE_PENDING); } finally { pending.close(); }
    } finally { close(f); }
  });

  it('reports a missing C-swap plist without a resume hint and keeps the fence', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      const store = openStore(f.dbPath);
      try {
        assert.equal(transition(store, 'undoing', 20).ok, true);
        assert.equal(transition(store, 'rolled-back', 30).ok, true);
      } finally { store.close(); }
      assert.equal(await undo(f, {
        cswapAgent: { restorePlist: () => ({ ok: false, code: 'cswap-plist-missing' }) },
      }, ['--resume']), 1);
      assert.match(f.output.at(-1)!, /cswap-plist-missing; reinstall C-swap by hand/);
      assert.doesNotMatch(f.output.at(-1)!, /undo cswap --resume/);
      const pending = openStore(f.dbPath);
      try { assert.equal(phase(pending).note, CSWAP_RESTORE_PENDING); } finally { pending.close(); }
    } finally { close(f); }
  });

  it('resume after a failed restore retries only the restore', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'account-a', number: 1, email: 'a@example.test', refresh: 'refresh-current', active: true });
      let bootouts = 0;
      let moves = 0;
      let restores = 0;
      const fakes = {
        bootoutQlbAgent: () => { bootouts += 1; return { ok: true }; },
        moveQlbPlist: () => { moves += 1; return { ok: true }; },
        cswapAgent: { restorePlist: () => ({ ok: ++restores > 1, code: 'fixture-restore-failed' }) },
      };
      assert.equal(await undo(f, fakes), 1);
      const writesAfterFailure = f.keychain.writes.length;
      const store = openStore(f.dbPath);
      try {
        assert.equal(phase(store).state, 'rolled-back');
        assert.equal(phase(store).note, 'cswap-restore-pending');
      } finally { store.close(); }
      assert.match(f.output.at(-1)!, /state=rolled-back; run qlb undo cswap --resume/);
      f.output.length = 0;
      assert.equal(await undo(f, fakes, ['--resume']), 0);
      assert.equal(bootouts, 1);
      assert.equal(moves, 1);
      assert.equal(restores, 2);
      assert.equal(f.keychain.writes.length, writesAfterFailure);
      const resumed = openStore(f.dbPath);
      try { assert.equal(phase(resumed).note, null); } finally { resumed.close(); }
      assert.match(f.output[0]!, /qlb lifecycle close \d+/);
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

  it('a dead qlb-add active slot refuses by name before the fence', async () => {
    const f = fixture();
    try {
      beginUndo(f);
      addSlot(f, { accountId: 'dead-add', number: 1, email: 'dead@example.test', refresh: 'refresh-dead', source: 'qlb-add', active: true, dead: true });
      let bootouts = 0;
      assert.equal(await undo(f, { bootoutQlbAgent: () => { bootouts += 1; return { ok: true }; } }), 3);
      assert.match(f.output[0]!, /qlb-add slots 1 \(dead@example\.test\)/);
      assert.equal(bootouts, 0);
      const store = openStore(f.dbPath);
      try { assert.equal(phase(store).state, 'cutover'); } finally { store.close(); }
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

describe('qlb undo cswap doctor diagnostic', () => {
  it('reports an undoing lifecycle as undo-unfinished with its start time and resume command', () => {
    const f = fixture();
    try {
      beginUndo(f);
      const store = openStore(f.dbPath);
      try { assert.equal(transition(store, 'undoing', 123).ok, true); } finally { store.close(); }
      assert.deepEqual(undoIncompleteCheck(f.dbPath, { available: true, phase: 'undoing' }), {
        name: 'undo:incomplete',
        level: 'FAIL',
        message: 'undo-unfinished: undo_began_at=123; run qlb undo cswap --resume',
      });
    } finally { close(f); }
  });

  it('reports a restore-pending rollback with the resume command', () => {
    const f = fixture();
    try {
      beginUndo(f);
      const store = openStore(f.dbPath);
      try {
        assert.equal(transition(store, 'undoing', 123).ok, true);
        assert.equal(transition(store, 'rolled-back', 124, CSWAP_RESTORE_PENDING).ok, true);
      } finally { store.close(); }
      assert.deepEqual(undoIncompleteCheck(f.dbPath, { available: true, phase: 'rolled-back', restorePending: true }), {
        name: 'undo:incomplete',
        level: 'FAIL',
        message: 'cswap-restore-pending: run qlb undo cswap --resume',
      });
    } finally { close(f); }
  });

  it('reports no incomplete undo after a completed rollback', () => {
    const f = fixture();
    try {
      beginUndo(f);
      const store = openStore(f.dbPath);
      try {
        assert.equal(transition(store, 'undoing', 123).ok, true);
        assert.equal(transition(store, 'rolled-back', 124).ok, true);
      } finally { store.close(); }
      assert.deepEqual(undoIncompleteCheck(f.dbPath, { available: true, phase: 'rolled-back' }), {
        name: 'undo:incomplete', level: 'PASS', message: 'no incomplete undo',
      });
    } finally { close(f); }
  });

  it('reports no incomplete undo after an aborted cutover setup', () => {
    const f = fixture();
    try {
      assert.deepEqual(undoIncompleteCheck(f.dbPath, { available: true, phase: 'aborted' }), {
        name: 'undo:incomplete', level: 'PASS', message: 'no incomplete undo',
      });
    } finally { close(f); }
  });

  it('is not applicable during cutover', () => {
    const f = fixture();
    try {
      beginUndo(f);
      assert.deepEqual(undoIncompleteCheck(f.dbPath, { available: true, phase: 'cutover' }), {
        name: 'undo:incomplete', level: 'N/A', message: 'not applicable in phase=cutover',
      });
    } finally { close(f); }
  });
});
