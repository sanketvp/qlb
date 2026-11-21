import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import command from '../src/commands/codex-refresh';
import { defaultConfig } from '../src/config';
import type { CommandContext } from '../src/registry';

describe('qlb codex refresh command entry — CR0', () => {
  it('the production command keeps the store open until the locked consume finishes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-codex-refresh-cmd-'));
    const home = join(root, 'home');
    const qlbHome = join(root, 'qlb');
    mkdirSync(home, { recursive: true });
    mkdirSync(qlbHome, { recursive: true });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const config = { ...defaultConfig(home), dbPath: join(qlbHome, 'qlb.db') };
    const context: CommandContext = {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
      env: { QLB_TEST_MODE: '1', HOME: home, QLB_HOME: qlbHome },
      config, loadConfig: () => config, home,
      registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    };
    try {
      // No slot is stored, so the locked work reads the store (active slot, recovery fence)
      // and then finds the slot missing. Before CR0 the store was already closed by then.
      assert.equal(await command.execute!(['user:account', '--force'], context), 1);
      assert.deepEqual(stdout, ['user:account: slot-removed']);
      assert.deepEqual(stderr, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
