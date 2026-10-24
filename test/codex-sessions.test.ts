import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  holderEras,
  list,
  renewers,
  stillTheSameProcess,
  type CodexProcess,
} from '../src/codex-sessions';

const A = 'user-a:account-a';
const B = 'user-b:account-b';
const C = 'user-c:account-c';
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
  { fromAccountId: A, toAccountId: B, publishedAt: T0 },
  { fromAccountId: B, toAccountId: A, publishedAt: T0 + 15_000 },
  { fromAccountId: A, toAccountId: C, publishedAt: T0 + 25_000 },
];

describe('Codex session process list and holder eras', () => {
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
    assert.deepEqual(renewers(A, processes, switchRows).map(({ pid }) => pid), [101, 103]);
  });
});
