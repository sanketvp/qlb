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
  it('v4 fixture migrates to v5, gains strategy/provider columns, rows readable', () => {
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
      assert.equal(userVersion(path), 5);
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
      assert.equal(userVersion(path), 5);
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

  it('v4 fixture with a pre-existing provider column completes the additive v5 migration', () => {
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

    const migrated = openStore(path);
    migrated.close();
    assert.equal(userVersion(path), 5);
    const cols = columns(path, 'decisions');
    assert.ok(cols.includes('strategy'));
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

describe('Codex observations', () => {
  function openObservationStore() {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-store-observations-'));
    return openStore(join(dir, 'qlb.db'));
  }

  function privateDb(store: ReturnType<typeof openStore>): DatabaseSync {
    return (store as unknown as { db: DatabaseSync }).db;
  }

  function observationCount(store: ReturnType<typeof openStore>): number {
    return Number((privateDb(store).prepare('SELECT COUNT(*) AS count FROM codex_live_observations').get() as { count: number }).count);
  }

  function reloginCount(store: ReturnType<typeof openStore>): number {
    return Number((privateDb(store).prepare('SELECT COUNT(*) AS count FROM relogin_events').get() as { count: number }).count);
  }

  it('an unchanged read updates lastObservedAt and appends nothing', () => {
    const store = openObservationStore();
    try {
      store.recordCodexObservation({ identity: 'user:account', lineageFp: 'lineage-a', by: 'qlb-switch', now: 100 });
      const result = store.recordCodexObservation({ identity: 'user:account', lineageFp: 'lineage-a', by: 'qlb-watch', now: 200 });

      assert.deepEqual(result, { appended: false, wipedEvent: false });
      assert.equal(store.getConfig('codex.lastObservedAt'), '200');
      assert.equal(observationCount(store), 1);
      assert.equal(reloginCount(store), 0);
    } finally {
      store.close();
    }
  });

  it('a changed lineage appends one row', () => {
    const store = openObservationStore();
    try {
      store.recordCodexObservation({ identity: 'user:account', lineageFp: 'lineage-a', by: 'qlb-switch', now: 100 });
      const result = store.recordCodexObservation({ identity: 'user:account', lineageFp: 'lineage-b', by: 'qlb-watch', now: 200 });

      assert.deepEqual(result, { appended: true, wipedEvent: false });
      assert.equal(observationCount(store), 2);
      assert.deepEqual(
        { ...(privateDb(store).prepare('SELECT ts, identity, lineage_fp, by FROM codex_live_observations ORDER BY ts DESC, id DESC LIMIT 1').get() as object) },
        { ts: 200, identity: 'user:account', lineage_fp: 'lineage-b', by: 'qlb-watch' },
      );
    } finally {
      store.close();
    }
  });

  it('a wipe appends one observation and one wiped event atomically', () => {
    const store = openObservationStore();
    try {
      store.recordCodexObservation({ identity: 'user:account', lineageFp: 'lineage-a', by: 'qlb-switch', now: 100 });
      const result = store.recordCodexObservation({ identity: null, lineageFp: null, by: 'qlb-watch', now: 200 });

      assert.deepEqual(result, { appended: true, wipedEvent: true });
      assert.equal(observationCount(store), 2);
      assert.deepEqual(
        { ...(privateDb(store).prepare('SELECT ts, provider, account_id, kind, detail, evidence, user_denied_at FROM relogin_events').get() as object) },
        { ts: 200, provider: 'openai-codex', account_id: null, kind: 'wiped', detail: 'wiped', evidence: 'wiped', user_denied_at: null },
      );
    } finally {
      store.close();
    }
  });

  it('a repeated wipe writes neither', () => {
    const store = openObservationStore();
    try {
      store.recordCodexObservation({ identity: null, lineageFp: null, by: 'qlb-switch', now: 100 });
      const result = store.recordCodexObservation({ identity: null, lineageFp: null, by: 'qlb-reconcile', now: 200 });

      assert.deepEqual(result, { appended: false, wipedEvent: false });
      assert.equal(store.getConfig('codex.lastObservedAt'), '200');
      assert.equal(observationCount(store), 1);
      assert.equal(reloginCount(store), 1);
    } finally {
      store.close();
    }
  });

  it('a failure inside the transaction writes neither row', () => {
    const store = openObservationStore();
    try {
      store.recordCodexObservation({ identity: 'user:account', lineageFp: 'lineage-a', by: 'qlb-switch', now: 100 });
      privateDb(store).exec(`CREATE TEMP TRIGGER fail_wiped_event BEFORE INSERT ON relogin_events
        BEGIN SELECT RAISE(ABORT, 'x'); END`);

      assert.throws(
        () => store.recordCodexObservation({ identity: null, lineageFp: null, by: 'qlb-watch', now: 200 }),
        /x/,
      );
      assert.equal(store.getConfig('codex.lastObservedAt'), '100');
      assert.equal(observationCount(store), 1);
      assert.equal(reloginCount(store), 0);
    } finally {
      store.close();
    }
  });
});

describe('Codex switch commit primitive', () => {
  function openCommitStore() {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-store-commit-codex-switch-'));
    return openStore(join(dir, 'qlb.db'));
  }

  function commitInput(overrides: Partial<Parameters<ReturnType<typeof openStore>['commitCodexSwitch']>[0]> = {}) {
    return {
      now: 1_000,
      accountId: 'to:account',
      setBy: 'auto' as const,
      fromAccount: 'from:account',
      toAccount: 'to:account',
      trigger: 'proactive',
      outcome: 'ok',
      attempt: 'attempt-1',
      via: 'switch' as const,
      openSessionsJson: '[{"pid":44}]',
      publishedAt: 900,
      committedAt: 1_000,
      detail: 'verified',
      outgoing: 'from:account',
      target: 'to:account',
      observation: { identity: 'to:account', lineageFp: 'lineage-to' },
      decision: { leftHeadroom: 23, leftRecoveryAt: 2_000, leftTrigger: 'headroom' },
      ...overrides,
    };
  }

  function commitDb(store: ReturnType<typeof openStore>): DatabaseSync {
    return (store as unknown as { db: DatabaseSync }).db;
  }

  function tableCount(store: ReturnType<typeof openStore>, table: string): number {
    return Number((commitDb(store).prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  }

  it('commitCodexSwitch writes every step-5 effect in one transaction', () => {
    const store = openCommitStore();
    try {
      const id = store.commitCodexSwitch(commitInput());
      assert.equal(id, 1);
      assert.deepEqual(store.getActiveLogin('openai-codex'), {
        provider: 'openai-codex', accountId: 'to:account', since: 1_000, setBy: 'auto',
      });
      for (const [key, value] of Object.entries({
        'cooldown.openai-codex': '301000',
        'auto.openai-codex.lastSwitchFrom': 'from:account',
        'auto.openai-codex.lastSwitchTo': 'to:account',
        'auto.openai-codex.leftHeadroom': '23',
        'auto.openai-codex.leftRecoveryAt': '2000',
        'auto.openai-codex.leftTrigger': 'headroom',
        'codex.lastObservedAt': '1000',
      })) assert.equal(store.getConfig(key), value, key);
      assert.deepEqual(
        { ...(commitDb(store).prepare('SELECT provider, from_account, to_account, trigger, outcome, steps_json, open_sessions_json, published_at, committed_at, detail FROM switch_log').get() as object) },
        {
          provider: 'openai-codex', from_account: 'from:account', to_account: 'to:account', trigger: 'proactive', outcome: 'ok',
          steps_json: '{"attempt":"attempt-1","via":"switch"}', open_sessions_json: '[{"pid":44}]',
          published_at: 900, committed_at: 1_000, detail: 'verified',
        },
      );
      assert.deepEqual(
        { ...(commitDb(store).prepare('SELECT identity, lineage_fp, by, ts FROM codex_live_observations').get() as object) },
        { identity: 'to:account', lineage_fp: 'lineage-to', by: 'qlb-switch', ts: 1_000 },
      );
      assert.deepEqual(
        { ...(commitDb(store).prepare('SELECT switch_id, provider, outgoing, target, next_at, until FROM codex_watch').get() as object) },
        { switch_id: id, provider: 'openai-codex', outgoing: 'from:account', target: 'to:account', next_at: 121_000, until: 301_000 },
      );
    } finally {
      store.close();
    }
  });

  it('ok writes auto.openai-codex.lastSwitchFrom and lastSwitchTo and a manual switch deletes lastSwitchTo', () => {
    const store = openCommitStore();
    try {
      store.commitCodexSwitch(commitInput());
      assert.equal(store.getConfig('auto.openai-codex.lastSwitchFrom'), 'from:account');
      assert.equal(store.getConfig('auto.openai-codex.lastSwitchTo'), 'to:account');
      store.commitCodexSwitch(commitInput({
        now: 2_000, attempt: 'attempt-2', trigger: 'manual', setBy: 'manual',
        fromAccount: 'to:account', toAccount: 'from:account', outgoing: 'to:account', target: 'from:account',
      }));
      assert.equal(store.getConfig('auto.openai-codex.lastSwitchFrom'), 'to:account');
      assert.equal(store.getConfig('auto.openai-codex.lastSwitchTo'), null);
    } finally {
      store.close();
    }
  });

  it('null S45 values delete their keys', () => {
    const store = openCommitStore();
    try {
      for (const key of [
        'auto.openai-codex.lastSwitchTo',
        'auto.openai-codex.leftHeadroom',
        'auto.openai-codex.leftRecoveryAt',
        'auto.openai-codex.leftTrigger',
      ]) store.setConfig(key, 'stale');
      store.commitCodexSwitch(commitInput({
        trigger: 'manual', setBy: 'manual',
        decision: { leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null },
      }));
      for (const key of [
        'auto.openai-codex.lastSwitchTo',
        'auto.openai-codex.leftHeadroom',
        'auto.openai-codex.leftRecoveryAt',
        'auto.openai-codex.leftTrigger',
      ]) assert.equal(store.getConfig(key), null, key);
    } finally {
      store.close();
    }
  });

  it('a failure in any statement writes none of them', () => {
    const failures: Array<[string, (db: DatabaseSync) => void]> = [
      ['active login', (db) => db.exec("CREATE TEMP TRIGGER fail_active BEFORE INSERT ON active_login BEGIN SELECT RAISE(ABORT, 'active'); END")],
      ['cooldown', (db) => db.exec("CREATE TEMP TRIGGER fail_cooldown BEFORE INSERT ON config WHEN NEW.key = 'cooldown.openai-codex' BEGIN SELECT RAISE(ABORT, 'cooldown'); END")],
      ['last switch from', (db) => db.exec("CREATE TEMP TRIGGER fail_from BEFORE INSERT ON config WHEN NEW.key = 'auto.openai-codex.lastSwitchFrom' BEGIN SELECT RAISE(ABORT, 'from'); END")],
      ['last switch to', (db) => db.exec("CREATE TEMP TRIGGER fail_to BEFORE INSERT ON config WHEN NEW.key = 'auto.openai-codex.lastSwitchTo' BEGIN SELECT RAISE(ABORT, 'to'); END")],
      ['left headroom', (db) => db.exec("CREATE TEMP TRIGGER fail_headroom BEFORE INSERT ON config WHEN NEW.key = 'auto.openai-codex.leftHeadroom' BEGIN SELECT RAISE(ABORT, 'headroom'); END")],
      ['left recovery', (db) => db.exec("CREATE TEMP TRIGGER fail_recovery BEFORE INSERT ON config WHEN NEW.key = 'auto.openai-codex.leftRecoveryAt' BEGIN SELECT RAISE(ABORT, 'recovery'); END")],
      ['left trigger', (db) => db.exec("CREATE TEMP TRIGGER fail_trigger BEFORE INSERT ON config WHEN NEW.key = 'auto.openai-codex.leftTrigger' BEGIN SELECT RAISE(ABORT, 'trigger'); END")],
      ['switch row', (db) => db.exec("CREATE TEMP TRIGGER fail_switch BEFORE INSERT ON switch_log BEGIN SELECT RAISE(ABORT, 'switch'); END")],
      ['observation timestamp', (db) => db.exec("CREATE TEMP TRIGGER fail_observed BEFORE INSERT ON config WHEN NEW.key = 'codex.lastObservedAt' BEGIN SELECT RAISE(ABORT, 'observed'); END")],
      ['observation', (db) => db.exec("CREATE TEMP TRIGGER fail_observation BEFORE INSERT ON codex_live_observations BEGIN SELECT RAISE(ABORT, 'observation'); END")],
      ['watch', (db) => db.exec("CREATE TEMP TRIGGER fail_watch BEFORE INSERT ON codex_watch BEGIN SELECT RAISE(ABORT, 'watch'); END")],
    ];
    for (const [name, inject] of failures) {
      const store = openCommitStore();
      try {
        inject(commitDb(store));
        const before = Object.fromEntries(
          ['active_login', 'switch_log', 'codex_live_observations', 'codex_watch', 'config']
            .map((table) => [table, tableCount(store, table)]),
        );
        assert.throws(() => store.commitCodexSwitch(commitInput()), Error, name);
        for (const [table, count] of Object.entries(before)) {
          assert.equal(tableCount(store, table), count, `${name}: ${table}`);
        }
      } finally {
        store.close();
      }
    }
  });

  it('findCodexSwitchByAttempt finds the committed row', () => {
    const store = openCommitStore();
    try {
      const id = store.commitCodexSwitch(commitInput());
      assert.deepEqual(store.findCodexSwitchByAttempt('attempt-1'), {
        id, ts: 1_000, provider: 'openai-codex', fromAccount: 'from:account', toAccount: 'to:account',
        trigger: 'proactive', outcome: 'ok', detail: 'verified',
        stepsJson: '{"attempt":"attempt-1","via":"switch"}', openSessionsJson: '[{"pid":44}]',
        publishedAt: 900, committedAt: 1_000,
      });
      assert.equal(store.findCodexSwitchByAttempt('missing'), null);
    } finally {
      store.close();
    }
  });
  it('findCodexSwitchByAttempt ignores a malformed steps_json row and still finds the committed row', () => {
    const store = openCommitStore();
    try {
      const id = store.commitCodexSwitch(commitInput());
      commitDb(store).prepare(`INSERT INTO switch_log (ts, provider, to_account, trigger, outcome, steps_json)
        VALUES (2000, 'openai-codex', 'to:account', 'manual', 'refused', 'not json')`).run();
      assert.equal(store.findCodexSwitchByAttempt('attempt-1')?.id, id);
      assert.equal(store.findCodexSwitchByAttempt('missing'), null);
    } finally {
      store.close();
    }
  });

  it('findCodexSwitchByAttempt skips a refusal row with the same attempt', () => {
    const store = openCommitStore();
    try {
      const id = store.commitCodexSwitch(commitInput());
      store.recordSwitch({
        ts: 2_000, provider: 'openai-codex', fromAccount: 'from:account', toAccount: 'to:account',
        trigger: 'manual', outcome: 'refused', detail: 'switch-busy',
        stepsJson: JSON.stringify({ attempt: 'attempt-1', via: 'switch' }), publishedAt: null,
      });
      assert.equal(store.findCodexSwitchByAttempt('attempt-1')?.id, id);
      store.recordSwitch({
        ts: 3_000, provider: 'openai-codex', fromAccount: 'from:account', toAccount: 'to:account',
        trigger: 'manual', outcome: 'refused', detail: 'switch-busy',
        stepsJson: JSON.stringify({ attempt: 'attempt-only-refused', via: 'switch' }), publishedAt: null,
      });
      assert.equal(store.findCodexSwitchByAttempt('attempt-only-refused'), null);
    } finally {
      store.close();
    }
  });

  it('a journal-recovery commit records its observation by qlb-reconcile', () => {
    const store = openCommitStore();
    try {
      store.commitCodexSwitch(commitInput({ via: 'journal', setBy: 'journal' }));
      assert.equal(
        (commitDb(store).prepare('SELECT by FROM codex_live_observations').get() as { by: string }).by,
        'qlb-reconcile',
      );
    } finally {
      store.close();
    }
  });
});
