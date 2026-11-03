import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  KEYCHAIN_WAIT_SCRIPT,
  KeychainClientDisabledInTests,
  KeychainClientNotStarted,
  KeychainRequestStillWaiting,
  assertNoWaitingClient,
  isKeychainClientNotStarted,
  isKeychainStillWaiting,
  keychainClientExec,
  keychainItemKey,
  keychainRequestFromArgv,
  runKeychainClientSync,
  type KeychainExecFn,
} from '../src/keychain-client';

// The leaf has one callable contract: no Node ExecFileSyncOptions escape hatch.
const positiveExecutor: KeychainExecFn = <T extends 'utf8' | 'buffer' = 'utf8'>(
  _file: string,
  _args: readonly string[],
  options: { keychainKind: 'security' | 'helper'; timeout: number; maxBuffer?: number; encoding?: T },
) => (options.encoding === 'buffer' ? Buffer.alloc(0) : '') as T extends 'buffer' ? Buffer : string;
void positiveExecutor;
if (false) {
  // @ts-expect-error keychainKind is mandatory for every executor, including fakes.
  keychainClientExec('/tmp/no-client', [], { timeout: 1 });
}

function state(): { home: string; dir: string; out: string } {
  const home = mkdtempSync(join(tmpdir(), 'qlb-nokill-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'qlb-nokill-fake-'));
  const out = dir;
  return { home, dir, out };
}

function withState<T>(s: ReturnType<typeof state>, fn: () => T): T {
  const before = { QLB_TEST_MODE: process.env.QLB_TEST_MODE, QLB_HOME: process.env.QLB_HOME, HOME: process.env.HOME };
  Object.assign(process.env, { QLB_TEST_MODE: '1', QLB_HOME: s.home, HOME: s.home });
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function fake(s: ReturnType<typeof state>, body: string, name = 'security-fake'): string {
  const path = join(s.dir, name);
  writeFileSync(path, `#!/bin/sh\nset -eu\nd=$(dirname "$0")\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function request(file: string, service: string, timeoutMs = 2_000, options: { account?: string; psPath?: string; maxBuffer?: number } = {}) {
  const args = ['find-generic-password', '-s', service];
  if (options.account !== undefined) args.push('-a', options.account);
  return keychainRequestFromArgv('security', file, args, { timeoutMs, encoding: 'utf8', psPath: options.psPath, maxBuffer: options.maxBuffer });
}

function recordPath(home: string, service: string): string {
  return join(home, '.qlb', 'keychain-waiting', `${createHash('sha256').update(keychainItemKey(service, '')).digest('hex')}.json`);
}

function waitFor(path: string, timeoutMs = 1_000): void {
  const until = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < until) {
    spawnSync('/bin/sh', ['-c', 'sleep 0.02']);
  }
  assert.ok(existsSync(path), `expected ${path}`);
}

describe('keychain client leaf runner', () => {
  it('(a,b,s) returns a fast result, hides argv beyond the command, and cleans a private record', () => {
    const s = state();
    withState(s, () => {
      const good = fake(s, 'printf "v\\n"');
      assert.equal(runKeychainClientSync(request(good, 'svc-fast')), 'v\n');
      assert.equal(existsSync(recordPath(s.home, 'svc-fast')), false);

      const absent = fake(s, 'echo "could not be found" >&2\nexit 44', 'missing');
      assert.throws(() => runKeychainClientSync(request(absent, 'svc-missing')), (err: unknown) => {
        const e = err as Error & { status?: number };
        assert.equal(e.status, 44);
        assert.match(e.message, /could not be found/);
        assert.doesNotMatch(e.message, /svc-missing/);
        return true;
      });

      const slow = fake(s, 'sleep 0.2\nprintf ok');
      assert.equal(runKeychainClientSync(request(slow, 'svc-mode')), 'ok');
      const rec = recordPath(s.home, 'svc-mode');
      assert.equal(statSync(join(s.home, '.qlb', 'keychain-waiting')).mode & 0o777, 0o700);
      assert.equal(existsSync(rec), false);
    });
  });

  it('(c,d,e,f) leaves a timed-out client detached, blocks only its service, then recovers', () => {
    const s = state();
    withState(s, () => {
      const slow = fake(s, 'echo $$ > "$d/pid"\nsleep 1\necho after > "$d/after"\nprintf v');
      const started = Date.now();
      assert.throws(() => runKeychainClientSync(request(slow, 'svc-wait', 300)), (err: unknown) => (err as { code?: unknown }).code === 'ETIMEDOUT');
      assert.ok(Date.now() - started < 1_500);
      waitFor(join(s.out, 'pid'));
      const rec = recordPath(s.home, 'svc-wait');
      const recorded = JSON.parse(readFileSync(rec, 'utf8')) as { pid: number; lstart: string };
      assert.equal(recorded.pid, Number(readFileSync(join(s.out, 'pid'), 'utf8')));
      assert.ok(recorded.lstart.length > 0);
      assert.throws(() => runKeychainClientSync(request(slow, 'svc-wait')), (err: unknown) => {
        assert.ok(err instanceof KeychainRequestStillWaiting);
        assert.equal((err as KeychainRequestStillWaiting).message, 'a Keychain request for svc-wait is still waiting for an answer');
        return true;
      });
      const other = fake(s, 'printf other', 'other');
      assert.equal(runKeychainClientSync(request(other, 'svc-other')), 'other');
      spawnSync('/bin/sh', ['-c', 'sleep 1.1']);
      assert.equal(runKeychainClientSync(request(other, 'svc-wait')), 'other');
      assert.equal(existsSync(rec), false);
      assert.ok(existsSync(join(s.out, 'after')));
    });
  });

  it('uses one service key in both directions for service-only and account-qualified requests', () => {
    const s = state();
    withState(s, () => {
      const slow = fake(s, 'echo $$ > "$d/pid"\nsleep 1');
      assert.throws(() => runKeychainClientSync(request(slow, 'pi-openrouter', 250)));
      waitFor(join(s.out, 'pid'));
      assert.throws(() => runKeychainClientSync(request(slow, 'pi-openrouter', 500, { account: 'qlb' })), KeychainRequestStillWaiting);
      spawnSync('/bin/sh', ['-c', 'sleep 1.1']);

      assert.throws(() => runKeychainClientSync(request(slow, 'pi-openrouter', 250, { account: 'qlb' })));
      waitFor(join(s.out, 'pid'));
      assert.throws(() => runKeychainClientSync(request(slow, 'pi-openrouter')), KeychainRequestStillWaiting);
    });
  });

  it('(g,h,i,j,k) protects test mode and strips the write value into only the client argv', () => {
    const s = state();
    withState(s, () => {
      assert.throws(() => runKeychainClientSync(request('/usr/bin/security', 'svc-disabled')), KeychainClientDisabledInTests);
      assert.equal(existsSync(join(s.home, '.qlb', 'keychain-waiting')), false);
      const writer = fake(s, 'printf "%s\\n" "$@" > "$d/argv"\ncat > "$d/stdin"');
      const result = keychainClientExec(writer, ['add-generic-password', '-a', 'acct', '-s', 'svc-write', '-X', '6869', '-T', '/x'], { timeout: 2_000, keychainKind: 'security' });
      assert.equal(result, '');
      assert.match(readFileSync(join(s.out, 'argv'), 'utf8'), /-X\n6869\n$/);
      assert.equal(readFileSync(join(s.out, 'stdin'), 'utf8'), '');
      keychainClientExec(writer, ['add-generic-password', '-a', 'acct', '-s', 'svc-empty', '-X', ''], { timeout: 2_000, keychainKind: 'security' });
      assert.match(readFileSync(join(s.out, 'argv'), 'utf8'), /-X\n\n$/);
      assert.throws(() => keychainRequestFromArgv('security', writer, ['add-generic-password', '-s', 'x', '-X', '00', '-X', '00'], { timeoutMs: 1 }), KeychainClientNotStarted);
      assert.throws(() => keychainRequestFromArgv('security', writer, ['probe-read', 'x', 'a'], { timeoutMs: 1 }), KeychainClientNotStarted);
      assert.throws(() => keychainRequestFromArgv('helper', writer, ['find-generic-password', '-s', 'x'], { timeoutMs: 1 }), KeychainClientNotStarted);
      assert.throws(() => (keychainClientExec as unknown as (f: string, a: string[], o: object) => string)(writer, [], { timeout: 1 }), KeychainClientNotStarted);
    });
  });

  it('(m,n,o,p,t,u) fails closed for ps uncertainty, cleans stale records, and has no forbidden imports', () => {
    const s = state();
    withState(s, () => {
      const runner = fake(s, 'echo ran > "$d/ran"');
      // A pre-existing read-only registry fails before the fake can run.
      const registry = join(s.home, '.qlb', 'keychain-waiting');
      execFileSync('/bin/sh', ['-c', 'mkdir -p "$1"', 'sh', registry]);
      chmodSync(registry, 0o500);
      assert.throws(() => runKeychainClientSync(request(runner, 'svc-readonly')), KeychainClientNotStarted);
      chmodSync(registry, 0o700);
      const badPs = fake(s, 'exit 2', 'ps-bad');
      assert.throws(() => runKeychainClientSync(request(runner, 'svc-ps', 500, { psPath: badPs })), KeychainClientNotStarted);
      assert.equal(existsSync(join(s.out, 'ran')), false);

      const rec = recordPath(s.home, 'svc-stale');
      writeFileSync(join(s.home, '.qlb-placeholder'), '');
      // ensure the parent is present without using production helpers
      const dir = join(s.home, '.qlb', 'keychain-waiting');
      execFileSync('/bin/sh', ['-c', 'mkdir -p "$1"', 'sh', dir]);
      writeFileSync(rec, '{bad json');
      assert.doesNotThrow(() => assertNoWaitingClient({ service: 'svc-stale', account: 'any' }));
      assert.equal(existsSync(rec), false);
      writeFileSync(rec, JSON.stringify({ pid: process.pid, lstart: null }));
      assert.throws(() => assertNoWaitingClient({ service: 'svc-stale', account: '' }), KeychainRequestStillWaiting);
      assert.equal(isKeychainStillWaiting(Object.assign(new Error('w'), { cause: new KeychainRequestStillWaiting('s') })), true);
      assert.equal(isKeychainClientNotStarted(new KeychainClientNotStarted('s', 'x')), true);

      const flood = fake(s, 'head -c 2097152 /dev/zero || :\nsleep 2', 'flood');
      assert.throws(() => runKeychainClientSync(request(flood, 'svc-buffer', 2_000, { maxBuffer: 1024 })), (err: unknown) => (err as { code?: unknown }).code === 'ENOBUFS');
      assert.throws(() => runKeychainClientSync(request(flood, 'svc-buffer')), KeychainRequestStillWaiting);
    });
  });

  it('bounds creation-time ps: no client starts or record remains after a stalled ps returns', () => {
    const s = state();
    withState(s, () => {
      const runner = fake(s, 'echo client-started > "$d/started"');
      const sleepyPs = fake(s, 'sleep 3\nprintf "Mon Jan  1 00:00:00 2024\\n"', 'ps-sleepy');
      assert.throws(() => runKeychainClientSync(request(runner, 'svc-ps-bound', 300, { psPath: sleepyPs })), KeychainClientNotStarted);
      spawnSync('/bin/sh', ['-c', 'sleep 3.1']);
      assert.equal(existsSync(join(s.out, 'started')), false);
      assert.equal(existsSync(recordPath(s.home, 'svc-ps-bound')), false);
    });
  });

  it('(r) reports a foreign wrapper signal only after the client closes inherited pipes', () => {
    const s = state();
    withState(s, () => {
      const runner = fake(s, 'echo "$PPID" > "$d/outer-pid"\nsleep 0.4');
      // This test starts the runner's direct wrapper, then its own helper signals it.
      const killer = spawn('/bin/sh', ['-c', 'while [ ! -s "$1" ]; do sleep 0.01; done; kill -KILL "$(cat "$1")"', 'sh', join(s.out, 'outer-pid')]);
      const started = Date.now();
      assert.throws(() => runKeychainClientSync(request(runner, 'svc-foreign', 2_000)), (err: unknown) => {
        const e = err as { code?: unknown; signal?: unknown; writeOutcome?: unknown };
        assert.equal(e.code, 'EQLBKEYCHAINWRAPPERSIGNALLED');
        assert.equal(e.signal, 'SIGKILL');
        assert.equal(e.writeOutcome, 'unknown');
        return true;
      });
      assert.ok(Date.now() - started >= 250, 'spawnSync waited for inherited stdout/stderr EOF');
      void killer;
      assert.equal(existsSync(recordPath(s.home, 'svc-foreign')), true);
      const fast = fake(s, 'printf recovered', 'fast-after-foreign');
      assert.equal(runKeychainClientSync(request(fast, 'svc-foreign')), 'recovered');
    });
  });
});
