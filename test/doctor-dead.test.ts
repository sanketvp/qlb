import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/config';
import { doctorQlb } from '../src/diagnostics';
import { appendHealthLog, listHealthLog } from '../src/health-log';
import { listReloginEvents, recordRelogin, reloginsInWindow } from '../src/relogin';
import { autoBreakerCheck } from '../src/checks/auto-breaker';
import { claudeOauthClientCheck } from '../src/checks/claude-oauth-client';
import { claudeSlotsCheck } from '../src/checks/claude-slots';
import { codexSlotsCheck } from '../src/checks/codex-slots';
import { lifecyclePhaseCheck } from '../src/checks/lifecycle-phase';
import { relogin7dCheck } from '../src/checks/relogin-7d';
import { openStore } from '../src/store';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-dead-'));
  const dbPath = join(home, 'qlb.db');
  const store = openStore(dbPath);
  store.close();
  return dbPath;
}

function write(dbPath: string, sql: string, ...args: unknown[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(sql).run(...(args as never[]));
  } finally {
    db.close();
  }
}

describe('A7 doctor health primitives', () => {
  it('reports dead Claude and Codex slots without treating the other provider as dead', () => {
    const dbPath = fixture();
    // These rows intentionally contain no credentials.
    write(dbPath, "INSERT INTO claude_slots (account_id, config_json, dead, dead_reason, added_at) VALUES (?, '{}', 1, 'invalid_grant', ?)", 'claude-dead', Date.now());
    write(dbPath, 'INSERT INTO codex_slots (account_id, chatgpt_user_id, chatgpt_account_id, dead, dead_reason, added_at) VALUES (?, ?, ?, 0, NULL, ?)', 'codex-live', 'user', 'account', Date.now());

    const claude = claudeSlotsCheck(dbPath, 'cutover');
    const codex = codexSlotsCheck(dbPath, 'cutover');
    assert.equal(claude.level, 'FAIL');
    assert.deepEqual(claude.detail, [{ accountId: 'claude-dead', reason: 'invalid_grant' }]);
    assert.equal(codex.level, 'PASS');
  });

  it('treats dead-slot and relogin checks as not applicable before cutover', () => {
    const dbPath = fixture();
    write(dbPath, "INSERT INTO claude_slots (account_id, config_json, dead, added_at) VALUES (?, '{}', 1, ?)", 'claude-dead', Date.now());

    assert.equal(claudeSlotsCheck(dbPath, 'pre-cutover').level, 'N/A');
    assert.equal(relogin7dCheck(dbPath, 'pre-cutover').level, 'N/A');
  });

  it('converts missing database failures into FAIL rows for every health primitive', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'qlb-doctor-missing-')), 'missing.db');
    assert.doesNotThrow(() => {
      const results = [
        claudeSlotsCheck(dbPath, 'cutover'),
        codexSlotsCheck(dbPath, 'cutover'),
        claudeOauthClientCheck(dbPath),
        autoBreakerCheck(dbPath, 'anthropic'),
        lifecyclePhaseCheck(dbPath),
        relogin7dCheck(dbPath, 'cutover'),
      ];
      assert.deepEqual(results.map((result) => result.level), ['FAIL', 'FAIL', 'FAIL', 'FAIL', 'WARN', 'FAIL']);
    });
  });

  it('converts absent v5 tables and invalid relogin windows into FAIL rows', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'qlb-doctor-old-schema-')), 'qlb.db');
    const db = new DatabaseSync(dbPath);
    db.close();

    assert.doesNotThrow(() => assert.equal(claudeSlotsCheck(dbPath, 'cutover').level, 'FAIL'));
    assert.doesNotThrow(() => assert.equal(lifecyclePhaseCheck(dbPath).level, 'WARN'));
    assert.doesNotThrow(() => assert.deepEqual(relogin7dCheck(dbPath, 'cutover', Number.NaN), {
      name: 'relogin:7d',
      level: 'FAIL',
      message: 'check failed: invalid relogin window',
    }));
  });

  it('runs every A7 check in doctor rather than synthesizing a host placeholder', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-a7-runtime-'));
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    store.setConfig('auto.anthropic.suspendedUntil', String(Date.now() + 60_000));
    recordRelogin(store, { ts: Date.now(), provider: 'anthropic', accountId: 'claude-dead', kind: 'healed' });
    store.close();
    write(config.dbPath, "INSERT INTO lifecycle (state, began_at) VALUES ('cutover', ?)", Date.now());
    write(config.dbPath, "INSERT INTO claude_slots (account_id, config_json, dead, dead_reason, added_at) VALUES (?, '{}', 1, 'invalid_grant', ?)", 'claude-dead', Date.now());

    const report = await doctorQlb(config, { command: () => '', hostCommand: () => '' });
    const a7Rows = ['auto:anthropic:breaker', 'claude:oauth-client', 'claude:slots', 'codex:slots', 'lifecycle:phase', 'relogin:7d']
      .map((name) => report.checks.find((check) => check.name === name));
    assert.ok(a7Rows.every((check) => check != null));
    assert.ok(a7Rows.every((check) => check?.message !== 'not applicable on this host'));
    assert.equal(report.checks.find((check) => check.name === 'auto:anthropic:breaker')?.level, 'FAIL');
    assert.equal(report.checks.find((check) => check.name === 'claude:slots')?.level, 'FAIL');
    assert.equal(report.checks.find((check) => check.name === 'relogin:7d')?.level, 'FAIL');

    const healthyHome = mkdtempSync(join(tmpdir(), 'qlb-doctor-a7-healthy-'));
    const healthyConfig = defaultConfig(healthyHome);
    const healthyStore = openStore(healthyConfig.dbPath);
    healthyStore.close();
    write(healthyConfig.dbPath, "INSERT INTO lifecycle (state, began_at) VALUES ('cutover', ?)", Date.now());
    const healthy = await doctorQlb(healthyConfig, { command: () => '', hostCommand: () => '' });
    for (const name of ['auto:anthropic:breaker', 'claude:oauth-client', 'claude:slots', 'codex:slots', 'lifecycle:phase', 'relogin:7d']) {
      const check = healthy.checks.find((row) => row.name === name);
      assert.equal(check?.level, 'PASS');
      assert.notEqual(check?.message, 'not applicable on this host');
    }
  });

  it('reports all A7 checks without PASS when the store is missing or pre-v5', async () => {
    for (const makeConfig of [
      () => defaultConfig(mkdtempSync(join(tmpdir(), 'qlb-doctor-a7-missing-'))),
      () => {
        const config = defaultConfig(mkdtempSync(join(tmpdir(), 'qlb-doctor-a7-old-')));
        mkdirSync(dirname(config.dbPath), { recursive: true });
        const db = new DatabaseSync(config.dbPath);
        db.close();
        return config;
      },
    ]) {
      const report = await doctorQlb(makeConfig(), { command: () => '', hostCommand: () => '' });
      for (const name of ['auto:anthropic:breaker', 'claude:oauth-client', 'claude:slots', 'codex:slots', 'lifecycle:phase', 'relogin:7d']) {
        const check = report.checks.find((row) => row.name === name);
        assert.ok(check, `${name} missing from report`);
        assert.notEqual(check.level, 'PASS', `${name} must not pass without a v5 store`);
      }
    }
  });

  it('waits for a brief writer lock before appending the health snapshot', { timeout: 10_000 }, async () => {
    const dbPath = fixture();
    const holder = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('BEGIN IMMEDIATE');
      process.stdout.write('ready\\n');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 150);
    `, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      holder.stdout.once('data', () => resolve());
      holder.once('error', reject);
      holder.once('exit', (code) => reject(new Error(`lock holder exited early: ${code}`)));
    });
    appendHealthLog(dbPath, { phase: 'cutover', overall: 'PASS', failing: [], deadSlots: [] });
    await new Promise<void>((resolve, reject) => holder.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`lock holder exit: ${code}`))));
    assert.equal(listHealthLog(dbPath).length, 1);
  });

  it('records, windows, and redacts relogin events', () => {
    const dbPath = fixture();
    const store = openStore(dbPath);
    recordRelogin(store, {
      ts: 1_000,
      provider: 'anthropic',
      accountId: 'claude-dead',
      kind: 'dead',
      detail: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
    });
    recordRelogin(store, { ts: 2_000, provider: 'anthropic', accountId: 'claude-dead', kind: 'healed' });
    store.close();

    assert.equal(listReloginEvents(dbPath).length, 2);
    assert.deepEqual(reloginsInWindow(dbPath, { start: 1_500, end: 2_500 }).map((event) => event.kind), ['healed']);
    const active = relogin7dCheck(dbPath, 'cutover', 1_500, 1_000);
    assert.equal(active.level, 'FAIL');
    assert.doesNotMatch(JSON.stringify(listReloginEvents(dbPath)), /abcdefghijklmnopqrstuvwxyz123456/);
  });

  it('treats a healed relogin inside the window as unhealthy', () => {
    const dbPath = fixture();
    const store = openStore(dbPath);
    recordRelogin(store, { ts: 1_000, provider: 'anthropic', accountId: 'claude-dead', kind: 'dead' });
    recordRelogin(store, { ts: 3_000, provider: 'anthropic', accountId: 'claude-dead', kind: 'healed' });
    store.close();

    const result = relogin7dCheck(dbPath, 'cutover', 3_500, 1_000);
    assert.equal(result.level, 'FAIL');
    assert.deepEqual(result.detail, [{ id: 2, ts: 3_000, provider: 'anthropic', accountId: 'claude-dead', kind: 'healed' }]);
  });

  it('reports an open breaker and systemic OAuth client failure without dead-slot verdicts', () => {
    const dbPath = fixture();
    const now = 10_000;
    const store = openStore(dbPath);
    store.setConfig('auto.anthropic.suspendedUntil', String(now + 1));
    store.close();
    write(dbPath, 'INSERT INTO usage_polls (provider, account_id, last_status) VALUES (?, ?, ?)', 'anthropic', 'claude-live', 'invalid_client');

    assert.equal(autoBreakerCheck(dbPath, 'anthropic', now).level, 'FAIL');
    assert.equal(claudeOauthClientCheck(dbPath).level, 'WARN');
    assert.equal(claudeSlotsCheck(dbPath, 'cutover').level, 'PASS');
  });

  it('reads the open lifecycle phase and appends a redacted authoritative health snapshot', () => {
    const dbPath = fixture();
    write(dbPath, "INSERT INTO lifecycle (state, began_at) VALUES ('cutover', ?)", 1_000);

    assert.equal(lifecyclePhaseCheck(dbPath, 'cutover').level, 'PASS');
    assert.equal(lifecyclePhaseCheck(dbPath, 'retired').level, 'FAIL');
    appendHealthLog(dbPath, {
      ts: 2_000,
      phase: 'cutover',
      overall: 'FAIL',
      failing: [{ name: 'claude:slots', message: 'Bearer abcdefghijklmnopqrstuvwxyz123456' }],
      deadSlots: [{ provider: 'anthropic', accountId: 'claude-dead', lineagePrefix: 'abcd1234' }],
      releaseSha: 'fixture',
    });
    const [row] = listHealthLog(dbPath);
    assert.equal(row?.overall, 'FAIL');
    assert.match(row?.failingJson ?? '', /\[redacted\]/);
    assert.deepEqual(JSON.parse(row?.deadSlotsJson ?? '[]'), [{ provider: 'anthropic', accountId: 'claude-dead', lineagePrefix: 'abcd1234' }]);
  });
});
