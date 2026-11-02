import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultConfig } from '../src/config';
import { createCutoverCommand } from '../src/commands/cutover';
import type { CswapAgent } from '../src/cswap-agent';
import type { CommandContext } from '../src/registry';
import { openStore } from '../src/store';

function fixture(): { root: string; dbPath: string; context: CommandContext; output: string[]; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'qlb-cutover-command-'));
  const dbPath = join(root, 'qlb.db');
  const store = openStore(dbPath);
  store.close();
  const config = { ...defaultConfig(root), dbPath };
  const output: string[] = [];
  return {
    root,
    dbPath,
    output,
    context: {
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      env: { QLB_TEST_MODE: '1', QLB_HOME: root },
      config,
      loadConfig: () => config,
      home: root,
      registerSecret: () => {},
      deliverSecret: () => {},
      knownSecrets: () => [],
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('begin calls the injected agent in S57 order', async () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    const agent: CswapAgent = {
      bootout: () => { calls.push('bootout'); return { ok: true }; },
      disable: () => { calls.push('disable'); return { ok: true }; },
      movePlist: () => { calls.push('movePlist'); return { ok: true }; },
      drain: () => { calls.push('drain'); return { ok: true }; },
      restorePlist: () => { calls.push('restorePlist'); return { ok: true }; },
    };
    let factoryCalls = 0;
    const command = createCutoverCommand({
      makeAgent: (ctx) => {
        factoryCalls += 1;
        assert.equal(ctx, f.context);
        return agent;
      },
    });

    assert.equal(await command.execute!(['begin', '--json'], f.context), 0);
    assert.equal(factoryCalls, 1);
    assert.deepEqual(calls, ['bootout', 'disable', 'movePlist', 'drain']);
    assert.deepEqual(JSON.parse(f.output[0]!), { ok: true, state: 'cutting-over' });
  } finally {
    f.cleanup();
  }
});

test('test mode without an injected agent never reaches launchctl', async () => {
  const f = fixture();
  try {
    const command = createCutoverCommand();

    assert.equal(await command.execute!(['begin', '--json'], f.context), 3);
    assert.deepEqual(JSON.parse(f.output[0]!), {
      ok: false,
      code: 'cswap-restore-failed',
      state: 'cutting-over',
    });
  } finally {
    f.cleanup();
  }
});
