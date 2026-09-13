import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

function runAdapterScript(script: string, extraEnv: NodeJS.ProcessEnv = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    timeout: 20_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('adapter empty-cache probe attachment', () => {
  it('anthropic empty cache + rejected fetch stamps cached-after-failure with accurate detail', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-anth-probe-'));
    mkdirSync(join(root, 'migrate'), { recursive: true });
    const pool = join(root, 'pool.json');
    const db = join(root, 'qlb.db');
    writeFileSync(
      pool,
      JSON.stringify({
        accounts: [
          {
            id: 'acct-1',
            email: 'a@example.com',
            credentials: { access: 'tok', expires: Date.now() + 60_000 },
          },
        ],
      }),
    );
    const adapterJs = join(__dirname, '..', 'src', 'adapters', 'anthropic.js');
    const script = `
      process.env.QLB_ANTHROPIC_POOL_PATH = ${JSON.stringify(pool)};
      process.env.QLB_DB_PATH = ${JSON.stringify(db)};
      globalThis.fetch = async () => {
        const err = new Error('network down');
        err.name = 'TypeError';
        throw err;
      };
      const { anthropicAdapter } = require(${JSON.stringify(adapterJs)});
      anthropicAdapter.fetchSnapshots().then((snaps) => {
        process.stdout.write(JSON.stringify(snaps));
      }).catch((err) => {
        console.error(err);
        process.exit(1);
      });
    `;
    const result = runAdapterScript(script, {
      QLB_ANTHROPIC_POOL_PATH: pool,
      QLB_DB_PATH: db,
    });
    assert.equal(result.status, 0, result.stderr);
    const snaps = JSON.parse(result.stdout) as Array<{
      error?: string;
      probe?: { outcome: string; detail?: string };
      buckets: Record<string, unknown>;
    }>;
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0]?.probe?.outcome, 'cached-after-failure');
    assert.notEqual(snaps[0]?.probe?.detail, 'auth expired or invalid — needs re-login');
    assert.ok(snaps[0]?.error);
    assert.match(snaps[0]?.probe?.detail ?? snaps[0]?.error ?? '', /network|timeout|failed/i);
  });

  it('kimi empty cache + rejected fetch stamps cached-after-failure with accurate detail', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-kimi-probe-'));
    const keyFile = join(root, 'kimi.md');
    const db = join(root, 'qlb.db');
    writeFileSync(keyFile, 'sk-kimi-TESTKEY123');
    const adapterJs = join(__dirname, '..', 'src', 'adapters', 'kimi.js');
    const script = `
      process.env.QLB_KIMI_CREDENTIALS_FILE = ${JSON.stringify(keyFile)};
      process.env.QLB_DB_PATH = ${JSON.stringify(db)};
      globalThis.fetch = async () => {
        throw new Error('ECONNRESET');
      };
      const { kimiAdapter } = require(${JSON.stringify(adapterJs)});
      kimiAdapter.fetchSnapshots().then((snaps) => {
        process.stdout.write(JSON.stringify(snaps));
      }).catch((err) => {
        console.error(err);
        process.exit(1);
      });
    `;
    const result = runAdapterScript(script, {
      QLB_KIMI_CREDENTIALS_FILE: keyFile,
      QLB_DB_PATH: db,
    });
    assert.equal(result.status, 0, result.stderr);
    const snaps = JSON.parse(result.stdout) as Array<{
      error?: string;
      probe?: { outcome: string; detail?: string };
    }>;
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0]?.probe?.outcome, 'cached-after-failure');
    assert.match(snaps[0]?.probe?.detail ?? '', /ECONNRESET|request failed/);
    assert.ok(snaps[0]?.error);
  });
});
