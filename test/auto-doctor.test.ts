import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { autoAgentCheck } from '../src/checks/auto-agent';
import { cswapAgentCheck } from '../src/checks/cswap-agent';
import { cswapProcessesCheck } from '../src/checks/cswap-processes';
import { consumeMarkerPathFor } from '../src/cswap-consume';
import { defaultConfig } from '../src/config';
import { inspectCswapAgent } from '../src/cswap-agent';
import { doctorQlb } from '../src/diagnostics';
import { openStore } from '../src/store';

const NOW = 1_800_000_000_000;
const CUTOVER = { available: true, phase: 'cutover' } as const;
const PRE_CUTOVER = { available: true, phase: 'pre-cutover' } as const;

function cutoverFixture() {
  const home = mkdtempSync(join(tmpdir(), 'qlb-auto-doctor-'));
  const config = defaultConfig(home);
  const store = openStore(config.dbPath);
  store.setConfig('auto.heartbeatAt', String(NOW - 5 * 60 * 1_000));
  store.setConfig('cutover.piDeferredAt', String(NOW));
  store.upsertMigration('cswap-anthropic', 'CONSUMED', '{}');
  store.close();
  const db = new DatabaseSync(config.dbPath);
  try {
    db.prepare("INSERT INTO lifecycle (state, began_at) VALUES ('cutover', ?)").run(NOW);
  } finally {
    db.close();
  }
  writeFileSync(consumeMarkerPathFor(config.dbPath), '{}\n');
  return config;
}

describe('auto doctor (G14)', () => {
  it('a cutover fixture with deferred Pi has no FAIL row', async () => {
    const config = cutoverFixture();
    const report = await doctorQlb(config, {
      command: () => '',
      hostCommand: () => '',
      now: () => NOW,
      cswapAgentStatus: () => 'not-loaded',
      cswapProcesses: () => [],
      piProcessList: () => '  1 Tue Oct 28 10:00:00 2026 /usr/bin/true\n',
    });
    const h2Rows = report.checks.filter((row) => ['auto:agent', 'cswap:agent', 'cswap:processes'].includes(row.name));
    assert.deepEqual(h2Rows.map(({ name, level }) => ({ name, level })), [
      { name: 'auto:agent', level: 'PASS' },
      { name: 'cswap:agent', level: 'PASS' },
      { name: 'cswap:processes', level: 'PASS' },
    ]);
    assert.equal(h2Rows.some((row) => row.level === 'FAIL'), false);
  });

  it('a stale heartbeat fails auto:agent', () => {
    const config = cutoverFixture();
    const result = autoAgentCheck(config.dbPath, CUTOVER, NOW + 1);
    assert.equal(result.level, 'FAIL');
    assert.match(result.message, /older than 5 minutes/);
  });

  it('pre-cutover is N/A', () => {
    let inspected = false;
    const rows = [
      autoAgentCheck(join(tmpdir(), 'missing-auto-doctor.db'), PRE_CUTOVER, NOW),
      cswapAgentCheck(PRE_CUTOVER, { status: () => { inspected = true; return 'loaded'; } }),
      cswapProcessesCheck(PRE_CUTOVER, { list: () => { inspected = true; return [{ pid: 1 }]; }, env: { QLB_TEST_MODE: '1' } }),
    ];
    assert.deepEqual(rows.map((row) => row.level), ['N/A', 'N/A', 'N/A']);
    assert.equal(inspected, false);
  });

  it('a loaded C-swap agent or running process fails its H2 row', () => {
    assert.equal(cswapAgentCheck(CUTOVER, { status: () => 'loaded' }).level, 'FAIL');
    assert.equal(cswapProcessesCheck(CUTOVER, {
      list: () => [{ pid: 73 }], env: { QLB_TEST_MODE: '1' },
    }).level, 'FAIL');
  });

  it('inspects the C-swap agent through an injected launchctl seam', () => {
    assert.equal(inspectCswapAgent({ exec: () => '', uid: () => 501 }), 'loaded');
    assert.equal(inspectCswapAgent({
      exec: () => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); }, uid: () => 501,
    }), 'not-loaded');
    assert.equal(inspectCswapAgent({
      exec: () => { throw new Error('permission denied'); }, uid: () => 501,
    }), 'unknown');
  });
});
