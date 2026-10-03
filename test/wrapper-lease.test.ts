import assert from 'node:assert/strict';
import {
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const ROOT = join(__dirname, '..', '..');
const CLI = join(__dirname, '..', 'src', 'cli.js');
const MUTEX = join(ROOT, 'harness', 'qlb-proxy-mutex');
const WRAPPER = join(ROOT, 'harness', 'claude');

const temps: string[] = [];
const children: ChildProcess[] = [];
const ports: number[] = [];

function closePipes(child: ChildProcess): void {
  try { child.stdout?.destroy(); } catch { /* ignore */ }
  try { child.stderr?.destroy(); } catch { /* ignore */ }
  try { child.stdin?.destroy(); } catch { /* ignore */ }
}

function pidsFromOutput(stdout: string): number[] {
  return stdout.split('\n').map((line) => Number(line.trim())).filter((n) => Number.isInteger(n) && n > 1);
}

function pidsOnPort(port: number): number[] {
  const r = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
  return pidsFromOutput(r.stdout || '');
}

function pidsReferencing(path: string): number[] {
  const r = spawnSync('lsof', ['-t', path], { encoding: 'utf8' });
  return pidsFromOutput(r.stdout || '');
}

function fixtureProxyProcs(dir: string): Array<{ pid: number; cmd: string }> {
  const r = spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
  const out: Array<{ pid: number; cmd: string }> = [];
  for (const line of (r.stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    if (sp <= 0) continue;
    const pid = Number(trimmed.slice(0, sp));
    const cmd = trimmed.slice(sp + 1);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    if (!cmd.includes(dir)) continue;
    if (cmd.includes('proxy --') || cmd.includes('cli.js proxy') || cmd.includes('fake-claude')) {
      out.push({ pid, cmd });
    }
  }
  return out;
}

function killPid(pid: number): void {
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
}

function reapDir(dir: string, port?: number): void {
  if (typeof port === 'number') {
    for (const pid of pidsOnPort(port)) killPid(pid);
  }
  const info = join(dir, 'proxy.json');
  if (existsSync(info)) {
    for (const pid of pidsReferencing(info)) killPid(pid);
  }
  for (const proc of fixtureProxyProcs(dir)) killPid(proc.pid);
}

async function portIsClosed(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.once('connect', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('error', () => resolve(true));
  });
}

async function assertCaseQuiet(dir: string, port: number): Promise<void> {
  const info = join(dir, 'proxy.json');
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const listening = !(await portIsClosed(port));
    const refs = existsSync(info) ? pidsReferencing(info) : [];
    const procs = fixtureProxyProcs(dir).filter((p) => p.cmd.includes('proxy'));
    if (!listening && refs.length === 0 && procs.length === 0) return;
    await delay(50);
  }
  reapDir(dir, port);
  assert.fail(`fixture still live for ${dir} port ${port}`);
}

after(() => {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    closePipes(child);
  }
  const leftover: Array<{ pid: number; cmd: string }> = [];
  for (const dir of temps) {
    leftover.push(...fixtureProxyProcs(dir).filter((p) => p.cmd.includes('cli.js proxy') || /\sproxy\s+--/.test(p.cmd)));
    reapDir(dir);
  }
  for (const port of ports) {
    for (const pid of pidsOnPort(port)) killPid(pid);
  }
  try {
    assert.equal(
      leftover.length,
      0,
      `fixture proxy processes remained: ${leftover.map((p) => `${p.pid} ${p.cmd}`).join('; ')}`,
    );
  } finally {
    for (const dir of temps) {
      spawnSync('rm', ['-rf', dir]);
    }
  }
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-wrapper-'));
  temps.push(dir);
  return dir;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => {
        ports.push(port);
        resolve(port);
      });
    });
  });
}

function writeFakeClaude(dir: string): string {
  const path = join(dir, 'fake-claude');
  writeFileSync(
    path,
    `#!/usr/bin/python3
import os, signal, subprocess, sys, time, urllib.error, urllib.request
print("ANTHROPIC_BASE_URL=" + os.environ.get("ANTHROPIC_BASE_URL", ""), flush=True)
print("HAS_AUTH_TOKEN=" + ("1" if "ANTHROPIC_AUTH_TOKEN" in os.environ else "0"), flush=True)
print("HAS_API_KEY=" + ("1" if "ANTHROPIC_API_KEY" in os.environ else "0"), flush=True)
print("HAS_HELPER=" + ("1" if os.environ.get("CLAUDE_CODE_API_KEY_HELPER") else "0"), flush=True)
if "--exit" in sys.argv:
    sys.exit(int(sys.argv[sys.argv.index("--exit") + 1]))
if "--exit-on-file" in sys.argv:
    gate = sys.argv[sys.argv.index("--exit-on-file") + 1]
    while not os.path.exists(gate):
        time.sleep(0.05)
    sys.exit(0)
if "--wait-signal" in sys.argv:
    def handle(signum, _frame):
        sys.exit(128 + signum)
    signal.signal(signal.SIGINT, handle)
    signal.signal(signal.SIGTERM, handle)
    time.sleep(60)
    sys.exit(0)
if "--request-health" in sys.argv:
    helper = os.environ.get("CLAUDE_CODE_API_KEY_HELPER") or ""
    base = os.environ.get("ANTHROPIC_BASE_URL") or ""
    token = ""
    if helper:
        token = subprocess.check_output([helper], text=True, env=os.environ).strip()
    host = base.split("://", 1)[-1]
    req = urllib.request.Request(
        base.rstrip("/") + "/qlb/health",
        headers={"Authorization": "Bearer " + token, "Host": host},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            print("PROXY_STATUS=" + str(getattr(resp, "status", 200)), flush=True)
            print("HELPER_USED=" + ("1" if helper else "0"), flush=True)
            sys.exit(0)
    except (urllib.error.URLError, TimeoutError, OSError):
        print("PROXY_STATUS=0", flush=True)
        sys.exit(1)
sys.exit(0)
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function envFor(home: string, port: number, fake: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QLB_HOME: home,
    QLB_PROXY_PORT: String(port),
    QLB_PROXY_INFO_PATH: join(home, 'proxy.json'),
    QLB_DB_PATH: join(home, 'qlb.db'),
    QLB_BIN: CLI,
    QLB_NODE: process.execPath,
    QLB_CLAUDE_NATIVE: fake,
    QLB_PLUGINS_DIR: join(home, 'plugins'),
    QLB_ANTHROPIC_POOL_PATH: join(home, 'missing-pool.json'),
    QLB_CSWAP_SEQUENCE_PATH: join(home, 'missing-seq.json'),
    QLB_CSWAP_USAGE_PATH: join(home, 'missing-usage.json'),
    ...extra,
  };
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function spawnTracked(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string }): ChildProcess {
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.on('exit', () => closePipes(child));
  return child;
}

function collect(child: ChildProcess): { stdout: string; stderr: string } {
  const out = { stdout: '', stderr: '' };
  child.stdout?.on('data', (c: Buffer) => { out.stdout += c.toString('utf8'); });
  child.stderr?.on('data', (c: Buffer) => { out.stderr += c.toString('utf8'); });
  return out;
}

function waitExit(child: ChildProcess, timeoutMs = 15_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      closePipes(child);
      reject(new Error('timeout waiting for exit'));
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(t);
      closePipes(child);
      if (typeof code === 'number') resolve(code);
      else resolve(128);
    });
    child.on('error', (err) => {
      clearTimeout(t);
      closePipes(child);
      reject(err);
    });
  });
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    await delay(40);
  }
  throw new Error(`timeout waiting for ${path}`);
}

async function waitFor(pred: () => boolean, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await delay(40);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function health(port: number, token: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/qlb/health',
        method: 'GET',
        headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', () => resolve(0));
    req.end();
  });
}

describe('wrapper / mutex / proxy lifecycle', () => {
  it('mutex-inherited-lock', async () => {
    const dir = tmp();
    const lock = join(dir, 'proxy.lock');
    const fifo = join(dir, 'hold.fifo');
    spawnSync('mkfifo', [fifo]);
    const child = spawnTracked('/usr/bin/python3', [MUTEX, lock, '--', '/bin/sh', '-c', 'echo LOCKED; exec cat "$1"', 'sh', fifo], {
      env: process.env,
    });
    const out = collect(child);
    await waitFor(() => out.stdout.includes('LOCKED'), 5_000, 'LOCKED');
    const blocked = spawnSync('/usr/bin/python3', ['-c', `
import fcntl, os, sys
fd = os.open(${JSON.stringify(lock)}, os.O_RDWR)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print('UNEXPECTED_ACQUIRE')
    sys.exit(2)
except BlockingIOError:
    print('EWOULDBLOCK')
    sys.exit(0)
`], { encoding: 'utf8' });
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.match(blocked.stdout, /EWOULDBLOCK/);
    writeFileSync(fifo, 'x');
    await waitExit(child, 5_000);
  });

  it('mutex-released-while-child-alive', async () => {
    const dir = tmp();
    const lock = join(dir, 'proxy.lock');
    const script = join(dir, 'critical.py');
    writeFileSync(script, `
import os, subprocess, sys, time
child = subprocess.Popen(["sleep", "30"], close_fds=True)
fd = int(os.environ.get("QLB_PROXY_LOCK_FD", "0"))
if fd:
    os.close(fd)
print("STARTED " + str(child.pid), flush=True)
time.sleep(8)
child.kill()
`);
    const crit = spawnTracked('/usr/bin/python3', [MUTEX, lock, '--', '/usr/bin/python3', script], {
      env: process.env,
    });
    const out = collect(crit);
    await waitFor(() => out.stdout.includes('STARTED '), 5_000, 'STARTED');
    const startedLine = out.stdout.split('\n').find((line) => line.startsWith('STARTED '));
    const childPid = startedLine ? Number(startedLine.slice('STARTED '.length).trim()) : 0;
    assert.ok(childPid > 0);
    const second = spawnSync('/usr/bin/python3', ['-c', `
import fcntl, os, sys
fd = os.open(${JSON.stringify(lock)}, os.O_RDWR)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
print('SECOND_ACQUIRED')
`], { encoding: 'utf8', timeout: 3_000 });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /SECOND_ACQUIRED/);
    try { process.kill(childPid, 'SIGKILL'); } catch { /* ignore */ }
    try { crit.kill('SIGKILL'); } catch { /* ignore */ }
    await waitExit(crit, 5_000).catch(() => undefined);
  });

  it('direct-second-start', async () => {
    const dir = tmp();
    const port = await freePort();
    const info = join(dir, 'proxy.json');
    const env = envFor(dir, port, writeFakeClaude(dir));
    const first = spawnTracked(process.execPath, [CLI, 'proxy', '--port', String(port), '--no-idle', '--info-path', info, '--db', join(dir, 'qlb.db')], { env });
    collect(first);
    await waitForFile(info, 8_000);
    const before = readFileSync(info);
    const second = spawnSync(process.execPath, [CLI, 'proxy', '--port', String(port), '--no-idle', '--info-path', info, '--db', join(dir, 'qlb.db')], {
      env,
      encoding: 'utf8',
      timeout: 8_000,
    });
    assert.notEqual(second.status, 0);
    const afterBytes = readFileSync(info);
    assert.deepEqual(afterBytes, before);
    first.kill('SIGTERM');
    await waitExit(first, 5_000).catch(() => undefined);
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-attach-sequential', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'proxy-leases'), { recursive: true });
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const env = envFor(dir, port, fake);
    const w1 = spawnTracked('/usr/bin/python3', [WRAPPER, '--wait-signal'], { env });
    const o1 = collect(w1);
    await waitForFile(join(dir, 'proxy.json'), 10_000);
    const info = JSON.parse(readFileSync(join(dir, 'proxy.json'), 'utf8')) as { token: string; port: number };
    const w2 = spawnTracked('/usr/bin/python3', [WRAPPER, '--wait-signal'], { env });
    const o2 = collect(w2);
    await delay(500);
    const h1 = await health(port, info.token);
    const h2 = await health(port, info.token);
    assert.equal(h1, 200);
    assert.equal(h2, 200);
    const again = JSON.parse(readFileSync(join(dir, 'proxy.json'), 'utf8')) as { token: string };
    assert.equal(again.token, info.token);
    w1.kill('SIGTERM');
    w2.kill('SIGTERM');
    await Promise.all([waitExit(w1, 8_000), waitExit(w2, 8_000)]);
    void o1;
    void o2;
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-attach-simultaneous', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'proxy-leases'), { recursive: true });
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const env = envFor(dir, port, fake);
    const w1 = spawnTracked('/usr/bin/python3', [WRAPPER, '--wait-signal'], { env });
    const w2 = spawnTracked('/usr/bin/python3', [WRAPPER, '--wait-signal'], { env });
    const o1 = collect(w1);
    const o2 = collect(w2);
    await waitForFile(join(dir, 'proxy.json'), 12_000);
    await waitFor(
      () => o1.stdout.includes('ANTHROPIC_BASE_URL=') && o2.stdout.includes('ANTHROPIC_BASE_URL='),
      10_000,
      'both children',
    );
    await waitFor(() => {
      try {
        const info = JSON.parse(readFileSync(join(dir, 'proxy.json'), 'utf8')) as { token: string };
        return typeof info.token === 'string' && info.token.length > 0;
      } catch {
        return false;
      }
    }, 12_000, 'token');
    const info = JSON.parse(readFileSync(join(dir, 'proxy.json'), 'utf8')) as { token: string };
    const status = await health(port, info.token);
    assert.equal(status, 200);
    w1.kill('SIGTERM');
    w2.kill('SIGTERM');
    const codes = await Promise.all([waitExit(w1, 10_000), waitExit(w2, 10_000)]);
    assert.ok(
      codes.every((c) => c === 143 || c === 0 || c === 130 || c === 1),
      `exit codes ${codes.join(',')}`,
    );
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-normal-exit', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'proxy-leases'), { recursive: true });
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const env = envFor(dir, port, fake);
    const w = spawnTracked('/usr/bin/python3', [WRAPPER, '--exit', '7'], { env });
    collect(w);
    const code = await waitExit(w, 12_000);
    assert.equal(code, 7);
    const leases = join(dir, 'proxy-leases');
    const leftover = existsSync(leases)
      ? spawnSync('ls', [leases], { encoding: 'utf8' }).stdout.trim()
      : '';
    assert.equal(leftover, '');
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-sigint', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'proxy-leases'), { recursive: true });
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const env = envFor(dir, port, fake);
    const w = spawnTracked('/usr/bin/python3', [WRAPPER, '--wait-signal'], { env });
    const out = collect(w);
    await waitForFile(join(dir, 'proxy.json'), 10_000);
    await delay(200);
    w.kill('SIGINT');
    const code = await waitExit(w, 8_000);
    assert.equal(code, 130);
    console.log(out.stdout.includes('SIGNAL=INT') ? 'SIGNAL=INT' : out.stdout);
    assert.match(out.stdout, /SIGNAL=INT/);
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-sigterm', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'proxy-leases'), { recursive: true });
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const env = envFor(dir, port, fake);
    const w = spawnTracked('/usr/bin/python3', [WRAPPER, '--wait-signal'], { env });
    const out = collect(w);
    await waitForFile(join(dir, 'proxy.json'), 10_000);
    await delay(200);
    w.kill('SIGTERM');
    const code = await waitExit(w, 8_000);
    assert.equal(code, 143);
    console.log(out.stdout.includes('SIGNAL=TERM') ? 'SIGNAL=TERM' : out.stdout);
    assert.match(out.stdout, /SIGNAL=TERM/);
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-stale-lease', async () => {
    const dir = tmp();
    const leases = join(dir, 'proxy-leases');
    mkdirSync(leases, { recursive: true });
    writeFileSync(join(leases, '1'), JSON.stringify({ pid: 1, lstart: 'never', session: 'x', startedAt: 1 }));
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const env = envFor(dir, port, fake);
    const w = spawnTracked('/usr/bin/python3', [WRAPPER, '--exit', '0'], { env });
    collect(w);
    await waitExit(w, 12_000);
    assert.equal(existsSync(join(leases, '1')), false);
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-pid-reuse', async () => {
    const dir = tmp();
    const leases = join(dir, 'proxy-leases');
    mkdirSync(leases, { recursive: true });
    writeFileSync(join(leases, String(process.pid)), JSON.stringify({
      pid: process.pid,
      lstart: 'not-the-real-lstart',
      session: 'x',
      startedAt: 1,
    }));
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const env = envFor(dir, port, fake);
    const w = spawnTracked('/usr/bin/python3', [WRAPPER, '--exit', '0'], { env });
    const out = collect(w);
    await waitExit(w, 12_000);
    console.log(out.stdout.includes('PID_REUSE_REAP=1') ? 'PID_REUSE_REAP=1' : out.stdout);
    assert.match(out.stdout, /PID_REUSE_REAP=1/);
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-death-before-ownership', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'proxy-leases'), { recursive: true });
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const marker = join(dir, 'pause-listen');
    const env = envFor(dir, port, fake, { QLB_PROXY_PAUSE_AFTER_LISTEN: marker });
    const w1 = spawnTracked('/usr/bin/python3', [WRAPPER, '--wait-signal'], { env });
    collect(w1);
    await waitForFile(marker, 10_000);
    await delay(150);
    assert.equal(existsSync(join(dir, 'proxy.json')), false);
    const kids = spawnSync('pgrep', ['-P', String(w1.pid)], { encoding: 'utf8' });
    w1.kill('SIGKILL');
    for (const line of kids.stdout.split('\n')) {
      const pid = Number(line.trim());
      if (pid > 1) killPid(pid);
    }
    await delay(150);
    const w2 = spawnTracked('/usr/bin/python3', [WRAPPER, '--exit', '0'], { env: envFor(dir, port, fake) });
    const o2 = collect(w2);
    const code = await waitExit(w2, 8_000);
    assert.notEqual(code, 0);
    console.log(o2.stdout.includes('ORPHAN_LISTEN=fail-closed') ? 'ORPHAN_LISTEN=fail-closed' : o2.stdout);
    assert.match(o2.stdout, /ORPHAN_LISTEN=fail-closed/);
    for (const pid of pidsOnPort(port)) killPid(pid);
    try { unlinkSync(marker); } catch { /* ignore */ }
    await waitExit(w1, 5_000).catch(() => undefined);
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-forced-death', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'proxy-leases'), { recursive: true });
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const env = envFor(dir, port, fake);
    const w1 = spawnTracked('/usr/bin/python3', [WRAPPER, '--wait-signal'], { env });
    collect(w1);
    await waitForFile(join(dir, 'proxy.json'), 10_000);
    w1.kill('SIGKILL');
    await waitExit(w1, 5_000).catch(() => undefined);
    const w2 = spawnTracked('/usr/bin/python3', [WRAPPER, '--exit', '0'], { env });
    collect(w2);
    const code = await waitExit(w2, 12_000);
    assert.equal(code, 0);
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-final-shutdown', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'proxy-leases'), { recursive: true });
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const env = envFor(dir, port, fake);
    const w = spawnTracked('/usr/bin/python3', [WRAPPER, '--exit', '0'], { env });
    collect(w);
    await waitExit(w, 12_000);
    await delay(400);
    assert.equal(existsSync(join(dir, 'proxy.json')), false);
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-orphan-cleanup', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'proxy-leases'), { recursive: true });
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const env = envFor(dir, port, fake);
    const w1 = spawnTracked('/usr/bin/python3', [WRAPPER, '--wait-signal'], { env });
    collect(w1);
    await waitForFile(join(dir, 'proxy.json'), 10_000);
    w1.kill('SIGKILL');
    await waitExit(w1, 5_000).catch(() => undefined);
    const w2 = spawnTracked('/usr/bin/python3', [WRAPPER, '--exit', '0'], { env });
    const o2 = collect(w2);
    await waitExit(w2, 12_000);
    console.log(o2.stdout.includes('ORPHAN_CLEANUP=1') ? 'ORPHAN_CLEANUP=1' : o2.stdout);
    assert.match(o2.stdout, /ORPHAN_CLEANUP=1/);
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-passthrough', async () => {
    const dir = tmp();
    const fake = writeFakeClaude(dir);
    const env = envFor(dir, 47391, fake);
    for (const arg of ['plugin', 'update', '--version']) {
      const r = spawnSync('/usr/bin/python3', [WRAPPER, arg], { env, encoding: 'utf8', timeout: 5_000 });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /ANTHROPIC_BASE_URL=$/m);
    }
  });

  it('wrapper-claude-requests-proxy-with-helper', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'proxy-leases'), { recursive: true });
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const env = envFor(dir, port, fake);
    const w = spawnTracked('/usr/bin/python3', [WRAPPER, '--request-health'], { env });
    const out = collect(w);
    const code = await waitExit(w, 15_000);
    assert.equal(code, 0, out.stderr + out.stdout);
    assert.match(out.stdout, /HAS_AUTH_TOKEN=0/);
    assert.match(out.stdout, /HAS_HELPER=1/);
    assert.match(out.stdout, /HELPER_USED=1/);
    assert.match(out.stdout, /PROXY_STATUS=200/);
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-native-launch-failure', async () => {
    for (const variant of ['missing', 'not-executable'] as const) {
      const dir = tmp();
      const leases = join(dir, 'proxy-leases');
      mkdirSync(leases, { recursive: true });
      const port = await freePort();
      const native = join(dir, 'no-such-claude');
      if (variant === 'not-executable') writeFileSync(native, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
      const env = envFor(dir, port, native);
      const w = spawnTracked('/usr/bin/python3', [WRAPPER, '--wait-signal'], { env });
      const out = collect(w);
      const code = await waitExit(w, 15_000);
      assert.equal(code, variant === 'missing' ? 127 : 126, out.stderr + out.stdout);
      assert.match(out.stderr, /cannot launch/);
      assert.equal(spawnSync('ls', [leases], { encoding: 'utf8' }).stdout.trim(), '');
      assert.equal(existsSync(join(dir, 'proxy.json')), false);
      await assertCaseQuiet(dir, port);
    }
  });

  it('wrapper-shutdown-stuck-proxy', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'proxy-leases'), { recursive: true });
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const env = envFor(dir, port, fake);
    const w = spawnTracked('/usr/bin/python3', [WRAPPER, '--wait-signal'], { env });
    const out = collect(w);
    await waitForFile(join(dir, 'proxy.json'), 10_000);
    await waitFor(() => out.stdout.includes('ANTHROPIC_BASE_URL='), 8_000, 'child');
    const info = JSON.parse(readFileSync(join(dir, 'proxy.json'), 'utf8')) as { pid: number };
    // A request whose headers never finish keeps server.close() pending past the grace period.
    const held = net.connect({ host: '127.0.0.1', port });
    await new Promise<void>((resolve) => held.once('connect', () => resolve()));
    held.write(`GET /qlb/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
    held.on('error', () => undefined);
    try {
      w.kill('SIGTERM');
      const code = await waitExit(w, 15_000);
      assert.equal(code, 143);
      assert.match(out.stdout, /PROXY_SIGKILL=1/);
      let alive = true;
      try { process.kill(info.pid, 0); } catch { alive = false; }
      assert.equal(alive, false, 'proxy process must be gone before metadata is removed');
      assert.equal(existsSync(join(dir, 'proxy.json')), false);
      await assertCaseQuiet(dir, port);
    } finally {
      held.destroy();
    }
  });

  it('wrapper-signal-before-launch', async () => {
    const dir = tmp();
    const leases = join(dir, 'proxy-leases');
    mkdirSync(leases, { recursive: true });
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const marker = join(dir, 'pause-launch');
    const env = envFor(dir, port, fake, { QLB_WRAPPER_PAUSE_BEFORE_LAUNCH: marker });
    const w = spawnTracked('/usr/bin/python3', [WRAPPER, '--wait-signal'], { env });
    const out = collect(w);
    await waitForFile(marker, 10_000);
    w.kill('SIGTERM');
    const code = await waitExit(w, 10_000);
    assert.equal(code, 143);
    assert.match(out.stdout, /SIGNAL=TERM/);
    assert.doesNotMatch(out.stdout, /ANTHROPIC_BASE_URL=/, 'native must not start after an early signal');
    assert.equal(spawnSync('ls', [leases], { encoding: 'utf8' }).stdout.trim(), '');
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-signal-during-proxy-setup', async () => {
    const dir = tmp();
    const leases = join(dir, 'proxy-leases');
    mkdirSync(leases, { recursive: true });
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const marker = join(dir, 'pause-listen');
    const env = envFor(dir, port, fake, { QLB_PROXY_PAUSE_AFTER_LISTEN: marker });
    const w = spawnTracked('/usr/bin/python3', [WRAPPER, '--wait-signal'], { env });
    const out = collect(w);
    // The critical section is now waiting for the paused proxy's ownership record.
    await waitForFile(marker, 10_000);
    w.kill('SIGTERM');
    await waitFor(() => out.stdout.includes('SIGNAL=TERM'), 5_000, 'signal queued');
    unlinkSync(marker);
    const code = await waitExit(w, 15_000);
    assert.equal(code, 143, out.stderr + out.stdout);
    assert.doesNotMatch(out.stdout, /ANTHROPIC_BASE_URL=/, 'native must not start after a setup-time signal');
    assert.equal(spawnSync('ls', [leases], { encoding: 'utf8' }).stdout.trim(), '');
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-cleanup-failure-is-not-masked', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'proxy-leases'), { recursive: true });
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const env = envFor(dir, port, fake);
    const gate = join(dir, 'exit-gate');
    const lock = join(dir, 'proxy.lock');
    const w = spawnTracked('/usr/bin/python3', [WRAPPER, '--exit-on-file', gate], { env });
    const out = collect(w);
    await waitFor(() => out.stdout.includes('ANTHROPIC_BASE_URL='), 12_000, 'child');
    chmodSync(lock, 0o000); // final mutex cannot open the lock -> cleanup fails
    try {
      writeFileSync(gate, 'go');
      const code = await waitExit(w, 12_000);
      assert.notEqual(code, 0, 'native exit 0 must not hide a failed cleanup');
      assert.match(out.stderr, /proxy cleanup failed/);
    } finally {
      chmodSync(lock, 0o600);
    }
    // A later wrapper reaps the dead lease and stops the orphaned proxy.
    const w2 = spawnTracked('/usr/bin/python3', [WRAPPER, '--exit', '0'], { env });
    collect(w2);
    assert.equal(await waitExit(w2, 12_000), 0);
    await assertCaseQuiet(dir, port);
  });

  it('wrapper-attach-vs-final-shutdown', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'proxy-leases'), { recursive: true });
    const port = await freePort();
    const fake = writeFakeClaude(dir);
    const env = envFor(dir, port, fake);
    const lock = join(dir, 'proxy.lock');
    const w1 = spawnTracked('/usr/bin/python3', [WRAPPER, '--wait-signal'], { env });
    const o1 = collect(w1);
    await waitForFile(join(dir, 'proxy.json'), 10_000);
    await waitFor(() => o1.stdout.includes('ANTHROPIC_BASE_URL='), 8_000, 'w1 child');

    const fifo = join(dir, 'hold-final.fifo');
    spawnSync('mkfifo', [fifo]);
    const holder = spawnTracked('/usr/bin/python3', [MUTEX, lock, '--', '/bin/sh', '-c', 'echo HELD; exec cat "$1"', 'sh', fifo], {
      env: process.env,
    });
    const holdOut = collect(holder);
    await waitFor(() => holdOut.stdout.includes('HELD'), 5_000, 'mutex held');

    w1.kill('SIGTERM');
    await waitFor(() => o1.stdout.includes('SIGNAL=TERM'), 5_000, 'w1 signal');
    await delay(400);

    const w2 = spawnTracked('/usr/bin/python3', [WRAPPER, '--wait-signal'], { env });
    const o2 = collect(w2);
    await delay(400);

    writeFileSync(fifo, 'x');
    await waitExit(holder, 5_000).catch(() => undefined);

    await waitFor(() => o2.stdout.includes('ANTHROPIC_BASE_URL='), 12_000, 'w2 attached');
    await waitFor(() => existsSync(join(dir, 'proxy.json')), 8_000, 'proxy.json after race');
    const info = JSON.parse(readFileSync(join(dir, 'proxy.json'), 'utf8')) as { token: string };
    const status = await health(port, info.token);
    assert.equal(status, 200);
    w2.kill('SIGTERM');
    await Promise.all([waitExit(w1, 10_000).catch(() => undefined), waitExit(w2, 10_000)]);
    await assertCaseQuiet(dir, port);
  });
});
