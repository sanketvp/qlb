'use strict';

const fs = require('node:fs');
const childProcess = require('node:child_process');

function bump(path) {
  if (!path) return;
  let n = 0;
  try { n = Number(fs.readFileSync(path, 'utf8')) || 0; } catch { /* first call */ }
  fs.writeFileSync(path, String(n + 1));
}

function isGateCall(file, args) {
  const qlbCli = process.env.QLB_CLI;
  if (!qlbCli) return false;
  const argv = [file, ...(Array.isArray(args) ? args : [])];
  return argv.includes(qlbCli) && argv.includes('gate');
}

const origExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function patchedExecFileSync(file) {
  if (file === '/usr/bin/security') {
    bump(process.env.SMOKE_SECURITY_COUNTER);
    throw new Error('security used');
  }
  return origExecFileSync.apply(this, arguments);
};

const origSpawn = childProcess.spawn;
childProcess.spawn = function patchedSpawn(file, args) {
  const spawnArgs = Array.isArray(args) ? args : [];
  if (isGateCall(file, spawnArgs)) {
    bump(process.env.SMOKE_GATE_COUNTER);
  }
  return origSpawn.apply(this, arguments);
};
