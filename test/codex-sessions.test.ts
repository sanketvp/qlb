import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { writeCodexSwitchJournal, type CodexSwitchJournal } from '../src/codex-switch';
import { join } from 'node:path';
import {
  appendObservation,
  codexIdentityParts,
  holderEras,
  holderSets,
  list,
  readCodexSwitchHistory,
  renewers,
  stillTheSameProcess,
  type CodexProcess,
  type CodexSwitchLogRow,
} from '../src/codex-sessions';
import { codexIdentityKey, type CodexIdentity } from '../src/codex-auth';

const identityA: CodexIdentity = { chatgpt_user_id: 'user-a', account_id: 'account-a' };
const identityB: CodexIdentity = { chatgpt_user_id: 'user-b', account_id: 'account-b' };
const identityC: CodexIdentity = { chatgpt_user_id: 'user-c', account_id: 'account-c' };
const A = codexIdentityKey(identityA);
const B = codexIdentityKey(identityB);
const C = codexIdentityKey(identityC);
const T0 = Date.parse('2026-10-24T12:00:00.000Z');

function row(
  id: number,
  fromAccountId: string | null,
  toAccountId: string,
  outcome: CodexSwitchLogRow['outcome'],
  publishedAt: number | null,
  attemptedAt: number | null = publishedAt,
  provider = 'openai-codex',
): CodexSwitchLogRow {
  return { id, provider, fromAccountId, toAccountId, outcome, publishedAt, attemptedAt };
}

function journalFixture(overrides: Partial<CodexSwitchJournal> = {}): CodexSwitchJournal {
  return {
    v: 2,
    attemptId: 'attempt-in-flight',
    from: A,
    to: B,
    target: { identity: identityB, fingerprint: 'fingerprint-b' },
    adoptingTarget: [],
    trigger: 'manual',
    decision: null,
    openSessions: [{ pid: 501, lstart: 'Fri Oct 24 11:59:50 2026', host: 'codex' }],
    outgoing: { sha256: 'outgoing-sha', inode: 123 },
    publishedAt: T0,
    owner: { pid: 999999, lstart: 'Fri Oct 24 11:59:00 2026', state: 'released' },
    ...overrides,
  };
}

function psLine(pid: number, lstart: string, command: string): string {
  return `${pid} ${lstart} ${command}`;
}

const lstarts = {
  before: 'Fri Oct 24 11:59:50 2026',
  afterFirst: 'Fri Oct 24 12:00:05 2026',
  afterSecond: 'Fri Oct 24 12:00:20 2026',
  afterThird: 'Fri Oct 24 12:00:30 2026',
};

const switchRows = [
  row(1, A, B, 'ok', T0),
  row(2, B, A, 'ok', T0 + 15_000),
  row(3, A, C, 'ok', T0 + 25_000),
];

function fenceHistoryDb(dir: string, fenceValue?: unknown): string {
  const dbPath = join(dir, 'qlb.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE switch_log (
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL,
      from_account TEXT, to_account TEXT NOT NULL, outcome TEXT NOT NULL,
      detail TEXT, published_at INTEGER, steps_json TEXT, open_sessions_json TEXT
    );
    CREATE TABLE codex_live_observations (
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, identity TEXT,
      lineage_fp TEXT, by TEXT NOT NULL
    );
    CREATE TABLE config (key TEXT PRIMARY KEY, value);
    CREATE TABLE codex_slots (account_id TEXT PRIMARY KEY);`);
    db.prepare('INSERT INTO codex_slots (account_id) VALUES (?), (?), (?)').run(A, B, C);
    if (fenceValue !== undefined) {
      db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('codex.recoveryFence', fenceValue as string | number);
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function openIdentities(rows: readonly CodexSwitchLogRow[]): string[] {
  return holderEras(rows).filter((era) => era.endsAt === null).map((era) => era.identity).sort();
}


describe('Codex session process list and holder eras', () => {
  it('uses Codex auth’s canonical composite key for holder-era lookups', () => {
    assert.equal(A, 'user-a:account-a');
  });

  it('readCodexSwitchHistory returns only openai-codex rows ordered by published_at, ts, id', () => {
    const dir = mkdtempSync('/tmp/qlb-codex-history-');
    const dbPath = join(dir, 'qlb.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`CREATE TABLE switch_log (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL,
        from_account TEXT, to_account TEXT NOT NULL, outcome TEXT NOT NULL,
        detail TEXT, published_at INTEGER, steps_json TEXT, open_sessions_json TEXT
      );
      CREATE TABLE codex_live_observations (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, identity TEXT,
        lineage_fp TEXT, by TEXT NOT NULL
      );
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE codex_slots (account_id TEXT PRIMARY KEY);
      INSERT INTO switch_log VALUES
        (8, 5, 'openai-codex', 'user-b:account-b', 'user-c:account-c', 'ok', 'last', 100, '{"attempt":"third"}', NULL),
        (3, 30, 'openai-codex', 'user-a:account-a', 'user-b:account-b', 'failed', 'first', NULL, '{"attempt":"first"}', NULL),
        (5, 5, 'openai-codex', 'user-c:account-c', 'user-a:account-a', 'rolled-back', 'middle', 100, '{"attempt":"second"}', NULL),
        (2, 1, 'anthropic', 'other', 'ignored', 'ok', 'ignored', 0, '{}', NULL);
      INSERT INTO codex_live_observations VALUES (1, 9, 'user-a:account-a', 'lineage-a', 'test');`);
    } finally {
      db.close();
    }
    try {
      const history = readCodexSwitchHistory(dbPath);
      assert.deepEqual(history.rows.map((entry) => entry.id), [3, 5, 8]);
      assert.deepEqual(history.rows.map((entry) => ({
        detail: entry.detail, published_at: entry.published_at, steps_json: entry.steps_json,
      })), [
        { detail: 'first', published_at: null, steps_json: '{"attempt":"first"}' },
        { detail: 'middle', published_at: 100, steps_json: '{"attempt":"second"}' },
        { detail: 'last', published_at: 100, steps_json: '{"attempt":"third"}' },
      ]);
      assert.deepEqual(history.observations, [
        { ts: 9, identity: A, lineageFp: 'lineage-a', by: 'test' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an on-disk journal keeps both sides live in holderSets', () => {
    const dir = mkdtempSync('/tmp/qlb-codex-journal-history-');
    const dbPath = join(dir, 'qlb.db');
    const journalDir = join(dir, 'journal');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`CREATE TABLE switch_log (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL,
        from_account TEXT, to_account TEXT NOT NULL, outcome TEXT NOT NULL,
        detail TEXT, published_at INTEGER, steps_json TEXT, open_sessions_json TEXT
      );
      CREATE TABLE codex_live_observations (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, identity TEXT,
        lineage_fp TEXT, by TEXT NOT NULL
      );
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE codex_slots (account_id TEXT PRIMARY KEY);`);
      db.prepare('INSERT INTO codex_slots (account_id) VALUES (?), (?)').run(A, B);
    } finally {
      db.close();
    }
    try {
      writeCodexSwitchJournal(journalFixture(), { journalDir });
      const history = readCodexSwitchHistory(dbPath, { journalDir });
      assert.equal(history.rows.length, 1);
      assert.equal(history.rows[0].outcome, 'in-flight');
      assert.deepEqual([...new Set(holderSets(history.rows, []).flatMap((set) => set.identities))].sort(), [A, B]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a recovery fence keeps every involved account live, including a third slot', () => {
    const dir = mkdtempSync('/tmp/qlb-codex-fence-history-');
    const dbPath = join(dir, 'qlb.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`CREATE TABLE switch_log (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL,
        from_account TEXT, to_account TEXT NOT NULL, outcome TEXT NOT NULL,
        detail TEXT, published_at INTEGER, steps_json TEXT, open_sessions_json TEXT
      );
      CREATE TABLE codex_live_observations (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, identity TEXT,
        lineage_fp TEXT, by TEXT NOT NULL
      );
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE codex_slots (account_id TEXT PRIMARY KEY);`);
      db.prepare('INSERT INTO codex_slots (account_id) VALUES (?), (?), (?)').run(A, B, C);
      db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('codex.recoveryFence', JSON.stringify({
        v: 1, switchId: 81, attempt: 'fence-attempt', from: A, to: B,
        publishedAt: T0, reason: 'slot-split', involvedAccounts: [A, B, C], since: T0 + 1,
      }));
    } finally {
      db.close();
    }
    try {
      const history = readCodexSwitchHistory(dbPath, { journalDir: join(dir, 'journal') });
      assert.deepEqual(holderEras(history.rows).filter((era) => era.endsAt === null), [
        // The fence's source keeps its prehistory: processes already holding it stay renewers.
        { identity: A, startsAt: null, endsAt: null },
        { identity: B, startsAt: T0, endsAt: null },
        { identity: C, startsAt: T0, endsAt: null },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a recovery fence and an uncommitted journal keep the union of their involved accounts live', () => {
    const dir = mkdtempSync('/tmp/qlb-codex-fence-journal-history-');
    const dbPath = join(dir, 'qlb.db');
    const journalDir = join(dir, 'journal');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`CREATE TABLE switch_log (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL,
        from_account TEXT, to_account TEXT NOT NULL, outcome TEXT NOT NULL,
        detail TEXT, published_at INTEGER, steps_json TEXT, open_sessions_json TEXT
      );
      CREATE TABLE codex_live_observations (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, identity TEXT,
        lineage_fp TEXT, by TEXT NOT NULL
      );
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE codex_slots (account_id TEXT PRIMARY KEY);`);
      db.prepare('INSERT INTO codex_slots (account_id) VALUES (?), (?), (?)').run(A, B, C);
      db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('codex.recoveryFence', JSON.stringify({
        v: 1, switchId: 81, attempt: 'fence-attempt', from: A, to: B,
        publishedAt: T0, reason: 'slot-split', involvedAccounts: [A, B], since: T0 + 1,
      }));
    } finally {
      db.close();
    }
    try {
      writeCodexSwitchJournal(journalFixture({ unresolved: { reason: 'target-ancestor', involvedAccounts: [C], since: T0 + 2 } }), { journalDir });
      const history = readCodexSwitchHistory(dbPath, { journalDir });
      assert.equal(history.rows.filter((row) => row.outcome === 'in-flight').length, 1, 'one synthetic row');
      assert.deepEqual(holderEras(history.rows).filter((era) => era.endsAt === null).map((era) => era.identity).sort(), [A, B, C].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a malformed on-disk journal keeps every slot live instead of reading as absent', () => {
    const dir = mkdtempSync('/tmp/qlb-codex-malformed-journal-history-');
    try {
      const dbPath = fenceHistoryDb(dir);
      const journalDir = join(dir, 'journal');
      mkdirSync(journalDir, { recursive: true });
      writeFileSync(join(journalDir, 'switch-openai-codex.json'), '{"v":2');
      assert.deepEqual(openIdentities(readCodexSwitchHistory(dbPath, { journalDir }).rows), [A, B, C].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-string recovery fence value keeps every slot live', () => {
    const dir = mkdtempSync('/tmp/qlb-codex-numeric-fence-history-');
    try {
      const dbPath = fenceHistoryDb(dir, 42);
      assert.deepEqual(openIdentities(readCodexSwitchHistory(dbPath, { journalDir: join(dir, 'journal') }).rows), [A, B, C].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a standing fence is not shrunk by a later ok switch or a later observation', () => {
    const fence: CodexSwitchLogRow = {
      id: -1, provider: 'openai-codex', fromAccountId: A, toAccountId: B, outcome: 'in-flight',
      publishedAt: T0, attemptedAt: T0, involved: [A, B, C],
    };
    const ok: CodexSwitchLogRow = {
      id: 81, provider: 'openai-codex', fromAccountId: A, toAccountId: B, outcome: 'ok',
      publishedAt: T0, attemptedAt: T0,
    };
    assert.deepEqual(openIdentities([fence, ok]), [A, B, C].sort());
    const sets = holderSets([fence, ok], [{ ts: T0 + 60_000, identity: B, lineageFp: null, by: 'test' }]);
    assert.deepEqual(sets.at(-1)?.identities, [A, B, C].sort());
  });

  it('a process started before an unresolved switch published still renews its source account', () => {
    const fence: CodexSwitchLogRow = {
      id: -1, provider: 'openai-codex', fromAccountId: A, toAccountId: B, outcome: 'in-flight',
      publishedAt: T0, attemptedAt: T0, involved: [A, B],
    };
    const before = { pid: 501, lstart: 'Fri Oct 24 11:59:50 2026', host: 'codex' };
    assert.deepEqual(renewers(identityA, [before], [fence]), [before]);
  });

  it('a malformed recovery fence keeps every slot live', () => {
    const dir = mkdtempSync('/tmp/qlb-codex-malformed-fence-history-');
    const dbPath = join(dir, 'qlb.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`CREATE TABLE switch_log (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL,
        from_account TEXT, to_account TEXT NOT NULL, outcome TEXT NOT NULL,
        detail TEXT, published_at INTEGER, steps_json TEXT, open_sessions_json TEXT
      );
      CREATE TABLE codex_live_observations (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, identity TEXT,
        lineage_fp TEXT, by TEXT NOT NULL
      );
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE codex_slots (account_id TEXT PRIMARY KEY);`);
      db.prepare('INSERT INTO codex_slots (account_id) VALUES (?), (?), (?)').run(A, B, C);
      db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('codex.recoveryFence', JSON.stringify({
        v: 1, switchId: 82, attempt: 'malformed-attempt', from: A, to: B,
        publishedAt: T0, reason: 'slot-split', involvedAccounts: [A, B], since: T0 + 1,
        extra: 'not-allowed',
      }));
    } finally {
      db.close();
    }
    try {
      const history = readCodexSwitchHistory(dbPath, { journalDir: join(dir, 'journal') });
      assert.deepEqual(holderSets(history.rows, []).flatMap((set) => set.identities).sort(), [A, B, C]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a journal whose attempt is committed adds no synthetic row', () => {
    const dir = mkdtempSync('/tmp/qlb-codex-committed-journal-history-');
    const dbPath = join(dir, 'qlb.db');
    const journalDir = join(dir, 'journal');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`CREATE TABLE switch_log (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL,
        from_account TEXT, to_account TEXT NOT NULL, outcome TEXT NOT NULL,
        detail TEXT, published_at INTEGER, steps_json TEXT, open_sessions_json TEXT
      );
      CREATE TABLE codex_live_observations (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, identity TEXT,
        lineage_fp TEXT, by TEXT NOT NULL
      );
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE codex_slots (account_id TEXT PRIMARY KEY);
      INSERT INTO switch_log VALUES (81, ${T0 + 2}, 'openai-codex', '${A}', '${B}', 'ok', NULL, ${T0}, '{"attempt":"attempt-in-flight"}', '[]');`);
    } finally {
      db.close();
    }
    try {
      writeCodexSwitchJournal(journalFixture(), { journalDir });
      const history = readCodexSwitchHistory(dbPath, { journalDir });
      assert.deepEqual(history.rows.map(({ id, outcome }) => ({ id, outcome })), [{ id: 81, outcome: 'ok' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('codexIdentityParts splits at the first colon', () => {
    assert.deepEqual(codexIdentityParts('user-a:account:with:colons'), {
      chatgpt_user_id: 'user-a', account_id: 'account:with:colons',
    });
  });

  it('codex refresh holder sets are unchanged after the move', () => {
    const dir = mkdtempSync('/tmp/qlb-codex-holders-');
    const dbPath = join(dir, 'qlb.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`CREATE TABLE switch_log (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL,
        from_account TEXT, to_account TEXT NOT NULL, outcome TEXT NOT NULL,
        detail TEXT, published_at INTEGER, steps_json TEXT, open_sessions_json TEXT
      );
      CREATE TABLE codex_live_observations (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, identity TEXT,
        lineage_fp TEXT, by TEXT NOT NULL
      );
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE codex_slots (account_id TEXT PRIMARY KEY);
      INSERT INTO switch_log VALUES
        (1, ${T0}, 'openai-codex', '${A}', '${B}', 'ok', NULL, ${T0}, NULL, NULL),
        (2, ${T0 + 15_000}, 'openai-codex', '${B}', '${A}', 'ok', NULL, ${T0 + 15_000}, NULL, NULL);`);
    } finally {
      db.close();
    }
    try {
      const history = readCodexSwitchHistory(dbPath);
      const holders = renewers(codexIdentityParts(B), [
        { pid: 811, lstart: lstarts.afterFirst, host: 'codex' },
        { pid: 812, lstart: lstarts.afterThird, host: 'codex' },
      ], history.rows, history.observations);
      assert.deepEqual(holders.map(({ pid }) => pid), [811]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists only Codex processes from injected ps output without running ps in tests', async () => {
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const sessions = await list({
      runPs: async (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return [
          psLine(101, lstarts.before, '/opt/homebrew/bin/codex'),
          psLine(102, lstarts.afterFirst, '/usr/bin/node'),
          psLine(103, lstarts.afterSecond, 'codex'),
          '',
        ].join('\n');
      },
    });

    assert.deepEqual(sessions, [
      { pid: 101, lstart: lstarts.before, host: 'codex' },
      { pid: 103, lstart: lstarts.afterSecond, host: 'codex' },
    ]);
    assert.deepEqual(calls[0].args, ['-axo', 'pid=,lstart=,comm=']);
    assert.equal(calls[0].env.LC_ALL, 'C');
    assert.equal(calls[0].env.TZ, 'UTC');
  });

  it('uses the lstart fingerprint to reject a recycled pid', async () => {
    const recorded: CodexProcess = { pid: 4411, lstart: lstarts.before, host: 'codex' };
    assert.equal(await stillTheSameProcess(recorded, { runPs: async () => lstarts.before }), true);
    assert.equal(await stillTheSameProcess(recorded, { runPs: async () => lstarts.afterThird }), false);
  });

  it('treats only ps exit 1 as a gone process and surfaces other ps failures', async () => {
    const recorded: CodexProcess = { pid: 4411, lstart: lstarts.before, host: 'codex' };
    await assert.doesNotReject(async () => {
      const gone = await stillTheSameProcess(recorded, {
        runPs: async () => { throw Object.assign(new Error('process missing'), { code: 1 }); },
      });
      assert.equal(gone, false);
    });
    await assert.rejects(
      stillTheSameProcess(recorded, {
        runPs: async () => { throw Object.assign(new Error('ps unavailable'), { code: 'EACCES' }); },
      }),
      /ps unavailable/,
    );
  });

  it('retains ordinary ok-era ordering for diagnostics', () => {
    assert.deepEqual(holderEras(switchRows), [
      { identity: A, startsAt: null, endsAt: T0 },
      { identity: B, startsAt: T0, endsAt: T0 + 15_000 },
      { identity: A, startsAt: T0 + 15_000, endsAt: T0 + 25_000 },
      { identity: C, startsAt: T0 + 25_000, endsAt: null },
    ]);
  });

  it('keeps both sides of failed, rolled-back, and reverted switches live until an ok replacement', () => {
    for (const outcome of ['failed', 'rolled-back', 'reverted-by-codex'] as const) {
      const rows = [
        row(1, A, B, outcome, T0),
        row(2, B, C, 'ok', T0 + 10_000),
      ];
      const process = [{ pid: 201, lstart: lstarts.afterFirst, host: 'codex' }];
      assert.deepEqual(renewers(identityA, process, rows).map(({ pid }) => pid), [201], outcome);
      assert.deepEqual(renewers(identityB, process, rows).map(({ pid }) => pid), [201], outcome);
    }
  });

  it('keeps the source of a single failed switch and adds its target as a possible holder', () => {
    const rows = [row(1, A, B, 'failed', T0)];
    const before = [{ pid: 202, lstart: lstarts.before, host: 'codex' }];
    const after = [{ pid: 203, lstart: lstarts.afterFirst, host: 'codex' }];
    assert.deepEqual(renewers(identityA, before, rows).map(({ pid }) => pid), [202]);
    assert.deepEqual(renewers(identityB, after, rows).map(({ pid }) => pid), [203]);
  });

  it('retains the intermediate target after an ok switch is later reversed', () => {
    const rows = [
      row(1, A, B, 'ok', T0),
      row(2, B, A, 'ok', T0 + 15_000),
    ];
    const between = [{ pid: 204, lstart: lstarts.afterFirst, host: 'codex' }];
    const before = [{ pid: 205, lstart: lstarts.before, host: 'codex' }];
    assert.deepEqual(renewers(identityB, between, rows).map(({ pid }) => pid), [204]);
    assert.deepEqual(renewers(identityA, before, rows).map(({ pid }) => pid), [205]);
  });

  it('retains an ok source reintroduced by a later ok row as a possible holder', () => {
    const rows = [
      row(1, A, B, 'ok', T0),
      row(2, A, C, 'ok', T0 + 60_000),
    ];
    const process = [{ pid: 208, lstart: 'Fri Oct 24 12:00:30 2026', host: 'codex' }];

    assert.deepEqual(renewers(identityA, process, rows).map(({ pid }) => pid), [208]);
  });

  it('retains an ok source absent from prior rows as a possible holder', () => {
    const rows = [
      row(1, A, B, 'ok', T0),
      row(2, C, 'account-d', 'ok', T0 + 60_000),
    ];
    const process = [{ pid: 209, lstart: 'Fri Oct 24 12:00:30 2026', host: 'codex' }];

    assert.deepEqual(renewers(identityC, process, rows).map(({ pid }) => pid), [209]);
  });

  it('excludes a process starting at the one-second safe boundary after definite replacement', () => {
    const rows = [row(1, A, B, 'ok', T0)];
    const process = [{ pid: 206, lstart: 'Fri Oct 24 12:00:01 2026', host: 'codex' }];
    assert.deepEqual(renewers(identityA, process, rows), []);
  });

  it('rejects a missing writing-row time, a foreign provider, and an unsafe row id', () => {
    assert.throws(() => holderEras([row(1, A, B, 'failed', null, null)]), /row time/);
    assert.throws(
      () => holderEras([row(1, A, B, 'ok', T0, T0, 'anthropic')]),
      /Non-Codex provider/,
    );
    assert.throws(() => holderEras([row(Number.MAX_SAFE_INTEGER + 1, A, B, 'ok', T0)]), /row id/);
  });

  it('orders matching row times with safe integer ids rather than input order', () => {
    const rows = [
      row(20, B, C, 'ok', T0),
      row(10, A, B, 'ok', T0),
    ];
    assert.deepEqual(holderEras(rows), [
      { identity: A, startsAt: null, endsAt: T0 },
      { identity: B, startsAt: T0, endsAt: T0 },
      { identity: C, startsAt: T0, endsAt: null },
    ]);
  });

  it('fails safe by treating an unparseable process start as a renewer', () => {
    assert.deepEqual(
      renewers(identityA, [{ pid: 207, lstart: 'unparseable', host: 'codex' }], switchRows)
        .map(({ pid }) => pid),
      [207],
    );
  });

  it('uses the published-at transition interval for conservative holder sets (AC56)', () => {
    const rows = [row(1, A, B, 'ok', T0, T0 + 5_000)];
    const processes: CodexProcess[] = [
      { pid: 301, lstart: 'Fri Oct 24 11:59:58 2026', host: 'codex' },
      { pid: 302, lstart: 'Fri Oct 24 12:00:00 2026', host: 'codex' },
      { pid: 303, lstart: 'Fri Oct 24 12:00:03 2026', host: 'codex' },
      { pid: 304, lstart: 'Fri Oct 24 12:00:07 2026', host: 'codex' },
    ];

    assert.deepEqual(holderSets(rows, []).map(({ identities }) => identities), [
      [A], [A, B], [B],
    ]);
    assert.deepEqual(
      processes.map((process) => holderSets(rows, []).find((set) =>
        (set.startsAt === null || Date.parse(`${process.lstart} UTC`) >= set.startsAt)
        && (set.endsAt === null || Date.parse(`${process.lstart} UTC`) < set.endsAt),
      )?.identities),
      [[A], [A, B], [B], [B]],
    );
    assert.deepEqual(renewers(identityB, processes, rows).map(({ pid }) => pid), [302, 303, 304]);
  });

  it('widens an ok row without published_at around its attempted-at boundary', () => {
    const rows = [row(1, A, B, 'ok', null, T0)];
    const processes: CodexProcess[] = [
      { pid: 401, lstart: 'Fri Oct 24 11:59:59 2026', host: 'codex' },
      { pid: 402, lstart: 'Fri Oct 24 12:00:00 2026', host: 'codex' },
      { pid: 403, lstart: 'Fri Oct 24 12:00:01 2026', host: 'codex' },
    ];

    assert.deepEqual(renewers(identityA, processes, rows).map(({ pid }) => pid), [401, 402]);
  });

  it('does not add observation drift ambiguity when an ok switch explains the transition', () => {
    const rows = [row(1, A, B, 'ok', T0)];
    const observations = [
      { ts: T0 - 60_000, identity: A, lineageFp: 'a', by: 'tool' },
      { ts: T0 + 5_000, identity: B, lineageFp: 'b', by: 'tool' },
    ];
    const processes: CodexProcess[] = [
      { pid: 411, lstart: 'Fri Oct 24 11:59:58 2026', host: 'codex' },
      { pid: 412, lstart: 'Fri Oct 24 12:00:00 2026', host: 'codex' },
      { pid: 413, lstart: 'Fri Oct 24 12:00:03 2026', host: 'codex' },
      { pid: 414, lstart: 'Fri Oct 24 12:00:07 2026', host: 'codex' },
    ];
    const sets = holderSets(rows, observations);

    assert.deepEqual(processes.map((process) => sets.find((set) => {
      const startedAt = Date.parse(`${process.lstart} UTC`);
      return (set.startsAt === null || startedAt >= set.startsAt)
        && (set.endsAt === null || startedAt < set.endsAt);
    })?.identities), [[A], [A, B], [B], [B]]);
  });

  it('widens observation boundaries for whole-second process starts', () => {
    const observations = [
      { ts: T0 + 500, identity: A, lineageFp: 'a', by: 'tool' },
      { ts: T0 + 1_000, identity: B, lineageFp: 'b', by: 'tool' },
    ];
    const process = [{ pid: 421, lstart: 'Fri Oct 24 12:00:00 2026', host: 'codex' }];

    assert.deepEqual(renewers(identityB, process, [], observations).map(({ pid }) => pid), [421]);
  });

  it('keeps same-timestamp observation identities possible independent of input order', () => {
    const first = [
      { ts: T0, identity: A, lineageFp: 'a', by: 'tool' },
      { ts: T0, identity: B, lineageFp: 'b', by: 'tool' },
    ];
    const second = [...first].reverse();
    const atBoundary = (sets: ReturnType<typeof holderSets>) => sets.find((set) =>
      (set.startsAt === null || T0 >= set.startsAt) && (set.endsAt === null || T0 < set.endsAt),
    )?.identities;

    assert.deepEqual(holderSets([], first), holderSets([], second));
    assert.deepEqual(atBoundary(holderSets([], first)), [A, B]);
  });

  it('does not close a later switch-log era from an earlier observation', () => {
    const rows = [row(1, A, B, 'ok', T0)];
    const observations = [{ ts: T0 - 60_000, identity: A, lineageFp: 'a', by: 'tool' }];
    const processes: CodexProcess[] = [
      { pid: 441, lstart: 'Fri Oct 24 12:00:07 2026', host: 'codex' },
      { pid: 442, lstart: 'Fri Oct 24 12:30:00 2026', host: 'codex' },
    ];

    assert.ok(holderSets(rows, observations).some((set) =>
      set.identities.includes(B) && set.startsAt === T0 - 1_000 && set.endsAt === null,
    ));
    assert.deepEqual(renewers(identityB, processes, rows, observations).map(({ pid }) => pid), [441, 442]);
  });

  it('does not close a later target era from an observation between ok switches', () => {
    const rows = [
      row(1, A, B, 'ok', T0),
      row(2, B, C, 'ok', T0 + 20_000),
    ];
    const observations = [{ ts: T0 + 10_000, identity: B, lineageFp: 'b', by: 'tool' }];
    const process = [{ pid: 451, lstart: 'Fri Oct 24 12:00:25 2026', host: 'codex' }];

    assert.ok(holderSets(rows, observations).some((set) =>
      set.identities.includes(C) && set.startsAt === T0 + 19_000 && set.endsAt === null,
    ));
    assert.deepEqual(renewers(identityC, process, rows, observations).map(({ pid }) => pid), [451]);
  });

  it('lets later observations close a stale open switch-log holder era', () => {
    const rows = [row(1, A, B, 'ok', T0)];
    const observations = [
      { ts: T0 + 10_000, identity: B, lineageFp: 'b', by: 'tool' },
      { ts: T0 + 20_000, identity: C, lineageFp: 'c', by: 'tool' },
    ];
    const process = [{ pid: 431, lstart: 'Fri Oct 24 12:00:22 2026', host: 'codex' }];

    assert.deepEqual(renewers(identityB, process, rows, observations), []);
    assert.deepEqual(renewers(identityC, process, rows, observations).map(({ pid }) => pid), [431]);
  });

  it('uses observations to bound drift ambiguity and persists observations without credential values', () => {
    const observations = [
      { ts: T0, identity: A, lineageFp: 'a-fingerprint', by: 'tool' as const },
      { ts: T0 + 10_000, identity: B, lineageFp: 'b-fingerprint', by: 'tool' as const },
    ];
    assert.deepEqual(holderSets([], observations), [
      { identities: [A], startsAt: null, endsAt: T0 - 1_000, prehistory: true },
      { identities: [A, B], startsAt: T0 - 1_000, endsAt: T0 + 11_000, prehistory: false },
      { identities: [B], startsAt: T0 + 11_000, endsAt: null, prehistory: false },
    ]);

    const dir = mkdtempSync('/tmp/qlb-codex-observation-');
    const db = new DatabaseSync(join(dir, 'qlb.db'));
    try {
      db.exec('CREATE TABLE codex_live_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, identity TEXT, lineage_fp TEXT, by TEXT NOT NULL)');
      appendObservation(db, observations[0]);
      assert.deepEqual({ ...db.prepare('SELECT ts, identity, lineage_fp, by FROM codex_live_observations').get() as object }, {
        ts: T0, identity: A, lineage_fp: 'a-fingerprint', by: 'tool',
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
