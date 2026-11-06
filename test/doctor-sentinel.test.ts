import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/config';
import { doctorQlb } from '../src/diagnostics';
import { LIFECYCLE_STATES } from '../src/checks/lifecycle-phase';
import { openStore } from '../src/store';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-sentinel-'));
  const config = defaultConfig(home);
  const store = openStore(config.dbPath);
  store.close();
  return { config };
}

describe('claude:version-drift doctor check', () => {
  it('passes when the installed version matches the recorded sentinel', async () => {
    const { config } = fixture();
    const store = openStore(config.dbPath);
    store.setConfig('sentinel.claudeCodeVersion', 'Claude Code 1.0.0');
    store.close();
    const report = await doctorQlb(config, {
      command: () => '', hostCommand: () => '', hostPlatform: 'linux', claudeVersionRunner: () => 'Claude Code 1.0.0\n',
    });
    assert.deepEqual(report.checks.find((row) => row.name === 'claude:version-drift'), {
      name: 'claude:version-drift', level: 'PASS',
      message: 'Claude Code version matches recorded value: Claude Code 1.0.0',
    });
    assert.equal(report.s64.overall, 'PASS');
  });

  it('claude:version-drift warns when the installed version differs from the recorded sentinel', async () => {
    const { config } = fixture();
    const store = openStore(config.dbPath);
    store.setConfig('sentinel.claudeCodeVersion', 'Claude Code 1.0.0');
    store.close();
    const report = await doctorQlb(config, {
      command: () => '', hostCommand: () => '', hostPlatform: 'linux', claudeVersionRunner: () => 'Claude Code 2.0.0\n',
    });
    assert.deepEqual(report.checks.find((row) => row.name === 'claude:version-drift'), {
      name: 'claude:version-drift', level: 'WARN',
      message: 'Claude Code version drift: recorded Claude Code 1.0.0; installed Claude Code 2.0.0',
    });
    assert.equal(report.s64.overall, 'PASS');
  });

  it('claude:version-drift is INFO when nothing is recorded', async () => {
    for (const state of LIFECYCLE_STATES) {
      const { config } = fixture();
      const db = new DatabaseSync(config.dbPath);
      try {
        db.prepare('INSERT INTO lifecycle (state, began_at) VALUES (?, ?)').run(state, 1);
      } finally { db.close(); }
      const report = await doctorQlb(config, { command: () => '', hostCommand: () => '', hostPlatform: 'linux' });
      assert.deepEqual(report.checks.find((row) => row.name === 'claude:version-drift'), {
        name: 'claude:version-drift', level: 'INFO', message: 'not recorded',
      }, state);
    }
  });

  it('claude:version-drift warns when claude cannot be run', async () => {
    for (const claudeVersionRunner of [
      () => { throw new Error('missing'); },
      () => '  \n',
    ]) {
      const { config } = fixture();
      const store = openStore(config.dbPath);
      store.setConfig('sentinel.claudeCodeVersion', 'Claude Code 1.0.0');
      store.close();
      const report = await doctorQlb(config, {
        command: () => '', hostCommand: () => '', hostPlatform: 'linux', claudeVersionRunner,
      });
      assert.deepEqual(report.checks.find((row) => row.name === 'claude:version-drift'), {
        name: 'claude:version-drift', level: 'WARN', message: 'Claude Code version unknown',
      });
      assert.equal(report.s64.overall, 'PASS');
    }
  });
});
