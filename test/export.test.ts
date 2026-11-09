import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { cacheOnlyExport } from '../src/export';
import { beginCutover } from '../src/lifecycle';
import { openStore } from '../src/store';

const cliPath = join(__dirname, '..', 'src', 'cli.js');

type CliResult = { status: number; stdout: string; stderr: string };

function runExport(dbPath: string | undefined, preload?: string, env: NodeJS.ProcessEnv = {}): CliResult {
  const args = [preload ? `--require=${preload}` : '', cliPath, 'export', '--cache-only', '--json'].filter(Boolean);
  try {
    const stdout = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, QLB_TEST_MODE: '1', ...env, ...(dbPath === undefined ? {} : { QLB_DB_PATH: dbPath }) },
      timeout: 5_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const error = err as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fixtureDb(includeExternalCache = false): { path: string; freshAt: number; staleAt: number; poolRecordedAt: number } {
  const root = mkdtempSync(join(tmpdir(), 'qlb-export-'));
  const path = join(root, 'qlb.db');
  const now = Date.now();
  const freshAt = now - 300_000 + 1_000;
  const staleAt = now - 300_000 - 1_000;
  const poolRecordedAt = now - 60_000;
  const store = openStore(path);
  try {
    beginCutover(store, poolRecordedAt - 1);
    store.upsertAccount('anthropic-a', 'anthropic', 'account-a');
    store.upsertAccount('anthropic-b', 'anthropic', 'account-b');
    store.recordPiExportTargetsIfEmptyClassified('anthropic', () => ({
      recordedAt: poolRecordedAt,
      complete: false,
      targets: [
        { provider: 'anthropic' as const, target: 'pi-a', slotAccountId: 'anthropic-a', lineageFp: 'not-exported-a', recordedAt: poolRecordedAt },
        { provider: 'anthropic' as const, target: 'pi-b', slotAccountId: 'anthropic-b', lineageFp: 'not-exported-b', recordedAt: poolRecordedAt },
      ],
      members: [
        { target: 'pi-a', slotAccountId: 'anthropic-a' },
        { target: 'pi-b', slotAccountId: 'anthropic-b' },
        { target: 'pi-unmatched', slotAccountId: null },
      ],
    }), () => ({ ok: true }));
    store.upsertSnapshot('anthropic-a', 'five-hour', {
      usedPct: 12,
      remaining: 88,
      fetchedAt: freshAt,
      source: 'provider-poll',
      confidence: 'authoritative',
    });
    store.upsertSnapshot('anthropic-a', 'seven-day', {
      usedPct: 75,
      fetchedAt: staleAt,
      source: 'headers',
      confidence: 'advisory',
    });
    if (includeExternalCache) {
      store.upsertSnapshot('anthropic-b', 'five-hour', {
        usedPct: 25,
        fetchedAt: freshAt,
        source: 'external-cache',
        confidence: 'unknown',
      });
    }
  } finally {
    store.close();
  }
  return { path, freshAt, staleAt, poolRecordedAt };
}

describe('cache-only export', () => {
  it('emits stored readings with timestamps and stale flags without changing the database', () => {
    const fixture = fixtureDb(true);
    const before = hash(fixture.path);
    const result = runExport(fixture.path);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(hash(fixture.path), before);

    const body = JSON.parse(result.stdout) as {
      exportedAt: number;
      readings: Array<{ bucket: string; fetchedAt: number; stale: boolean; routingAuthority: string; accountId: string; provider: string; source: string; status: string }>;
      surfaces: Array<{ id: string; recordedAt: number; complete: boolean; members: Array<{ target: string; accountId: string | null; readings: unknown[] }> }>;
    };
    assert.equal(typeof body.exportedAt, 'number');
    assert.deepEqual(body.readings.map((reading) => ({
      bucket: reading.bucket,
      fetchedAt: reading.fetchedAt,
      stale: reading.stale,
      accountId: reading.accountId,
      provider: reading.provider,
      source: reading.source,
      status: reading.status,
      routingAuthority: reading.routingAuthority,
    })), [
      { bucket: 'five-hour', fetchedAt: fixture.freshAt, stale: false, accountId: 'anthropic-a', provider: 'anthropic', source: 'provider-poll', status: 'active', routingAuthority: 'fresh-provider' },
      { bucket: 'seven-day', fetchedAt: fixture.staleAt, stale: true, accountId: 'anthropic-a', provider: 'anthropic', source: 'headers', status: 'active', routingAuthority: 'display-only' },
      { bucket: 'five-hour', fetchedAt: fixture.freshAt, stale: false, accountId: 'anthropic-b', provider: 'anthropic', source: 'external-cache', status: 'active', routingAuthority: 'display-only' },
    ]);
    assert.deepEqual(body.surfaces, [{
      id: 'anthropic-pi-pool',
      source: 'pool-inventory',
      recordedAt: fixture.poolRecordedAt,
      complete: false,
      members: [
        { target: 'pi-a', accountId: 'anthropic-a', readings: body.readings.slice(0, 2) },
        { target: 'pi-b', accountId: 'anthropic-b', readings: body.readings.slice(2) },
        { target: 'pi-unmatched', accountId: null, readings: [] },
      ],
    }]);
    assert.doesNotMatch(result.stdout, /lineage/i);
    assert.equal(result.stdout.includes('not-exported-a'), false);
    assert.equal(result.stdout.includes('not-exported-b'), false);
  });

  it('omits surfaces when no persisted Anthropic Pi targets exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-export-empty-'));
    const path = join(root, 'qlb.db');
    const store = openStore(path);
    store.close();
    assert.deepEqual(cacheOnlyExport(Date.now(), path).surfaces, []);
  });

  it('preserves ordinary readings when an older database lacks inventory tables', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-export-legacy-'));
    const path = join(root, 'qlb.db');
    const db = new DatabaseSync(path);
    try {
      db.exec(`
        CREATE TABLE accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL);
        CREATE TABLE snapshots (account_id TEXT NOT NULL, bucket TEXT NOT NULL, used_pct REAL, used REAL, limit_val REAL, remaining REAL, reset_at INTEGER, fetched_at INTEGER NOT NULL, source TEXT NOT NULL, confidence TEXT NOT NULL);
      `);
      db.prepare(`INSERT INTO accounts VALUES ('legacy-anthropic', 'anthropic', 'legacy', 'active')`).run();
      db.prepare(`INSERT INTO snapshots VALUES ('legacy-anthropic', '5h', 25, NULL, NULL, NULL, NULL, 1700000000000, 'poll', 'authoritative')`).run();
    } finally {
      db.close();
    }
    const result = runExport(path);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).surfaces, []);
    assert.equal(JSON.parse(result.stdout).readings[0].accountId, 'legacy-anthropic');
  });

  it('omits target mappings until an inventory is recorded', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-export-target-only-'));
    const path = join(root, 'qlb.db');
    const store = openStore(path);
    try {
      beginCutover(store, 1);
      store.replacePiExportTargets('anthropic', [{
        provider: 'anthropic', target: 'legacy-target', slotAccountId: 'legacy-account', lineageFp: 'legacy-fp', recordedAt: 1,
      }]);
    } finally {
      store.close();
    }
    assert.deepEqual(cacheOnlyExport(Date.now(), path).surfaces, []);
  });

  it('serves persisted pool inventory only in active lifecycle states', () => {
    const fixture = fixtureDb();
    const setState = (state: string | null) => {
      const db = new DatabaseSync(fixture.path);
      try {
        if (state === null) db.exec('DELETE FROM lifecycle');
        else db.prepare('UPDATE lifecycle SET state = ?').run(state);
      } finally {
        db.close();
      }
    };
    for (const state of ['cutting-over', 'cutover', 'retired']) {
      setState(state);
      assert.equal(cacheOnlyExport(Date.now(), fixture.path).surfaces.length, 1, state);
    }
    for (const state of ['undoing', 'rolled-back', 'aborted']) {
      setState(state);
      assert.deepEqual(cacheOnlyExport(Date.now(), fixture.path).surfaces, [], state);
    }
    setState(null);
    assert.deepEqual(cacheOnlyExport(Date.now(), fixture.path).surfaces, []);
    const store = openStore(fixture.path);
    try {
      beginCutover(store, Date.now());
      (store as unknown as { db: DatabaseSync }).db.prepare("UPDATE lifecycle SET state = 'retired'").run();
    } finally {
      store.close();
    }
    assert.deepEqual(cacheOnlyExport(Date.now(), fixture.path).surfaces, []);
  });

  it('requires a new inventory after beginning a new lifecycle generation', () => {
    const fixture = fixtureDb();
    const store = openStore(fixture.path);
    const beganAt = Date.now();
    const recordedAt = beganAt + 1;
    try {
      const db = (store as unknown as { db: DatabaseSync }).db;
      db.prepare("UPDATE lifecycle SET state = 'closed'").run();
      beginCutover(store, beganAt);
      assert.deepEqual(cacheOnlyExport(Date.now(), fixture.path).surfaces, []);

      const recorded = store.recordPiExportTargetsIfEmptyClassified('anthropic', () => ({
        recordedAt,
        complete: true,
        targets: [],
        members: [
          { target: 'pi-a', slotAccountId: 'anthropic-a' },
          { target: 'pi-b', slotAccountId: 'anthropic-b' },
        ],
      }), () => ({ ok: true }));
      assert.equal(recorded.ok, true);
    } finally {
      store.close();
    }
    const [surface] = cacheOnlyExport(Date.now(), fixture.path).surfaces;
    assert.equal(surface?.recordedAt, recordedAt);
    assert.equal(surface?.complete, true);
  });

  it('refuses a database schema newer than this build without output rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-export-newer-'));
    const path = join(root, 'qlb.db');
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA user_version = 7');
    } finally {
      db.close();
    }
    const result = runExport(path);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /newer than this binary/);
  });

  it('uses the configured database path', () => {
    const fixture = fixtureDb();
    const home = mkdtempSync(join(tmpdir(), 'qlb-export-home-'));
    mkdirSync(join(home, '.qlb'));
    writeFileSync(join(home, '.qlb', 'config.json'), JSON.stringify({ dbPath: fixture.path }));
    const result = runExport(undefined, undefined, { QLB_HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).readings.length, 2);
  });

  it('does not load provider adapters or credential modules', () => {
    const fixture = fixtureDb();
    const guard = join(mkdtempSync(join(tmpdir(), 'qlb-export-guard-')), 'guard.cjs');
    writeFileSync(guard, `
const Module = require('node:module');
const load = Module._load;
const allowed = new Set(['./export', './config', './home', './schema-version', './usage-freshness']);
Module._load = function(request, parent, isMain) {
  if (!isMain && !request.startsWith('node:') && !allowed.has(request)) {
    throw new Error('forbidden module loaded: ' + request);
  }
  return load.call(this, request, parent, isMain);
};
`);
    const result = runExport(fixture.path, guard);
    assert.equal(result.status, 0, result.stderr);
  });

  it('keeps ordinary commands in the invoking process', () => {
    const guard = join(mkdtempSync(join(tmpdir(), 'qlb-cli-guard-')), 'guard.cjs');
    writeFileSync(guard, `
const childProcess = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => { throw new Error('unexpected child process'); };
}
`);
    const output = execFileSync(process.execPath, [`--require=${guard}`, cliPath, '--list-commands', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: mkdtempSync(join(tmpdir(), 'qlb-cli-home-')) },
    });
    assert.ok(JSON.parse(output).includes('status'));
  });

  it('returns a fixture export in under 200 ms in process', () => {
    const fixture = fixtureDb();
    const started = performance.now();
    const output = cacheOnlyExport(Date.now(), fixture.path);
    assert.equal(output.readings.length, 2);
    assert.ok(performance.now() - started < 200);
  });
});
