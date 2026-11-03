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
  keychainWaitKey,
  keychainRequestFromArgv,
  runKeychainClientSync,
  writeClientRecord,
  type KeychainExecFn,
} from '../src/keychain-client';

/* S1 check mapping: (a,b) fast/error cleanup; (c,d,e,f,s) timeout lifecycle;
 * (g,h,i,j,k) test-mode and secret transport; (l,m,n,o,p,t,u) fail-closed
 * registry/error paths; (q) child-death; (r) foreign wrapper signal; atomic
 * service slot: concurrent child processes; timeout-pipe: never-exiting fake.
 */
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
  return join(home, '.qlb', 'keychain-waiting', `${createHash('sha256').update(keychainWaitKey(service)).digest('hex')}.json`);
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
      const slow = fake(s, 'echo $$ > "$d/pid"\necho run >> "$d/runs"\nsleep 1\necho after > "$d/after"\nprintf v');
      const started = Date.now();
      assert.throws(() => runKeychainClientSync(request(slow, 'svc-wait', 300)), (err: unknown) => (err as { code?: unknown }).code === 'ETIMEDOUT');
      assert.ok(Date.now() - started < 1_500);
      waitFor(join(s.out, 'pid'));
      const rec = recordPath(s.home, 'svc-wait');
      const recorded = JSON.parse(readFileSync(rec, 'utf8')) as { pid: number; lstart: string };
      assert.equal(recorded.pid, Number(readFileSync(join(s.out, 'pid'), 'utf8')));
      assert.ok(recorded.lstart.length > 0);
      const runsBeforeRetry = readFileSync(join(s.out, 'runs'), 'utf8');
      const retryStarted = Date.now();
      assert.throws(() => runKeychainClientSync(request(slow, 'svc-wait')), (err: unknown) => {
        assert.ok(err instanceof KeychainRequestStillWaiting);
        const waiting = err as KeychainRequestStillWaiting;
        assert.equal(waiting.message, 'a Keychain request for svc-wait is still waiting for an answer');
        assert.equal(waiting.code, 'ETIMEDOUT');
        assert.equal(waiting.reason, 'still-waiting');
        return true;
      });
      assert.ok(Date.now() - retryStarted < 200);
      assert.equal(readFileSync(join(s.out, 'runs'), 'utf8'), runsBeforeRetry);
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
      const writer = fake(s, 'printf "%s\\n" "$@" > "$d/argv"\nps -o args= -p "$PPID" > "$d/wrapper-args"\ncat > "$d/stdin"');
      const result = keychainClientExec(writer, ['add-generic-password', '-a', 'acct', '-s', 'svc-write', '-X', '6869', '-T', '/x'], { timeout: 2_000, keychainKind: 'security' });
      assert.equal(result, '');
      assert.match(readFileSync(join(s.out, 'argv'), 'utf8'), /-X\n6869\n$/);
      assert.doesNotMatch(readFileSync(join(s.out, 'wrapper-args'), 'utf8'), /6869/);
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
      assert.doesNotMatch(readFileSync(join(process.cwd(), 'src', 'keychain-client.ts'), 'utf8'), /from '\.\/(credential-backends|keychain)'/);

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

  it('(c,h,j,s) keeps the fake detached, ignores PIPE, and keeps hex off wrapper argv and disk', () => {
    const s = state();
    withState(s, () => {
      const marker = ['SECRET', 'MARKER'].join('-');
      const runner = fake(s, `trap 'echo signal > "$d/signalled"' TERM HUP INT
echo $$ > "$d/pid"
ps -o pgid= -p $$ > "$d/pgid"
ps -o args= -p $PPID > "$d/wrapper-args"
sleep 1
# fd 3 is explicitly closed for the client; ignored SIGPIPE makes this a
# regular failing write rather than a signal termination.
if /usr/bin/printf '%s-%s\\n' a b >&3; then rc=0; else rc=$?; fi
echo "$rc" > "$d/late-rc"
echo after > "$d/after"`);
      assert.throws(() => runKeychainClientSync(request(runner, 'svc-proof', 300)), (err: unknown) => (err as { code?: unknown }).code === 'ETIMEDOUT');
      waitFor(join(s.out, 'pid'));
      const rec = recordPath(s.home, 'svc-proof');
      const record = JSON.parse(readFileSync(rec, 'utf8')) as { pid: number; lstart: string };
      assert.equal(statSync(rec).mode & 0o777, 0o600);
      const liveLstart = execFileSync('/bin/ps', ['-p', String(record.pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).replace(/[\r\n]+$/, '');
      assert.equal(record.lstart, liveLstart);
      const ownPgid = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'pgid='], { encoding: 'utf8' }).trim();
      assert.notEqual(readFileSync(join(s.out, 'pgid'), 'utf8').trim(), ownPgid);
      assert.doesNotMatch(readFileSync(join(s.out, 'wrapper-args'), 'utf8'), /6869/);
      assert.match(readFileSync(join(s.out, 'wrapper-args'), 'utf8'), /qlb-keychain-wait/);
      spawnSync('/bin/sh', ['-c', 'sleep 1.1']);
      assert.equal(existsSync(join(s.out, 'signalled')), false);
      const late = Number(readFileSync(join(s.out, 'late-rc'), 'utf8'));
      assert.notEqual(late, 0); assert.notEqual(late, 141);
      for (const path of [s.home, s.out]) {
        assert.equal(spawnSync('/usr/bin/grep', ['-R', '-l', marker, path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).status, 1);
      }

      const writer = fake(s, 'cat > "$d/stdin-rest"', 'stdin-only');
      const directRecord = join(s.home, '.qlb', 'direct.json');
      const ownerStart = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).replace(/[\r\n]+$/, '');
      writeFileSync(directRecord, JSON.stringify({ pid: process.pid, lstart: ownerStart, state: 'reserving' }), { mode: 0o600 });
      const direct = spawnSync('/bin/sh', ['-c', KEYCHAIN_WAIT_SCRIPT, 'qlb-keychain-wait', 'w', directRecord, '/bin/ps', String(Date.now() + 5_000), String(process.pid), ownerStart, writer], { input: '6869\nTRAILER\n', encoding: 'utf8' });
      assert.equal(direct.status, 0);
      assert.doesNotMatch(readFileSync(directRecord, 'utf8'), /6869/);
      assert.equal(readFileSync(join(s.out, 'stdin-rest'), 'utf8'), '');
    });
  });

  it('(k) validates direct requests, helper writes, and all parser mappings before spawning', () => {
    const s = state();
    withState(s, () => {
      const runner = fake(s, 'echo started > "$d/started"');
      for (const args of [
        ['add-generic-password', '-s', 'x', '-X'], ['add-generic-password', '-s', 'x', '-X', 'zz'],
        ['add-generic-password', '-s', 'x', '-w', 'v', '-X', '00'], ['add-generic-password', '-s', 'x', '-X', '00', 'keychain'],
      ]) assert.throws(() => keychainRequestFromArgv('security', runner, args, { timeoutMs: 1 }), KeychainClientNotStarted);
      const create = keychainRequestFromArgv('security', runner, ['add-generic-password', '-a', 'a', '-s', 's', '-X', '00', '-T', '/x'], { timeoutMs: 1 });
      assert.deepEqual(create.args, ['add-generic-password', '-a', 'a', '-s', 's', '-T', '/x']); assert.equal(create.secretHex, '00');
      assert.equal(keychainRequestFromArgv('security', runner, ['dump-keychain'], { timeoutMs: 1 }).item.service, 'cmd:dump-keychain');
      assert.deepEqual(keychainRequestFromArgv('helper', runner, ['delete', 's', 'a'], { timeoutMs: 1 }).item, { service: 's', account: 'a' });
      assert.throws(() => runKeychainClientSync({ ...request(runner, 'svc-direct'), args: ['find-generic-password', '-Xbad'] }), KeychainClientNotStarted);
      assert.throws(() => runKeychainClientSync({ kind: 'helper', file: runner, args: ['set', 's', 'a'], item: { service: 's', account: 'a' }, timeoutMs: 10, encoding: 'utf8' }), /async runner/);
      assert.throws(() => runKeychainClientSync({ ...request(runner, 'svc-zero'), timeoutMs: 0 }), KeychainClientNotStarted);
      assert.equal(existsSync(join(s.out, 'started')), false);
    });
  });

  it('(m,n,o) closes on malformed ps and proves every stale-record branch', () => {
    const s = state();
    withState(s, () => {
      const runner = fake(s, 'echo ran > "$d/ran"');
      const malformedPs = fake(s, 'printf "Mon \\\"x\\n"', 'ps-malformed');
      assert.throws(() => runKeychainClientSync(request(runner, 'svc-malformed-ps', 500, { psPath: malformedPs })), KeychainClientNotStarted);
      assert.equal(existsSync(join(s.out, 'ran')), false);
      const current = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).replace(/[\r\n]+$/, '');
      const samePs = fake(s, `printf '%s\\n' '${current}'`, 'ps-same');
      const differentPs = fake(s, 'printf "Mon Jan  1 00:00:00 2001\\n"', 'ps-different');
      const statusOne = fake(s, 'exit 1', 'ps-status-one');
      const statusTwo = fake(s, 'exit 2', 'ps-status-two');
      const item = { service: 'svc-stale-branches', account: '' };
      writeClientRecord(item, { pid: process.pid, lstart: current });
      assert.throws(() => assertNoWaitingClient(item, { psPath: samePs }), KeychainRequestStillWaiting);
      assert.doesNotThrow(() => assertNoWaitingClient(item, { psPath: differentPs }));
      assert.equal(existsSync(recordPath(s.home, item.service)), false);
      writeClientRecord(item, { pid: process.pid, lstart: current });
      assert.doesNotThrow(() => assertNoWaitingClient(item, { psPath: statusOne }));
      writeClientRecord(item, { pid: process.pid, lstart: current });
      assert.throws(() => assertNoWaitingClient(item, { psPath: statusTwo }), KeychainRequestStillWaiting);
      writeClientRecord(item, { pid: 999_999, lstart: null });
      assert.doesNotThrow(() => assertNoWaitingClient(item));
    });
  });

  it('atomically reserves one service slot for two concurrent QLB processes', async () => {
    const s = state();
    const runner = fake(s, 'echo started >> "$d/started"\nsleep 0.5');
    const child = join(s.dir, 'caller.cjs');
    writeFileSync(child, `const m=require(process.argv[2]); try { m.runKeychainClientSync(m.keychainRequestFromArgv('security',process.argv[3],['find-generic-password','-s','svc-race'],{timeoutMs:2000})); process.stdout.write('ok') } catch(e) { process.stdout.write(String(e.reason||e.code)) }`);
    const env = { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: s.home, HOME: s.home };
    const leaf = join(process.cwd(), 'dist-test', 'src', 'keychain-client.js');
    const calls = [spawn(process.execPath, [child, leaf, runner], { env }), spawn(process.execPath, [child, leaf, runner], { env })];
    const output = await Promise.all(calls.map((call) => new Promise<string>((resolve) => { let text = ''; call.stdout.on('data', (d) => { text += d; }); call.on('close', () => resolve(text)); })));
    assert.equal(output.filter((value) => value === 'ok').length, 1);
    assert.equal(output.filter((value) => value === 'still-waiting').length, 1);
    assert.equal(readFileSync(join(s.out, 'started'), 'utf8').trim().split('\n').length, 1);
  });

  it('(q) preserves the filled waiting record when the QLB node process dies mid-wait', async () => {
    const s = state();
    const runner = fake(s, 'echo $$ > "$d/pid"\necho started > "$d/started"\nsleep 3');
    const child = join(s.dir, 'die-mid-wait.cjs');
    const leaf = join(process.cwd(), 'dist-test', 'src', 'keychain-client.js');
    writeFileSync(child, `const m=require(process.argv[2]);m.runKeychainClientSync(m.keychainRequestFromArgv('security',process.argv[3],['find-generic-password','-s','svc-death'],{timeoutMs:10000}));`);
    const childNode = spawn(process.execPath, [child, leaf, runner], { env: { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: s.home, HOME: s.home }, stdio: 'ignore' });
    try {
      waitFor(join(s.out, 'started'));
      process.kill(childNode.pid!, 'SIGKILL');
      await new Promise<void>((resolve) => childNode.once('close', () => resolve()));
      withState(s, () => assert.throws(() => runKeychainClientSync(request(runner, 'svc-death')), KeychainRequestStillWaiting));
      const fakePid = Number(readFileSync(join(s.out, 'pid'), 'utf8'));
      assert.doesNotThrow(() => process.kill(fakePid, 0));
    } finally {
      const pidFile = join(s.out, 'pid');
      if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* fake already exited */ } }
    }
  });

  it('returns on timeout even while a fake keeps stdout open, without signalling that fake', () => {
    const s = state();
    withState(s, () => {
      const runner = fake(s, `trap 'echo signal > "$d/signalled"' TERM HUP INT
echo $$ > "$d/pid"
sleep 20`);
      const began = Date.now();
      try {
        assert.throws(() => runKeychainClientSync(request(runner, 'svc-pipe-timeout', 300)), (err: unknown) => (err as { code?: unknown }).code === 'ETIMEDOUT');
        assert.ok(Date.now() - began < 1_800);
        waitFor(join(s.out, 'pid'));
        process.kill(Number(readFileSync(join(s.out, 'pid'), 'utf8')), 'SIGKILL');
        assert.equal(existsSync(join(s.out, 'signalled')), false);
      } finally {
        const pidFile = join(s.out, 'pid');
        if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* fake already exited */ } }
      }
    });
  });
});
