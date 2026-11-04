import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { recordRelogin } from '../src/relogin';
import { reloginDetailFingerprint } from '../src/relogin-fields';
import { openStore, openStoreConnection, sanitizeReloginFieldsForRead } from '../src/store';

const cliPath = join(__dirname, '..', 'src', 'cli.js');
const START = Date.UTC(2026, 10, 1, 12, 0, 0);
const END = START + 60_000;

type Fixture = { env: NodeJS.ProcessEnv; dbPath: string };
type CliResult = { status: number; stdout: string; stderr: string };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'qlb-status-switches-'));
  mkdirSync(join(root, 'plugins'));
  return {
    dbPath: join(root, 'qlb.db'),
    env: {
      QLB_TEST_MODE: '1',
      QLB_HOME: root,
      HOME: root,
      QLB_DB_PATH: join(root, 'qlb.db'),
      QLB_PLUGINS_DIR: join(root, 'plugins'),
      QLB_CONFIG_PATH: join(root, 'config.json'),
      QLB_ANTHROPIC_POOL_PATH: join(root, 'missing-anthropic.json'),
      QLB_PI_AUTH_JSON_PATH: join(root, 'missing-pi-auth.json'),
      QLB_CODEX_AUTH_JSON_PATH: join(root, 'missing-codex-auth.json'),
      QLB_KIMI_CREDENTIALS_FILE: join(root, 'missing-kimi.md'),
      QLB_CLAUDE_CODE_CREDENTIALS_PATH: join(root, 'missing-claude-credentials'),
      QLB_CSWAP_SEQUENCE_PATH: join(root, 'missing-sequence.json'),
      QLB_CSWAP_USAGE_PATH: join(root, 'missing-usage.json'),
    },
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): CliResult {
  // Node <26 prints an ExperimentalWarning for node:sqlite on stderr; keep stderr assertions exact.
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cliPath, ...args], {
    encoding: 'utf8', env, timeout: 60_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function seedLifecycle(dbPath: string): void {
  const db = openStoreConnection(dbPath);
  try {
    db.prepare("INSERT INTO lifecycle (state, began_at, cutover_at, window_end) VALUES ('cutover', ?, ?, ?)")
      .run(START, START, END);
  } finally {
    db.close();
  }
}

function seedStore(f: Fixture): ReturnType<typeof openStore> {
  return openStore(f.dbPath);
}

describe('status switch and relogin history', () => {
  it('--switches --window --json lists only rows inside the window with injected as a boolean', () => {
    const f = fixture();
    const store = seedStore(f);
    store.recordSwitch({ ts: START - 1, provider: 'anthropic', toAccount: 'old', trigger: 'manual', outcome: 'ok' });
    store.recordSwitch({ ts: START + 1, provider: 'anthropic', fromAccount: 'a', toAccount: 'b', trigger: 'failover', outcome: 'ok', detail: 'inside', injected: true });
    store.recordSwitch({ ts: END + 1, provider: 'anthropic', toAccount: 'new', trigger: 'manual', outcome: 'ok' });
    store.close();
    seedLifecycle(f.dbPath);

    const result = runCli(['status', '--switches', '--window', '--json'], f.env);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout) as { switches: Array<Record<string, unknown>> };
    assert.equal(Object.keys(body).length, 1);
    assert.equal(body.switches.length, 1);
    assert.equal(body.switches[0].to, 'b');
    assert.equal(body.switches[0].injected, true);
    assert.equal(typeof body.switches[0].injected, 'boolean');
    assert.equal(body.switches[0].ts, new Date(START + 1).toISOString());
  });

  it('--relogins --window --json lists the window\'s relogin rows including external-login', () => {
    const f = fixture();
    const store = seedStore(f);
    recordRelogin(store, { ts: START - 1, provider: 'anthropic', accountId: 'old', kind: 'dead' });
    recordRelogin(store, { ts: START + 1, provider: 'anthropic', accountId: 'live', kind: 'external-login', detail: 'outside-qlb' });
    recordRelogin(store, { ts: END + 1, provider: 'anthropic', accountId: 'new', kind: 'healed' });
    store.close();
    seedLifecycle(f.dbPath);

    const result = runCli(['status', '--relogins', '--window', '--json'], f.env);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout) as { relogins: Array<Record<string, unknown>> };
    assert.equal(body.relogins.length, 1);
    assert.equal(body.relogins[0].kind, 'external-login');
    assert.equal(body.relogins[0].ts, new Date(START + 1).toISOString());
  });

  it('--window without a cutover row exits 3', () => {
    const f = fixture();
    const store = seedStore(f);
    store.close();

    const result = runCli(['status', '--switches', '--window', '--json'], f.env);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /no-cutover-window/);
    assert.equal(result.stdout, '');
  });

  it('stdout parses as one object while a warning is on stderr', () => {
    const f = fixture();
    const store = seedStore(f);
    store.recordSwitch({ ts: START, provider: 'anthropic', toAccount: 'b', trigger: 'manual', outcome: 'ok' });
    store.close();

    const result = runCli(['status', '--switches', '--json'], f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(Object.keys(JSON.parse(result.stdout) as object), ['switches']);
    assert.match(result.stderr, /warning/);
  });

  it('no token-shaped string reaches stdout', () => {
    const f = fixture();
    const store = seedStore(f);
    store.recordSwitch({ ts: START, provider: 'anthropic', toAccount: 'b', trigger: 'manual', outcome: 'ok' });
    store.close();
    const token = `sk-ant-oat01-${'a'.repeat(64)}`;
    const db = openStoreConnection(f.dbPath);
    try {
      db.prepare('UPDATE switch_log SET detail = ?').run(token);
    } finally {
      db.close();
    }

    const result = runCli(['status', '--switches', '--json'], f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(token));
    assert.match(result.stdout, /\[redacted\]/);
  });

  it('scrubs legacy relogin detail on read when the scrub marker is absent', () => {
    const f = fixture();
    const store = seedStore(f);
    store.close();
    const sensitiveDetail = 'legacy customer recovery note';
    const db = new DatabaseSync(f.dbPath);
    try {
      db.prepare("DELETE FROM config WHERE key = 'relogin.scrubbedAt'").run();
      db.prepare(`INSERT INTO relogin_events (ts, provider, account_id, kind, detail, evidence)
        VALUES (?, ?, ?, ?, ?, ?)`).run(START, 'anthropic', 'account-a', 'external-login', sensitiveDetail, 'invalid');
    } finally {
      db.close();
    }

    const result = runCli(['status', '--relogins', '--json'], f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(sensitiveDetail));
    const body = JSON.parse(result.stdout) as { relogins: Array<{ detail: string | null; evidence: string | null }> };
    assert.match(body.relogins[0]?.detail ?? '', /^sha256:[0-9a-f]{16}$/);
    assert.equal(body.relogins[0]?.evidence, null);
    const after = new DatabaseSync(f.dbPath, { readOnly: true });
    try {
      assert.equal(after.prepare("SELECT 1 FROM config WHERE key = 'relogin.scrubbedAt'").get(), undefined);
      assert.equal((after.prepare('SELECT detail FROM relogin_events').get() as { detail: string }).detail, sensitiveDetail);
    } finally {
      after.close();
    }
  });

  it('sanitizes unsafe rows inserted after the scrub marker', () => {
    const f = fixture();
    const store = seedStore(f);
    store.close();
    const sensitiveDetail = 'legacy customer recovery note after marker';
    const db = new DatabaseSync(f.dbPath);
    try {
      db.prepare(`INSERT INTO relogin_events (ts, provider, account_id, kind, detail, evidence)
        VALUES (?, ?, ?, ?, ?, ?)`).run(START, 'anthropic', 'account-a', 'external-login', sensitiveDetail, 'invalid');
    } finally {
      db.close();
    }

    const result = runCli(['status', '--relogins', '--json'], f.env);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(sensitiveDetail));
    const body = JSON.parse(result.stdout) as { relogins: Array<{ detail: string | null; evidence: string | null }> };
    assert.equal(body.relogins[0]?.detail, reloginDetailFingerprint(sensitiveDetail));
    assert.equal(body.relogins[0]?.evidence, null);
  });

  it('preserves canonical relogin fingerprints with and without the scrub marker', () => {
    const fingerprint = 'sha256:0123456789abcdef';
    for (const marker of [true, false]) {
      const f = fixture();
      const store = seedStore(f);
      store.close();
      const db = new DatabaseSync(f.dbPath);
      try {
        if (!marker) db.prepare("DELETE FROM config WHERE key = 'relogin.scrubbedAt'").run();
        db.prepare(`INSERT INTO relogin_events (ts, provider, account_id, kind, detail, evidence)
          VALUES (?, ?, ?, ?, ?, ?)`).run(START, 'anthropic', 'account-a', 'external-login', fingerprint, 'dead');
      } finally {
        db.close();
      }

      const result = runCli(['status', '--relogins', '--json'], f.env);
      assert.equal(result.status, 0, result.stderr);
      const body = JSON.parse(result.stdout) as { relogins: Array<{ detail: string | null }> };
      assert.equal(body.relogins[0]?.detail, fingerprint);
    }
  });

  it('sanitizes relogin fields idempotently', () => {
    for (const detail of ['legacy customer recovery note', 'sha256:0123456789abcdef', 'dead', null]) {
      const once = sanitizeReloginFieldsForRead({ detail, evidence: 'invalid' });
      assert.deepEqual(sanitizeReloginFieldsForRead(once), once);
    }
  });

  it('refuses history on a schema that requires migration', () => {
    const f = fixture();
    const store = seedStore(f);
    store.close();
    const db = new DatabaseSync(f.dbPath);
    try {
      db.exec('PRAGMA user_version = 4');
    } finally {
      db.close();
    }

    const result = runCli(['status', '--switches', '--json'], f.env);
    assert.equal(result.status, 3, result.stderr);
    assert.equal(result.stderr, 'qlb status: refused: schema-migration-required\n');
  });

  it('returns empty unwindowed history for a missing store and no-cutover-window when windowed', () => {
    const f = fixture();
    for (const history of ['--switches', '--relogins']) {
      const unwindowed = runCli(['status', history, '--json'], f.env);
      assert.equal(unwindowed.status, 0, unwindowed.stderr);
      assert.deepEqual(JSON.parse(unwindowed.stdout), history === '--switches' ? { switches: [] } : { relogins: [] });
    }
    const windowed = runCli(['status', '--switches', '--window', '--json'], f.env);
    assert.equal(windowed.status, 3, windowed.stderr);
    assert.match(windowed.stderr, /no-cutover-window/);
  });

  it('resolve rejects history flags with the usage exit code before writing a routing decision', () => {
    for (const flag of ['--switches', '--relogins', '--window']) {
      const f = fixture();
      const result = runCli(['resolve', '--model', 'claude-opus-4', flag], f.env);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /only valid with status/);
      assert.equal(existsSync(f.dbPath), false);
    }
  });

  it('uses the usage exit code for history flag conflicts', () => {
    const f = fixture();
    for (const args of [
      ['status', '--dashboard', '--switches'],
      ['status', '--flat', '--switches'],
      ['status', '--window'],
    ]) {
      const result = runCli(args, f.env);
      assert.equal(result.status, 1, result.stderr);
    }
  });
});
