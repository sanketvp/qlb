import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { cacheOnlyExport } from '../src/export';
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

function fixtureDb(): { path: string; freshAt: number; staleAt: number; poolRecordedAt: number } {
  const root = mkdtempSync(join(tmpdir(), 'qlb-export-'));
  const path = join(root, 'qlb.db');
  const now = Date.now();
  const freshAt = now - 300_000 + 1_000;
  const staleAt = now - 300_000 - 1_000;
  const poolRecordedAt = now - 60_000;
  const store = openStore(path);
  try {
    store.upsertAccount('anthropic-a', 'anthropic', 'account-a');
    store.upsertAccount('anthropic-b', 'anthropic', 'account-b');
    store.replacePiExportTargets('anthropic', [
      { provider: 'anthropic', target: 'pi-a', slotAccountId: 'anthropic-a', lineageFp: 'not-exported-a', recordedAt: poolRecordedAt },
      { provider: 'anthropic', target: 'pi-b', slotAccountId: 'anthropic-b', lineageFp: 'not-exported-b', recordedAt: poolRecordedAt },
    ]);
    store.upsertSnapshot('anthropic-a', 'five-hour', {
      usedPct: 12,
      remaining: 88,
      fetchedAt: freshAt,
      source: 'poll',
      confidence: 'authoritative',
    });
    store.upsertSnapshot('anthropic-a', 'seven-day', {
      usedPct: 75,
      fetchedAt: staleAt,
      source: 'headers',
      confidence: 'advisory',
    });
  } finally {
    store.close();
  }
  return { path, freshAt, staleAt, poolRecordedAt };
}

describe('cache-only export', () => {
  it('emits stored readings with timestamps and stale flags without changing the database', () => {
    const fixture = fixtureDb();
    const before = hash(fixture.path);
    const result = runExport(fixture.path);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(hash(fixture.path), before);

    const body = JSON.parse(result.stdout) as {
      exportedAt: number;
      readings: Array<{ bucket: string; fetchedAt: number; stale: boolean; accountId: string; provider: string; status: string }>;
      surfaces: Array<{ id: string; members: Array<{ target: string; accountId: string; recordedAt: number; readings: unknown[] }> }>;
    };
    assert.equal(typeof body.exportedAt, 'number');
    assert.deepEqual(body.readings.map((reading) => ({
      bucket: reading.bucket,
      fetchedAt: reading.fetchedAt,
      stale: reading.stale,
      accountId: reading.accountId,
      provider: reading.provider,
      status: reading.status,
    })), [
      { bucket: 'five-hour', fetchedAt: fixture.freshAt, stale: false, accountId: 'anthropic-a', provider: 'anthropic', status: 'active' },
      { bucket: 'seven-day', fetchedAt: fixture.staleAt, stale: true, accountId: 'anthropic-a', provider: 'anthropic', status: 'active' },
    ]);
    assert.deepEqual(body.surfaces, [{
      id: 'anthropic-pi-pool',
      members: [
        { target: 'pi-a', accountId: 'anthropic-a', recordedAt: fixture.poolRecordedAt, readings: body.readings },
        { target: 'pi-b', accountId: 'anthropic-b', recordedAt: fixture.poolRecordedAt, readings: [] },
      ],
    }]);
    assert.doesNotMatch(result.stdout, /lineage/i);
  });

  it('omits surfaces when no persisted Anthropic Pi targets exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-export-empty-'));
    const path = join(root, 'qlb.db');
    const store = openStore(path);
    store.close();
    assert.deepEqual(cacheOnlyExport(Date.now(), path).surfaces, []);
  });

  it('refuses a database schema newer than this build without output rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-export-newer-'));
    const path = join(root, 'qlb.db');
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA user_version = 6');
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
