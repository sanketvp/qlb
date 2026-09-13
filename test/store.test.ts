import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { openStore } from '../src/store';

const support = join(__dirname, '..', '..', 'test', 'support');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildV4Store } = require(join(support, 'v4-fixture.cjs')) as {
  buildV4Store: (path: string, rows?: Array<Record<string, unknown>>) => string;
};

function userVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | number | undefined;
    if (typeof row === 'number') return row;
    return row?.user_version ?? 0;
  } finally {
    db.close();
  }
}

function columns(path: string, table: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

describe('store decision columns', () => {
  it('v4 fixture gains strategy/provider columns, user_version stays 4, rows readable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-store-v4-'));
    const path = join(dir, 'qlb.db');
    buildV4Store(path, [
      {
        ts: 1000,
        requested_model: 'claude-sonnet-5',
        account_id: 'acc',
        mode: 'headroom',
        reason: 'ok',
        snapshot_json: JSON.stringify({ provider: 'anthropic' }),
      },
    ]);
    assert.equal(userVersion(path), 4);
    assert.ok(!columns(path, 'decisions').includes('strategy'));

    const store = openStore(path);
    try {
      assert.equal(userVersion(path), 4);
      const cols = columns(path, 'decisions');
      assert.ok(cols.includes('strategy'));
      assert.ok(cols.includes('provider'));
      const rows = store.listDecisions();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.mode, 'headroom');
      assert.equal(rows[0]?.strategy, null);
    } finally {
      store.close();
    }
  });

  it('ensureDecisionColumns idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-store-idemp-'));
    const path = join(dir, 'qlb.db');
    buildV4Store(path);
    const a = openStore(path);
    a.close();
    const b = openStore(path);
    try {
      assert.equal(userVersion(path), 4);
      const cols = columns(path, 'decisions');
      assert.equal(cols.filter((c) => c === 'strategy').length, 1);
      assert.equal(cols.filter((c) => c === 'provider').length, 1);
    } finally {
      b.close();
    }
  });

  it('v4 writer process holding a prepared insert keeps inserting after another process migrates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-store-xproc-'));
    const dbPath = join(dir, 'qlb.db');
    const ready = join(dir, 'ready');
    const go = join(dir, 'go');
    const fixture = join(support, 'v4-fixture.cjs');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
          const { writeFileSync, existsSync } = require('node:fs');
          const { DatabaseSync } = require('node:sqlite');
          const { buildV4Store } = require(${JSON.stringify(fixture)});
          buildV4Store(${JSON.stringify(dbPath)});
          const db = new DatabaseSync(${JSON.stringify(dbPath)});
          const stmt = db.prepare(
            'INSERT INTO decisions (ts, session, harness, requested_model, effort, served_model, account_id, mode, reason, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          );
          stmt.run(1, null, null, 'claude-sonnet-5', null, null, 'a', 'headroom', 'one', '{}');
          writeFileSync(${JSON.stringify(ready)}, '1');
          const start = Date.now();
          while (!existsSync(${JSON.stringify(go)}) && Date.now() - start < 10000) {}
          stmt.run(2, null, null, 'claude-sonnet-5', null, null, 'b', 'headroom', 'two', '{}');
          db.close();
        `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stderr: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    const waitUntil = async (file: string, ms: number) => {
      const start = Date.now();
      while (!existsSync(file) && Date.now() - start < ms) {
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await waitUntil(ready, 10_000);
    assert.ok(existsSync(ready), Buffer.concat(stderr).toString());
    const migrator = openStore(dbPath);
    writeFileSync(go, '1');
    const code: number = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (c) => resolve(c ?? 1));
    });
    assert.equal(code, 0, Buffer.concat(stderr).toString());
    try {
      assert.equal(migrator.listDecisions().length, 2);
    } finally {
      migrator.close();
    }
  });

  it('atomic rollback: fixture with pre-existing provider column → second ALTER fails, strategy column absent afterwards, DB intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-store-rollback-'));
    const path = join(dir, 'qlb.db');
    buildV4Store(path, [
      {
        ts: 42,
        requested_model: 'claude-sonnet-5',
        account_id: 'keep',
        mode: 'headroom',
        reason: 'keep-me',
        snapshot_json: '{}',
      },
    ]);
    const db = new DatabaseSync(path);
    db.exec('ALTER TABLE decisions ADD COLUMN provider TEXT');
    db.close();

    assert.throws(() => openStore(path));
    assert.equal(userVersion(path), 4);
    const cols = columns(path, 'decisions');
    assert.ok(!cols.includes('strategy'), `strategy should be absent, got ${cols.join(',')}`);
    assert.ok(cols.includes('provider'));
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      const row = check.prepare('SELECT account_id, reason FROM decisions').get() as {
        account_id: string;
        reason: string;
      };
      assert.equal(row.account_id, 'keep');
      assert.equal(row.reason, 'keep-me');
    } finally {
      check.close();
    }
  });
});
