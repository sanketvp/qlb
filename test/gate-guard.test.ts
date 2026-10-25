import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { appendEvidenceGap, runPiGate } from '../src/pi-gate';
import { piEvidenceGapCheck } from '../src/checks/pi-evidence-gap';
import { openStore } from '../src/store';

function fixtureDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'qlb-gate-guard-')), 'qlb.db');
  const store = openStore(path);
  store.close();
  return path;
}

function fakePiScript(): { root: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-gate-pi-'));
  const root = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const script = join(root, 'dist', 'bundle', 'host.js');
  mkdirSync(join(root, 'dist', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));
  writeFileSync(script, '#!/usr/bin/env node\n');
  chmodSync(script, 0o755);
  return { root: realpathSync(root), script: realpathSync(script) };
}

describe('qlb gate core (S30/S54)', () => {
  it('refuses a wrong parent before resolution with no credential output', async () => {
    const stdout: string[] = [];
    let read = false;
    const result = await runPiGate('xai', {
      dbPath: fixtureDb(),
      env: { QLB_PI_TOKEN_CALL: '1' },
      deliver: (value) => stdout.push(value),
      guard: () => false,
      admitted: () => ({ ok: true }),
      prerequisites: () => undefined,
      provider: { read: () => { read = true; return { token: 'fixture-secret', accountId: 'xai-default', source: 'fixture' }; } },
    });
    assert.equal(result, 3);
    assert.equal(read, false);
    assert.deepEqual(stdout, []);
  });

  it('counts value-free evidence-gap records for doctor without retrying a DB write', () => {
    const dbPath = fixtureDb();
    appendEvidenceGap(dbPath, 'xai');
    const check = piEvidenceGapCheck(dbPath);
    assert.equal(check.level, 'WARN');
    assert.equal(check.detail && (check.detail as { gaps: number }).gaps, 1);
  });

  it('resolves outside the evidence transaction and delivers JSON only through the supplied channel', async () => {
    const dbPath = fixtureDb();
    const { root, script } = fakePiScript();
    const trace: string[] = [];
    const output: string[] = [];
    const result = await runPiGate('xai', {
      dbPath,
      env: { QLB_PI_TOKEN_CALL: '1' },
      deliver: (value) => output.push(value),
      guard: (env) => env.QLB_PI_TOKEN_CALL === '1',
      admitted: () => ({ ok: true }),
      prerequisites: () => undefined,
      provider: {
        read: () => {
          trace.push('resolve');
          return { token: 'fixture-secret', accountId: 'xai-default', source: `fixture:${root}:${script}`, expiresAt: 123 };
        },
      },
      sqlTrace: (sql) => trace.push(sql),
    });
    assert.equal(result, 0);
    assert.ok(trace.indexOf('resolve') < trace.indexOf('BEGIN IMMEDIATE'), trace.join('\n'));
    assert.equal(trace.filter((entry) => entry === 'BEGIN IMMEDIATE').length, 1);
    assert.equal(output.length, 1);
    assert.deepEqual(JSON.parse(output[0]!), {
      token: 'fixture-secret', accountId: 'xai-default', source: `fixture:${root}:${script}`, expiresAt: 123,
    });
  });
});
