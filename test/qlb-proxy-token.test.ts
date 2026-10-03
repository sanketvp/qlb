import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { processLstart } from '../src/proxy';

const ROOT = join(__dirname, '..', '..');
const HELPER = join(ROOT, 'harness', 'qlb-proxy-token');

describe('qlb-proxy-token helper', () => {
  it('prints token, then the rewritten token, and a 401 re-read succeeds', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-helper-'));
    mkdirSync(home, { recursive: true });
    const info = join(home, 'proxy.json');
    const lstart = processLstart(process.pid);
    writeFileSync(info, JSON.stringify({
      port: 47391,
      token: 'token-one',
      pid: process.pid,
      startedAt: Date.now(),
      startedBy: 'wrapper',
      lstart,
    }));
    const env = { ...process.env, QLB_HOME: home, QLB_PROXY_INFO_PATH: info };
    const first = spawnSync('/usr/bin/python3', [HELPER], { env, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.trim(), 'token-one');
    writeFileSync(info, JSON.stringify({
      port: 47391,
      token: 'token-two',
      pid: process.pid,
      startedAt: Date.now(),
      startedBy: 'wrapper',
      lstart,
    }));
    const second = spawnSync('/usr/bin/python3', [HELPER], { env, encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout.trim(), 'token-two');
    const after401 = spawnSync('/usr/bin/python3', [HELPER], { env, encoding: 'utf8' });
    assert.equal(after401.status, 0, after401.stderr);
    assert.equal(after401.stdout.trim(), 'token-two');
    const log = readFileSync(join(home, 'helper-invocations.log'), 'utf8').trim().split('\n');
    assert.ok(log.length >= 3);
  });
});
