import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { openStore } from '../src/store';

function runAdapterScript(script: string, extraEnv: NodeJS.ProcessEnv = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const home = mkdtempSync(join(tmpdir(), 'qlb-adapter-probe-home-'));
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home, ...extraEnv },
    timeout: 20_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function seedLifecycle(dbPath: string, state: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`INSERT INTO claude_slots (account_id, slot_num, config_json, fingerprint, added_at)
      VALUES ('account', 1, '{}', 'fixture', 1)`).run();
    if (state !== 'pre-cutover') db.prepare('INSERT INTO lifecycle (state, began_at) VALUES (?, 1)').run(state);
  } finally {
    db.close();
  }
}

function writeCswapCache(root: string): { sequence: string; usage: string } {
  const sequence = join(root, 'cswap', 'sequence.json');
  const usage = join(root, 'cswap', 'cache', 'usage.json');
  mkdirSync(join(root, 'cswap', 'cache'), { recursive: true });
  writeFileSync(sequence, JSON.stringify({
    sequence: [1], activeAccountNumber: 1,
    accounts: { '1': { email: 'a@example.com', organizationUuid: 'org-1' } },
  }));
  writeFileSync(usage, JSON.stringify({
    schemaVersion: 2,
    accounts: { '1': { email: 'a@example.com', organizationUuid: 'org-1', fetchedAt: Math.floor(Date.now() / 1000), lastGood: { five_hour: { pct: 11 } } } },
  }));
  return { sequence, usage };
}

function adapterSnapshots(db: string, sequence: string, usage: string): Array<{ error?: string; buckets: Record<string, { usedPct?: number }> }> {
  const adapterJs = join(__dirname, '..', 'src', 'adapters', 'anthropic.js');
  const result = runAdapterScript(`
    process.env.QLB_CSWAP_SEQUENCE_PATH = ${JSON.stringify(sequence)};
    process.env.QLB_CSWAP_USAGE_PATH = ${JSON.stringify(usage)};
    process.env.QLB_DB_PATH = ${JSON.stringify(db)};
    const { anthropicAdapter } = require(${JSON.stringify(adapterJs)});
    anthropicAdapter.fetchSnapshots().then((snaps) => process.stdout.write(JSON.stringify(snaps)));
  `);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Array<{ error?: string; buckets: Record<string, { usedPct?: number }> }>;
}

describe('adapter empty-cache probe attachment', () => {
  it('anthropic falls back to the cache when QLB has no usage poll rows and does not call fetch', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-anth-probe-'));
    mkdirSync(join(root, 'migrate'), { recursive: true });
    mkdirSync(join(root, 'cswap', 'cache'), { recursive: true });
    const sequence = join(root, 'cswap', 'sequence.json');
    const usage = join(root, 'cswap', 'cache', 'usage.json');
    const db = join(root, 'qlb.db');
    const nowS = Math.floor(Date.now() / 1000);
    writeFileSync(sequence, JSON.stringify({
      sequence: [1],
      activeAccountNumber: 1,
      accounts: { '1': { email: 'a@example.com', organizationUuid: 'org-1' } },
    }));
    writeFileSync(usage, JSON.stringify({
      schemaVersion: 2,
      accounts: {
        '1': {
          email: 'a@example.com',
          organizationUuid: 'org-1',
          fetchedAt: nowS,
          authDeadStrikes: 0,
          lastGood: {
            five_hour: { pct: 11 },
            seven_day: { pct: 22 },
            scoped: [{ name: 'Fable', pct: 33 }],
          },
        },
      },
    }));
    const adapterJs = join(__dirname, '..', 'src', 'adapters', 'anthropic.js');
    const script = `
      process.env.QLB_CSWAP_SEQUENCE_PATH = ${JSON.stringify(sequence)};
      process.env.QLB_CSWAP_USAGE_PATH = ${JSON.stringify(usage)};
      process.env.QLB_DB_PATH = ${JSON.stringify(db)};
      globalThis.fetch = async () => { throw new Error('network down'); };
      const { anthropicAdapter } = require(${JSON.stringify(adapterJs)});
      anthropicAdapter.fetchSnapshots().then((snaps) => {
        process.stdout.write(JSON.stringify(snaps));
      }).catch((err) => {
        console.error(err);
        process.exit(1);
      });
    `;
    const result = runAdapterScript(script, {
      QLB_CSWAP_SEQUENCE_PATH: sequence,
      QLB_CSWAP_USAGE_PATH: usage,
      QLB_DB_PATH: db,
    });
    assert.equal(result.status, 0, result.stderr);
    const snaps = JSON.parse(result.stdout) as Array<{
      error?: string;
      buckets: Record<string, { usedPct?: number }>;
    }>;
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0]?.error, undefined);
    assert.equal(snaps[0]?.buckets['5h']?.usedPct, 11);
    assert.equal(snaps[0]?.buckets['7d']?.usedPct, 22);
    assert.equal(snaps[0]?.buckets['7d:Fable']?.usedPct, 33);
  });

  it('uses QLB usage only during the Claude cutover lifecycle phases', () => {
    for (const [phase, qlbOwns] of [
      ['pre-cutover', false], ['rolled-back', false], ['closed', false],
      ['cutting-over', true], ['cutover', true], ['retired', true],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), `qlb-anthropic-phase-${phase}-`));
      const { sequence, usage } = writeCswapCache(root);
      const db = join(root, 'qlb.db');
      const store = openStore(db);
      store.recordUsagePollResult('anthropic', 'account', {
        attemptedAt: Math.floor(Date.now() / 1000), status: 'ok',
        readings: { '5h': { usedPct: 99, fetchedAt: Date.now(), source: 'poll', confidence: 'authoritative' } },
      });
      store.close();
      seedLifecycle(db, phase);

      const snapshots = adapterSnapshots(db, sequence, usage);
      assert.equal(snapshots[0]?.buckets['5h']?.usedPct, qlbOwns ? 99 : 11, phase);
    }
  });

  it('returns an error snapshot instead of C-swap data when the QLB-owned store cannot be read', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-anthropic-store-error-'));
    const { sequence, usage } = writeCswapCache(root);
    const dbPath = join(root, 'qlb.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE lifecycle (id INTEGER PRIMARY KEY, state TEXT NOT NULL, began_at INTEGER NOT NULL, closed_at INTEGER)');
      db.prepare("INSERT INTO lifecycle (state, began_at) VALUES ('cutover', 1)").run();
    } finally {
      db.close();
    }

    const snapshots = adapterSnapshots(dbPath, sequence, usage);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.buckets['5h'], undefined);
    assert.equal(snapshots[0]?.error, 'QLB usage store unavailable');
  });

  it('kimi empty cache + rejected fetch stamps cached-after-failure with accurate detail', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-kimi-probe-'));
    const keyFile = join(root, 'kimi.md');
    const db = join(root, 'qlb.db');
    writeFileSync(keyFile, 'sk-kimi-TESTKEY123');
    const adapterJs = join(__dirname, '..', 'src', 'adapters', 'kimi.js');
    const script = `
      process.env.QLB_KIMI_CREDENTIALS_FILE = ${JSON.stringify(keyFile)};
      process.env.QLB_DB_PATH = ${JSON.stringify(db)};
      globalThis.fetch = async () => {
        throw new Error('ECONNRESET');
      };
      const { kimiAdapter } = require(${JSON.stringify(adapterJs)});
      kimiAdapter.fetchSnapshots().then((snaps) => {
        process.stdout.write(JSON.stringify(snaps));
      }).catch((err) => {
        console.error(err);
        process.exit(1);
      });
    `;
    const result = runAdapterScript(script, {
      QLB_KIMI_CREDENTIALS_FILE: keyFile,
      QLB_DB_PATH: db,
    });
    assert.equal(result.status, 0, result.stderr);
    const snaps = JSON.parse(result.stdout) as Array<{
      error?: string;
      probe?: { outcome: string; detail?: string };
    }>;
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0]?.probe?.outcome, 'cached-after-failure');
    assert.match(snaps[0]?.probe?.detail ?? '', /ECONNRESET|request failed/);
    assert.ok(snaps[0]?.error);
  });
});
