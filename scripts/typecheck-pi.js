#!/usr/bin/env node
// Typecheck extensions/qlb-pi against the Pi install on PATH (the checked-in
// tsconfig carries no machine paths). Same generated config as `qlb doctor --live`.
'use strict';
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { locatePi, piTypecheckConfig } = require('../dist/pi-integration.js');

const pi = locatePi();
if (!pi.root) {
  console.error(pi.unresolved
    ? `typecheck:pi: found ${pi.launcher ?? 'QLB_PI_PACKAGE_ROOT'} but not its package; set QLB_PI_PACKAGE_ROOT`
    : 'typecheck:pi: Pi is not installed');
  process.exit(2);
}
const repo = join(__dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'qlb-pi-typecheck-'));
try {
  const cfg = join(dir, 'tsconfig.json');
  writeFileSync(cfg, JSON.stringify(piTypecheckConfig(join(repo, 'extensions', 'qlb-pi'), pi.root)));
  console.log(`typecheck:pi against ${pi.root}`);
  const r = spawnSync('npx', ['tsc', '-p', cfg, '--noEmit'], { cwd: repo, stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
