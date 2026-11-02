import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runUndoCswapCommand } from '../src/commands/undo-cswap';
import { discoverCommands, resolveCommand, type CommandContext } from '../src/registry';
import { openStore, openStoreConnection } from '../src/store';
import { runExecutingCommand } from '../src/cli';

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
  private readonly values = new Map<string, string>();

  set(service: string, account: string, value: string): void {
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
    env: { QLB_TEST_MODE: '1', QLB_HOME: f.home, HOME: f.home },
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
        assert.deepEqual(f.output, ['ERR:qlb undo cswap: plan unavailable']);
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
