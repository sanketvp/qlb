import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { CACHE_EXPORT_STALE_AFTER_MS } from '../src/export';
import { openStore } from '../src/store';

const cliPath = join(__dirname, '..', 'src', 'cli.js');

type CliResult = { status: number; stdout: string; stderr: string; elapsedMs: number };

function runExport(dbPath: string, preload?: string): CliResult {
  const args = [preload ? `--require=${preload}` : '', cliPath, 'export', '--cache-only', '--json'].filter(Boolean);
  const started = performance.now();
  try {
    const stdout = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, QLB_TEST_MODE: '1', QLB_DB_PATH: dbPath },
      timeout: 5_000,
    });
    return { status: 0, stdout, stderr: '', elapsedMs: performance.now() - started };
  } catch (err) {
    const error = err as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      elapsedMs: performance.now() - started,
    };
  }
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fixtureDb(): { path: string; freshAt: number; staleAt: number } {
  const root = mkdtempSync(join(tmpdir(), 'qlb-export-'));
  const path = join(root, 'qlb.db');
  const now = Date.now();
  const freshAt = now - CACHE_EXPORT_STALE_AFTER_MS + 1_000;
  const staleAt = now - CACHE_EXPORT_STALE_AFTER_MS - 1_000;
  const store = openStore(path);
  try {
    store.upsertAccount('anthropic-a', 'anthropic', 'account-a');
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
  return { path, freshAt, staleAt };
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
      readings: Array<{ bucket: string; fetchedAt: number; stale: boolean; accountId: string; provider: string }>;
    };
    assert.equal(typeof body.exportedAt, 'number');
    assert.deepEqual(body.readings.map((reading) => ({
      bucket: reading.bucket,
      fetchedAt: reading.fetchedAt,
      stale: reading.stale,
      accountId: reading.accountId,
      provider: reading.provider,
    })), [
      { bucket: 'five-hour', fetchedAt: fixture.freshAt, stale: false, accountId: 'anthropic-a', provider: 'anthropic' },
      { bucket: 'seven-day', fetchedAt: fixture.staleAt, stale: true, accountId: 'anthropic-a', provider: 'anthropic' },
    ]);
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

  it('does not load provider adapters or credential modules', () => {
    const fixture = fixtureDb();
    const guard = join(mkdtempSync(join(tmpdir(), 'qlb-export-guard-')), 'guard.cjs');
    writeFileSync(guard, `
const Module = require('node:module');
const load = Module._load;
Module._load = function(request, parent, isMain) {
  if (/(^|\\/)(adapters|credentials|credential-backends|keychain)(\\/|$)/.test(request)) {
    throw new Error('forbidden module loaded: ' + request);
  }
  return load.call(this, request, parent, isMain);
};
`);
    const result = runExport(fixture.path, guard);
    assert.equal(result.status, 0, result.stderr);
  });

  it('returns a fixture export in under 200 ms', () => {
    const fixture = fixtureDb();
    const result = runExport(fixture.path);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.elapsedMs < 200, `export took ${result.elapsedMs.toFixed(1)} ms`);
  });
});
