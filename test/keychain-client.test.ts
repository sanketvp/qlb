import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  KEYCHAIN_LOCKF_BIN,
  KEYCHAIN_WAIT_SCRIPT,
  KeychainClientDisabledInTests,
  KeychainClientNotStarted,
  KeychainRequestStillWaiting,
  isKeychainServiceBusy,
  keychainClientExec,
  keychainLockForService,
  keychainRequestFromArgv,
  keychainWaitKey,
  runKeychainClientSync,
  validateRequest,
  type KeychainExecFn,
} from '../src/keychain-client';

/* S1 lockf check mapping: (a,b) fast/status; (c,d,e,f) timeout lifecycle;
 * (g,h,i,j,k) test-mode and secret transport; (q) QLB death; (r) foreign
 * wrapper signal; (s) lock modes; lockf: concurrency, exit-75 distinction,
 * busy probe, and pipe-held timeout.
 */
const positiveExecutor: KeychainExecFn = <T extends 'utf8' | 'buffer' = 'utf8'>(
  _file: string, _args: readonly string[], options: { keychainKind: 'security' | 'helper'; timeout: number; maxBuffer?: number; encoding?: T },
) => (options.encoding === 'buffer' ? Buffer.alloc(0) : '') as T extends 'buffer' ? Buffer : string;
void positiveExecutor;
if (false) {
  // @ts-expect-error keychainKind is mandatory for every executor.
  keychainClientExec('/tmp/no-client', [], { timeout: 1 });
}

function state(): { home: string; dir: string } {
  return { home: mkdtempSync(join(tmpdir(), 'qlb-nokill-home-')), dir: mkdtempSync(join(tmpdir(), 'qlb-nokill-fake-')) };
}

function withState<T>(s: ReturnType<typeof state>, fn: () => T): T {
  const old = { QLB_TEST_MODE: process.env.QLB_TEST_MODE, QLB_HOME: process.env.QLB_HOME, HOME: process.env.HOME };
  Object.assign(process.env, { QLB_TEST_MODE: '1', QLB_HOME: s.home, HOME: s.home });
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}

function fake(s: ReturnType<typeof state>, body: string, name = 'security-fake'): string {
  const path = join(s.dir, name);
  writeFileSync(path, `#!/bin/sh\nset -eu\nd=$(dirname "$0")\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function request(file: string, service: string, timeoutMs = 2_000, account = '') {
  const args = ['find-generic-password', '-s', service];
  if (account) args.push('-a', account);
  return keychainRequestFromArgv('security', file, args, { timeoutMs, encoding: 'utf8' });
}

function lockPath(home: string, service: string): string {
  return join(home, '.qlb', 'keychain-locks', `${createHash('sha256').update(keychainWaitKey(service)).digest('hex')}.lock`);
}

function waitFor(path: string, timeoutMs = 1_500): void {
  const until = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < until) spawnSync('/bin/sh', ['-c', 'sleep 0.02']);
  assert.ok(existsSync(path), `expected ${path}`);
}

function waitForFree(service: string, timeoutMs = 2_000): void {
  const until = Date.now() + timeoutMs;
  while (isKeychainServiceBusy(service) && Date.now() < until) spawnSync('/bin/sh', ['-c', 'sleep 0.02']);
  assert.equal(isKeychainServiceBusy(service), false);
}

function killOwn(path: string): void {
  if (existsSync(path)) {
    try { process.kill(Number(readFileSync(path, 'utf8')), 'SIGKILL'); } catch { /* process already exited */ }
  }
}

// lockf(1) is macOS-only; CI runs on Linux, where these runner tests cannot execute.
const needsLockf = { skip: existsSync(KEYCHAIN_LOCKF_BIN) ? false : 'requires macOS /usr/bin/lockf' };


describe('keychain client lockf runner', () => {
  it('(a,b,s) returns fast output, preserves client status, and creates a permanent private lock file', needsLockf, () => {
    const s = state();
    withState(s, () => {
      const good = fake(s, 'printf "v\\n"');
      assert.equal(runKeychainClientSync(request(good, 'svc-fast')), 'v\n');
      const missing = fake(s, 'echo "could not be found" >&2\nexit 44', 'missing');
      assert.throws(() => runKeychainClientSync(request(missing, 'svc-missing')), (err: unknown) => {
        const e = err as Error & { status?: number };
        assert.equal(e.status, 44); assert.match(e.message, /could not be found/); assert.doesNotMatch(e.message, /svc-missing/); return true;
      });
      const path = lockPath(s.home, 'svc-fast');
      assert.equal(statSync(join(s.home, '.qlb', 'keychain-locks')).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(existsSync(path), true, 'lock file is deliberately never deleted');
      const lock = keychainLockForService('svc-fast');
      assert.equal(lock.outerFile, '/bin/sh');
      assert.deepEqual(lock.outerArgsPrefix.slice(0, 2), ['-c', KEYCHAIN_WAIT_SCRIPT]);
    });
  });

  it('puts locks under .qlb and refuses a symlinked lock directory', () => {
    const s = state();
    withState(s, () => {
      mkdirSync(join(s.home, '.qlb'), { mode: 0o700 });
      symlinkSync(s.dir, join(s.home, '.qlb', 'keychain-locks'));
      assert.throws(() => keychainLockForService('svc-link'), (err: unknown) => (err as { code?: unknown }).code === 'EQLBKEYCHAINDISABLED');
      assert.equal(isKeychainServiceBusy('svc-link'), true, 'the display probe fails closed');
    });
  });

  it('rejects production executable, subcommand, and lockf overrides in a child without spawning a client', () => {
    const leaf = join(process.cwd(), 'dist-test', 'src', 'keychain-client.js');
    const invoke = (requestValue: unknown): string => {
      const env = { ...process.env };
      delete env.QLB_TEST_MODE;
      const result = spawnSync(process.execPath, ['-e', `const m=require(process.argv[1]);try{m.validateRequest(JSON.parse(process.argv[2]));process.stdout.write('accepted')}catch(e){process.stdout.write(String(e.code||e.name))}`, leaf, JSON.stringify(requestValue)], { encoding: 'utf8', env });
      assert.equal(result.status, 0);
      return result.stdout;
    };
    const base = { kind: 'security', file: '/usr/bin/security', args: ['find-generic-password', '-s', 'svc-production'], item: { service: 'svc-production', account: '' }, timeoutMs: 100, encoding: 'utf8' };
    assert.equal(invoke({ ...base, file: '/tmp/not-security' }), 'EQLBKEYCHAINNOTSTARTED');
    assert.equal(invoke({ ...base, args: ['not-allowed', '-s', 'svc-production'] }), 'EQLBKEYCHAINNOTSTARTED');
    assert.equal(invoke({ ...base, lockfPath: '/tmp/not-lockf' }), 'EQLBKEYCHAINNOTSTARTED');
  });

  it('binds the lock service to the exact client arguments', () => {
    const s = state();
    withState(s, () => {
      const client = fake(s, 'exit 0');
      const base = request(client, 'svc-args');
      assert.throws(() => validateRequest({ ...base, item: { service: 'svc-other', account: '' } }), KeychainClientNotStarted);
      assert.throws(() => validateRequest({ ...base, args: ['find-generic-password', '-s', 'svc-args', '-s', 'svc-other'] }), KeychainClientNotStarted);
      assert.throws(() => validateRequest({ kind: 'helper', file: client, args: ['delete', 'svc-args', 'acct', 'extra'], item: { service: 'svc-args', account: 'acct' }, timeoutMs: 100, encoding: 'utf8' }), KeychainClientNotStarted);
      assert.throws(() => validateRequest({ kind: 'helper', file: client, args: ['delete', 'svc-args', 'acct'], secretHex: '6869', item: { service: 'svc-args', account: 'acct' }, timeoutMs: 100, encoding: 'utf8' }), /async runner/);
    });
  });

  it('distinguishes lockf exit 75 from a real client exit 75 by the fd-3 sentinel', needsLockf, () => {
    const s = state();
    withState(s, () => {
      const status75 = fake(s, 'exit 75');
      assert.throws(() => runKeychainClientSync(request(status75, 'svc-client-75')), (err: unknown) => {
        assert.equal((err as { status?: unknown }).status, 75);
        assert.equal(err instanceof KeychainRequestStillWaiting, false);
        return true;
      });
      const hold = fake(s, 'echo $$ > "$d/pid"\nsleep 20', 'hold');
      try {
        assert.throws(() => runKeychainClientSync(request(hold, 'svc-lock-75', 250)), (err: unknown) => (err as { code?: unknown }).code === 'ETIMEDOUT');
        waitFor(join(s.dir, 'pid'));
        assert.throws(() => runKeychainClientSync(request(status75, 'svc-lock-75')), KeychainRequestStillWaiting);
      } finally { killOwn(join(s.dir, 'pid')); }
    });
  });

  it('classifies a pre-start deadline as not-started and preserves unknown timeout writes', needsLockf, () => {
    const s = state();
    withState(s, () => {
      const client = fake(s, 'echo client-ran > "$d/client-ran"');
      const expiredLockf = fake(s, `shell=$5
flag=$6
script=$7
name=$8
mode=$9
shift 10
exec "$shell" "$flag" "$script" "$name" "$mode" 0 "$@"`, 'expired-lockf');
      const expired = { ...request(client, 'svc-expired'), lockfPath: expiredLockf };
      assert.throws(() => runKeychainClientSync(expired), (err: unknown) => {
        assert.equal(err instanceof KeychainClientNotStarted, true);
        assert.equal((err as { writeOutcome?: unknown }).writeOutcome, undefined);
        return true;
      });
      assert.equal(existsSync(join(s.dir, 'client-ran')), false);
      const hold = fake(s, 'echo $$ > "$d/write-pid"\nsleep 20', 'write-hold');
      try {
        const write = keychainRequestFromArgv('security', hold, ['add-generic-password', '-s', 'svc-write-timeout', '-X', '6869'], { timeoutMs: 250 });
        assert.throws(() => runKeychainClientSync(write), (err: unknown) => {
          assert.equal((err as { code?: unknown }).code, 'ETIMEDOUT');
          assert.equal((err as { writeOutcome?: unknown }).writeOutcome, 'unknown');
          return true;
        });
        waitFor(join(s.dir, 'write-pid'));
      } finally { killOwn(join(s.dir, 'write-pid')); }
    });
  });

  it('names non-75 lockf failures rather than calling them still-waiting', () => {
    const s = state();
    withState(s, () => {
      const client = fake(s, 'exit 0');
      const failingLockf = fake(s, 'exit 73', 'failing-lockf');
      assert.throws(() => runKeychainClientSync({ ...request(client, 'svc-lockf-failure'), lockfPath: failingLockf }), (err: unknown) => {
        assert.equal(err instanceof KeychainRequestStillWaiting, false);
        assert.equal((err as { code?: unknown }).code, 'EQLBKEYCHAINWRAPPERNOPROOF');
        return true;
      });
    });
  });

  it('closes the fd-3 sentinel pipe before execing the client', needsLockf, () => {
    const s = state();
    withState(s, () => {
      const client = fake(s, `if ( : >&3 ) 2>/dev/null; then echo open > "$d/fd3"; else echo closed > "$d/fd3"; fi`);
      assert.equal(runKeychainClientSync(request(client, 'svc-fd3')), '');
      assert.equal(readFileSync(join(s.dir, 'fd3'), 'utf8').trim(), 'closed');
    });
  });

  it('(c,d,e,f) times out without signalling the client, blocks only its service, and releases after its exit', needsLockf, () => {
    const s = state();
    withState(s, () => {
      const hold = fake(s, `trap 'echo signal > "$d/signalled"' TERM HUP INT
echo $$ > "$d/pid"
echo run >> "$d/runs"
sleep 20`);
      const fast = fake(s, 'printf recovered', 'fast');
      try {
        const began = Date.now();
        assert.throws(() => runKeychainClientSync(request(hold, 'svc-timeout', 300)), (err: unknown) => (err as { code?: unknown }).code === 'ETIMEDOUT');
        assert.ok(Date.now() - began < 1_800);
        waitFor(join(s.dir, 'pid'));
        assert.equal(isKeychainServiceBusy('svc-timeout'), true);
        const retry = Date.now();
        assert.throws(() => runKeychainClientSync(request(fast, 'svc-timeout')), KeychainRequestStillWaiting);
        assert.ok(Date.now() - retry < 300);
        assert.equal(runKeychainClientSync(request(fast, 'svc-other')), 'recovered');
        killOwn(join(s.dir, 'pid'));
        waitForFree('svc-timeout');
        assert.equal(existsSync(join(s.dir, 'signalled')), false);
        assert.equal(runKeychainClientSync(request(fast, 'svc-timeout')), 'recovered');
      } finally { killOwn(join(s.dir, 'pid')); }
    });
  });

  it('uses one service lock for service-only and account-qualified requests in both directions', needsLockf, () => {
    const s = state();
    withState(s, () => {
      const hold = fake(s, 'echo $$ > "$d/pid"\nsleep 20');
      const fast = fake(s, 'printf ok', 'fast');
      try {
        assert.throws(() => runKeychainClientSync(request(hold, 'svc-scope', 250)), (err: unknown) => (err as { code?: unknown }).code === 'ETIMEDOUT');
        waitFor(join(s.dir, 'pid'));
        assert.throws(() => runKeychainClientSync(request(fast, 'svc-scope', 500, 'acct')), KeychainRequestStillWaiting);
        killOwn(join(s.dir, 'pid')); waitForFree('svc-scope');
        assert.throws(() => runKeychainClientSync(request(hold, 'svc-scope', 250, 'acct')), (err: unknown) => (err as { code?: unknown }).code === 'ETIMEDOUT');
        assert.throws(() => runKeychainClientSync(request(fast, 'svc-scope')), KeychainRequestStillWaiting);
      } finally { killOwn(join(s.dir, 'pid')); }
    });
  });

  it('(g,h,i,j,k) refuses real clients and keeps the write hex off lockf and shell argv', needsLockf, () => {
    const s = state();
    withState(s, () => {
      assert.throws(() => runKeychainClientSync(request('/usr/bin/security', 'svc-disabled')), KeychainClientDisabledInTests);
      assert.equal(existsSync(join(s.home, '.qlb', 'keychain-locks')), false);
      const realHelper = fake(s, 'exit 0', 'qlb-keychain-helper');
      assert.throws(() => runKeychainClientSync(keychainRequestFromArgv('helper', realHelper, ['delete', 's', 'a'], { timeoutMs: 10 })), KeychainClientDisabledInTests);
      const writer = fake(s, 'printf "%s\\n" "$@" > "$d/argv"\nps -o args= -p "$PPID" > "$d/lockf-args"\nouter=$(ps -o ppid= -p "$PPID" | tr -d " ")\nps -o args= -p "$outer" > "$d/outer-shell-args"\ncat > "$d/stdin"');
      assert.equal(keychainClientExec(writer, ['add-generic-password', '-a', 'acct', '-s', 'svc-write', '-X', '6869'], { timeout: 2_000, keychainKind: 'security' }), '');
      assert.match(readFileSync(join(s.dir, 'argv'), 'utf8'), /-X\n6869\n$/);
      assert.doesNotMatch(readFileSync(join(s.dir, 'lockf-args'), 'utf8'), /6869/);
      assert.doesNotMatch(readFileSync(join(s.dir, 'outer-shell-args'), 'utf8'), /6869/);
      assert.equal(readFileSync(join(s.dir, 'stdin'), 'utf8'), '');
      assert.equal(spawnSync('/usr/bin/grep', ['-R', '-l', '6869', join(s.home, '.qlb', 'keychain-locks')], { stdio: 'ignore' }).status, 1);
      assert.throws(() => runKeychainClientSync({ ...request(writer, 'svc-direct'), args: ['find-generic-password', '-UXoops'] }), KeychainClientNotStarted);
      assert.throws(() => runKeychainClientSync({ ...request(writer, 'svc-direct'), secretHex: '6869', args: ['add-generic-password', '-w', '6869'] }), KeychainClientNotStarted);
      assert.throws(() => runKeychainClientSync({ kind: 'helper', file: writer, args: ['set', 's', 'a'], item: { service: 's', account: 'a' }, timeoutMs: 10, encoding: 'utf8' }), /async runner/);
      assert.throws(() => keychainRequestFromArgv('security', writer, ['add-generic-password', '-s', 'x', '-X', '00', '-X', '00'], { timeoutMs: 1 }), KeychainClientNotStarted);
      assert.throws(() => keychainRequestFromArgv('security', writer, ['add-generic-password', '-s', 'x', '-w', '00'], { timeoutMs: 1 }), KeychainClientNotStarted);
    });
  });

  it('(j) consumes only the write hex line and gives the client /dev/null stdin', needsLockf, () => {
    const s = state();
    withState(s, () => {
      const writer = fake(s, 'cat > "$d/stdin-rest"');
      const lock = keychainLockForService('svc-pipe');
      const direct = spawnSync('/bin/sh', ['-c', KEYCHAIN_WAIT_SCRIPT, 'qlb-keychain-wait', KEYCHAIN_LOCKF_BIN, lock.lockPath, 'w', String(Date.now() + 5_000), writer], { input: '6869\nTRAILER\n', encoding: 'utf8' });
      assert.equal(direct.status, 0);
      assert.equal(readFileSync(join(s.dir, 'stdin-rest'), 'utf8'), '');
    });
  });

  it('atomically allows exactly one of two concurrent QLB processes to start a service client', needsLockf, async () => {
    const s = state();
    const runner = fake(s, 'echo started >> "$d/started"\nsleep 0.5');
    const caller = join(s.dir, 'caller.cjs');
    const leaf = join(process.cwd(), 'dist-test', 'src', 'keychain-client.js');
    writeFileSync(caller, `const m=require(process.argv[2]);try{m.runKeychainClientSync(m.keychainRequestFromArgv('security',process.argv[3],['find-generic-password','-s','svc-race'],{timeoutMs:2000}));process.stdout.write('ok')}catch(e){process.stdout.write(String(e.reason||e.code))}`);
    const env = { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: s.home, HOME: s.home };
    const calls = [spawn(process.execPath, [caller, leaf, runner], { env }), spawn(process.execPath, [caller, leaf, runner], { env })];
    const result = await Promise.all(calls.map((call) => new Promise<string>((resolve) => { let out = ''; call.stdout.on('data', (chunk) => { out += chunk; }); call.once('close', () => resolve(out)); })));
    assert.deepEqual(result.sort(), ['ok', 'still-waiting']);
    assert.equal(readFileSync(join(s.dir, 'started'), 'utf8').trim().split('\n').length, 1);
  });

  it('(q) keeps lockf holding the service lock after the QLB process is SIGKILLed, then releases it', needsLockf, async () => {
    const s = state();
    const runner = fake(s, 'echo $$ > "$d/pid"\necho started > "$d/started"\nsleep 20');
    const caller = join(s.dir, 'die.cjs');
    const leaf = join(process.cwd(), 'dist-test', 'src', 'keychain-client.js');
    writeFileSync(caller, `const m=require(process.argv[2]);m.runKeychainClientSync(m.keychainRequestFromArgv('security',process.argv[3],['find-generic-password','-s','svc-death'],{timeoutMs:10000}));`);
    const child = spawn(process.execPath, [caller, leaf, runner], { env: { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: s.home, HOME: s.home }, stdio: 'ignore' });
    try {
      waitFor(join(s.dir, 'started'));
      process.kill(child.pid!, 'SIGKILL');
      await new Promise<void>((resolve) => child.once('close', () => resolve()));
      assert.equal(withState(s, () => isKeychainServiceBusy('svc-death')), true);
      killOwn(join(s.dir, 'pid'));
      withState(s, () => waitForFree('svc-death'));
    } finally { killOwn(join(s.dir, 'pid')); }
  });

  it('(r) retains the lock after a foreign outer-wrapper SIGKILL until the client exits', needsLockf, async () => {
    const s = state();
    const runner = fake(s, 'outer=$(ps -o ppid= -p "$PPID" | tr -d " ")\necho "$outer" > "$d/outer"\nsleep 1');
    const caller = join(s.dir, 'foreign.cjs');
    const leaf = join(process.cwd(), 'dist-test', 'src', 'keychain-client.js');
    writeFileSync(caller, `const m=require(process.argv[2]);try{m.runKeychainClientSync(m.keychainRequestFromArgv('security',process.argv[3],['add-generic-password','-s','svc-foreign','-X','6869'],{timeoutMs:5000}))}catch(e){process.stdout.write(String(e.code||'')+':'+String(e.writeOutcome||''))}`);
    const child = spawn(process.execPath, [caller, leaf, runner], { env: { ...process.env, QLB_TEST_MODE: '1', QLB_HOME: s.home, HOME: s.home } });
    waitFor(join(s.dir, 'outer'));
    process.kill(Number(readFileSync(join(s.dir, 'outer'), 'utf8')), 'SIGKILL');
    assert.equal(withState(s, () => isKeychainServiceBusy('svc-foreign')), true);
    const output = await new Promise<string>((resolve) => { let out = ''; child.stdout.on('data', (chunk) => { out += chunk; }); child.once('close', () => resolve(out)); });
    assert.equal(output, 'EQLBKEYCHAINWRAPPERSIGNALLED:unknown');
    withState(s, () => waitForFree('svc-foreign', 2_500));
  });

  it('returns within timeout while a fake holds stdout open, leaving it unsignalled', needsLockf, () => {
    const s = state();
    withState(s, () => {
      const hold = fake(s, `trap 'echo signal > "$d/signalled"' TERM HUP INT
echo $$ > "$d/pid"
sleep 20`);
      try {
        const began = Date.now();
        assert.throws(() => runKeychainClientSync(request(hold, 'svc-pipe-timeout', 300)), (err: unknown) => (err as { code?: unknown }).code === 'ETIMEDOUT');
        assert.ok(Date.now() - began < 1_800);
        waitFor(join(s.dir, 'pid'));
        assert.equal(existsSync(join(s.dir, 'signalled')), false);
      } finally { killOwn(join(s.dir, 'pid')); }
    });
  });
});
