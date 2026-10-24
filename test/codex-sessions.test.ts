import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  holderEras,
  list,
  renewers,
  stillTheSameProcess,
  type CodexProcess,
} from '../src/codex-sessions';
import { codexIdentityKey, type CodexIdentity } from '../src/codex-auth';

const identityA: CodexIdentity = { chatgpt_user_id: 'user-a', account_id: 'account-a' };
const identityB: CodexIdentity = { chatgpt_user_id: 'user-b', account_id: 'account-b' };
const identityC: CodexIdentity = { chatgpt_user_id: 'user-c', account_id: 'account-c' };
const A = codexIdentityKey(identityA);
const B = codexIdentityKey(identityB);
const C = codexIdentityKey(identityC);
const T0 = Date.parse('2026-10-24T12:00:00.000Z');

function psLine(pid: number, lstart: string, command: string): string {
  return `${pid} ${lstart} ${command}`;
}

const lstarts = {
  a1: 'Fri Oct 24 11:59:50 2026',
  b: 'Fri Oct 24 12:00:10 2026',
  a2: 'Fri Oct 24 12:00:20 2026',
  c: 'Fri Oct 24 12:00:30 2026',
};

const switchRows = [
  { id: 1, fromAccountId: A, toAccountId: B, outcome: 'ok' as const, publishedAt: T0 },
  { id: 2, fromAccountId: B, toAccountId: A, outcome: 'ok' as const, publishedAt: T0 + 15_000 },
  { id: 3, fromAccountId: A, toAccountId: C, outcome: 'ok' as const, publishedAt: T0 + 25_000 },
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
          psLine(101, lstarts.a1, '/opt/homebrew/bin/codex'),
          psLine(102, lstarts.b, '/usr/bin/node'),
          psLine(103, lstarts.a2, 'codex'),
          '',
        ].join('\n');
      },
    });

    assert.deepEqual(sessions, [
      { pid: 101, lstart: lstarts.a1, host: 'codex' },
      { pid: 103, lstart: lstarts.a2, host: 'codex' },
    ]);
    assert.deepEqual(calls[0].args, ['-axo', 'pid=,lstart=,comm=']);
    assert.equal(calls[0].env.LC_ALL, 'C');
    assert.equal(calls[0].env.TZ, 'UTC');
  });

  it('uses the lstart fingerprint to reject a recycled pid', async () => {
    const recorded: CodexProcess = { pid: 4411, lstart: lstarts.a1, host: 'codex' };
    const same = await stillTheSameProcess(recorded, {
      runPs: async () => lstarts.a1,
    });
    const recycled = await stillTheSameProcess(recorded, {
      runPs: async () => lstarts.c,
    });

    assert.equal(same, true);
    assert.equal(recycled, false);
  });

  it('treats only ps exit 1 as a gone process and surfaces other ps failures', async () => {
    const recorded: CodexProcess = { pid: 4411, lstart: lstarts.a1, host: 'codex' };
    await assert.doesNotReject(async () => {
      const gone = await stillTheSameProcess(recorded, {
        runPs: async () => {
          throw Object.assign(new Error('process missing'), { code: 1 });
        },
      });
      assert.equal(gone, false);
    });
    await assert.rejects(
      stillTheSameProcess(recorded, {
        runPs: async () => {
          throw Object.assign(new Error('ps unavailable'), { code: 'EACCES' });
        },
      }),
      /ps unavailable/,
    );
  });

  it('reconstructs instant holder eras and returns the two A-era renewers', () => {
    assert.deepEqual(holderEras(switchRows), [
      { identity: A, startsAt: null, endsAt: T0 },
      { identity: B, startsAt: T0, endsAt: T0 + 15_000 },
      { identity: A, startsAt: T0 + 15_000, endsAt: T0 + 25_000 },
      { identity: C, startsAt: T0 + 25_000, endsAt: null },
    ]);

    const processes: CodexProcess[] = [
      { pid: 101, lstart: lstarts.a1, host: 'codex' },
      { pid: 102, lstart: lstarts.b, host: 'codex' },
      { pid: 103, lstart: lstarts.a2, host: 'codex' },
      { pid: 104, lstart: lstarts.c, host: 'codex' },
    ];
    assert.deepEqual(renewers(identityA, processes, switchRows).map(({ pid }) => pid), [101, 103]);
  });

  it('creates eras only for outcomes that changed the live file', () => {
    const rows = [
      { id: 1, fromAccountId: A, toAccountId: B, outcome: 'ok' as const, publishedAt: T0 },
      { id: 2, fromAccountId: B, toAccountId: A, outcome: 'failed' as const, publishedAt: T0 + 10_000 },
      { id: 3, fromAccountId: B, toAccountId: A, outcome: 'rolled-back' as const, publishedAt: T0 + 20_000 },
    ];
    assert.deepEqual(holderEras(rows), [
      { identity: A, startsAt: null, endsAt: T0 },
      { identity: B, startsAt: T0, endsAt: null },
    ]);
    assert.deepEqual(
      renewers(identityB, [{ pid: 105, lstart: lstarts.c, host: 'codex' }], rows).map(({ pid }) => pid),
      [105],
    );
  });

  it('orders equal publishedAt rows by switch-log id, not caller order', () => {
    const rows = [
      { id: 20, fromAccountId: B, toAccountId: C, outcome: 'ok' as const, publishedAt: T0 },
      { id: 10, fromAccountId: A, toAccountId: B, outcome: 'ok' as const, publishedAt: T0 },
    ];
    assert.deepEqual(holderEras(rows), [
      { identity: A, startsAt: null, endsAt: T0 },
      { identity: B, startsAt: T0, endsAt: T0 },
      { identity: C, startsAt: T0, endsAt: null },
    ]);
  });

  it('rejects an invalid effective publication timestamp rather than omitting a possible holder', () => {
    assert.throws(
      () => holderEras([
        { id: 1, fromAccountId: A, toAccountId: B, outcome: 'ok', publishedAt: Number.NaN },
      ]),
      /Invalid effective Codex switch-log publication row/,
    );
  });

  it('fails safe by treating an unparseable process start as a renewer', () => {
    assert.deepEqual(
      renewers(identityA, [{ pid: 106, lstart: 'unparseable', host: 'codex' }], switchRows)
        .map(({ pid }) => pid),
      [106],
    );
  });
});
