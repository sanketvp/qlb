import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { dispatchCommand } from '../src/app';
import lifecycleCommand from '../src/commands/lifecycle';
import { defaultConfig } from '../src/config';
import { doctorQlb, s64DoctorVerdict } from '../src/diagnostics';
import { LIFECYCLE_STATES } from '../src/checks/lifecycle-phase';
import { openStore } from '../src/store';
import type { CommandContext } from '../src/registry';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'qlb-claude-version-'));
  const config = defaultConfig(home);
  const store = openStore(config.dbPath);
  store.close();
  return { home, config };
}

function context(home: string): CommandContext & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  const config = defaultConfig(home);
  return {
    output,
    errors,
    stdout: (message) => output.push(message),
    stderr: (message) => errors.push(message),
    env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home },
    config,
    loadConfig: () => config,
    home,
    registerSecret: () => {},
    deliverSecret: (value) => output.push(value),
    knownSecrets: () => [],
  };
}

describe('claude:version-drift doctor check', () => {
  it('WARNs on drift with both redacted version values', async () => {
    const { config } = fixture();
    const store = openStore(config.dbPath);
    store.setConfig('sentinel.claudeCodeVersion', 'Claude Code 1.0.0');
    store.close();
    const report = await doctorQlb(config, {
      command: () => '', hostCommand: () => '', claudeVersionRunner: () => 'Claude Code 2.0.0\n',
    });
    assert.deepEqual(report.checks.find((row) => row.name === 'claude:version-drift'), {
      name: 'claude:version-drift', level: 'WARN',
      message: 'Claude Code version drift: recorded Claude Code 1.0.0; installed Claude Code 2.0.0',
    });
  });

  it('reports INFO when no sentinel has been recorded in every lifecycle phase', async () => {
    for (const state of LIFECYCLE_STATES) {
      const { config } = fixture();
      const db = new DatabaseSync(config.dbPath);
      try {
        db.prepare('INSERT INTO lifecycle (state, began_at) VALUES (?, ?)').run(state, 1);
      } finally { db.close(); }
      const report = await doctorQlb(config, { command: () => '', hostCommand: () => '' });
      assert.deepEqual(report.checks.find((row) => row.name === 'claude:version-drift'), {
        name: 'claude:version-drift', level: 'INFO', message: 'not recorded',
      }, state);
      assert.deepEqual(s64DoctorVerdict({
        checks: [{ name: 'claude:version-drift', level: 'INFO', message: 'not recorded' }], providers: [],
      }), { overall: 'PASS', autoAgent: 'FAIL' }, state);
    }
  });

  it('WARNs unknown when Claude Code is unavailable', async () => {
    const { config } = fixture();
    const store = openStore(config.dbPath);
    store.setConfig('sentinel.claudeCodeVersion', 'Claude Code 1.0.0');
    store.close();
    const report = await doctorQlb(config, {
      command: () => '', hostCommand: () => '', claudeVersionRunner: () => { throw new Error('missing'); },
    });
    assert.deepEqual(report.checks.find((row) => row.name === 'claude:version-drift'), {
      name: 'claude:version-drift', level: 'WARN', message: 'Claude Code version unknown',
    });
  });
});

describe('qlb lifecycle sentinels record', () => {
  it('records the Claude Code version through the injected seam', async () => {
    const { home, config } = fixture();
    const ctx = context(home);
    let calls = 0;
    ctx.claudeVersionRunner = () => { calls += 1; return 'Claude Code 1.2.3\n'; };
    assert.equal(await dispatchCommand(['node', 'qlb', 'lifecycle', 'sentinels', 'record', '--json'], [lifecycleCommand], ctx), 0);
    assert.equal(calls, 1);
    const store = openStore(config.dbPath);
    try {
      assert.equal(store.getConfig('sentinel.claudeCodeVersion'), 'Claude Code 1.2.3');
      assert.match(store.getConfig('sentinel.recordedAt') ?? '', /^\d+$/);
    } finally { store.close(); }
    assert.equal(JSON.parse(ctx.output[0]!).claudeCodeVersion, 'Claude Code 1.2.3');
  });

  it('refuses in test mode without an execution seam', async () => {
    const { home } = fixture();
    const ctx = context(home);
    assert.equal(await dispatchCommand(['node', 'qlb', 'lifecycle', 'sentinels', 'record'], [lifecycleCommand], ctx), 3);
    assert.deepEqual(ctx.errors, ['lifecycle sentinel record refused: exec-seam-required']);
  });
});
