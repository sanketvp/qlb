import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const WRAPPER = join(__dirname, '..', '..', 'harness', 'claude');
const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Run Python against the wrapper loaded as a module; returns parsed JSON from stdout. */
function runWithWrapper(body: string, env: NodeJS.ProcessEnv = {}): Record<string, unknown> {
  const script = `
import importlib.machinery, importlib.util, json, os, subprocess, sys, time
loader = importlib.machinery.SourceFileLoader("qlbwrap", ${JSON.stringify(WRAPPER)})
spec = importlib.util.spec_from_loader("qlbwrap", loader)
w = importlib.util.module_from_spec(spec)
loader.exec_module(w)
${body}
`;
  const r = spawnSync('/usr/bin/python3', ['-c', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
}

describe('wrapper identity is tri-state when ps cannot answer', () => {
  it('a hanging ps yields "unknown", never "dead"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-ps-'));
    temps.push(dir);
    const slowPs = join(dir, 'ps');
    writeFileSync(slowPs, '#!/bin/sh\nsleep 5\n');
    chmodSync(slowPs, 0o755);
    const out = runWithWrapper(
      `print(json.dumps({"field": w.ps_field(os.getpid(), "lstart"), "state": w.identity_state(os.getpid(), "anything")}))`,
      { QLB_PS_BIN: slowPs, QLB_PS_TIMEOUT_S: '0.3' },
    );
    assert.equal(out.field, null);
    assert.equal(out.state, 'unknown');
  });

  it('a process that is gone is "dead"; a matching start time is "live"', () => {
    const out = runWithWrapper(`
child = subprocess.Popen(["sleep", "30"])
lst = w.process_lstart(child.pid)
live = w.identity_state(child.pid, lst)
child.kill(); child.wait()
print(json.dumps({"live": live, "gone": w.identity_state(child.pid, lst), "reused": w.identity_state(os.getpid(), "not-the-start-time")}))
`);
    assert.deepEqual(out, { live: 'live', gone: 'dead', reused: 'dead' });
  });

  it('with ps unavailable: leases are kept and counted, and a live proxy is never signalled or forgotten', () => {
    const out = runWithWrapper(`
import tempfile
home = tempfile.mkdtemp(prefix="qlb-home-")
child = subprocess.Popen(["sleep", "30"])
lst = w.process_lstart(child.pid)
w.atomic_write(w.lease_path(home, child.pid), json.dumps({"pid": child.pid, "lstart": lst}))
info_path = os.path.join(home, "proxy.json")
w.atomic_write(info_path, json.dumps({"pid": child.pid, "lstart": lst, "startedBy": "wrapper"}))
w.process_lstart = lambda pid: None      # ps stalls from here on
w.process_command = lambda pid: None
reused = w.reap_leases(home)
kept = os.path.exists(w.lease_path(home, child.pid))
counted = len(w.live_leases(home))
stopped = w.sigterm_proxy(json.loads(open(info_path).read()), info_path)
alive = child.poll() is None
print(json.dumps({"reused": reused, "kept": kept, "counted": counted, "stopped": stopped,
                  "alive": alive, "info_kept": os.path.exists(info_path)}))
child.kill()
`);
    assert.deepEqual(out, { reused: false, kept: true, counted: 1, stopped: false, alive: true, info_kept: true });
  });
});
