// Sets process.title, records how ps/lsof see this process, then asks a child
// to run tokenCallAllowed against this process as its parent (the S30 ppid check).
const { execFileSync, spawnSync } = require('node:child_process');
const { readlinkSync } = require('node:fs');

const title = process.argv[2];
if (title !== 'pi' && title !== 'pi-rpc') {
  process.stderr.write('title must be pi or pi-rpc\n');
  process.exit(2);
}

process.title = title;

function psField(name) {
  return String(execFileSync('/bin/ps', ['-o', `${name}=`, '-p', String(process.pid)], { encoding: 'utf8' })).trim();
}

function executablePath() {
  try {
    return readlinkSync(`/proc/${process.pid}/exe`);
  } catch {
    // macOS has no /proc. lsof's txt mapping is the node binary process.title cannot hide.
  }
  const text = String(execFileSync('lsof', ['-a', '-p', String(process.pid), '-d', 'txt', '-Fn'], { encoding: 'utf8' }));
  const names = text.split(/\n/).filter((line) => line.startsWith('n')).map((line) => line.slice(1)).filter(Boolean);
  return names.find((name) => /\/node(?:js)?$/.test(name)) ?? names[0] ?? '';
}

const snapshot = {
  comm: psField('comm'),
  command: psField('command'),
  ucomm: psField('ucomm'),
  executable: executablePath(),
};

const child = spawnSync(process.execPath, [
  '--disable-warning=ExperimentalWarning',
  process.env.QLB_TITLE_CHECKER,
  JSON.stringify(snapshot),
], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    QLB_PI_TOKEN_CALL: '1',
    QLB_PROBE_PI_ROOT: process.env.QLB_PROBE_PI_ROOT,
    QLB_PI_PACKAGE_ROOT: process.env.QLB_PROBE_PI_ROOT,
    QLB_TOKEN_MODULE: process.env.QLB_TOKEN_MODULE,
  },
});

let production = false;
let injected = false;
try {
  const body = JSON.parse(child.stdout);
  production = body.production === true;
  injected = body.injected === true;
} catch {
  production = false;
  injected = false;
}

process.stdout.write(JSON.stringify({
  snapshot,
  production,
  injected,
  checkerStatus: child.status,
  checkerStdout: child.stdout,
  checkerStderr: child.stderr,
}));
