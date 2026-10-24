import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendObservation,
  holderEras,
  holderSets,
  list,
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

describe('Codex session process list and holder eras', () => {
  it('uses Codex auth’s canonical composite key for holder-era lookups', () => {
    assert.equal(A, 'user-a:account-a');
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

  it('uses observations to bound drift ambiguity and persists observations without credential values', () => {
    const observations = [
      { ts: T0, identity: A, lineageFp: 'a-fingerprint', by: 'tool' as const },
      { ts: T0 + 10_000, identity: B, lineageFp: 'b-fingerprint', by: 'tool' as const },
    ];
    assert.deepEqual(holderSets([], observations), [
      { identities: [A], startsAt: null, endsAt: T0, prehistory: true },
      { identities: [A, B], startsAt: T0, endsAt: T0 + 10_000, prehistory: false },
      { identities: [B], startsAt: T0 + 10_000, endsAt: null, prehistory: false },
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
