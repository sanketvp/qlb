'use strict';
// Exact-Node contention holder for store-open tests. Synthetic temp DB only.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const opts = JSON.parse(process.argv[2] || '{}');
const marker = (name) => path.join(opts.fixtureDir, `${name}.json`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function atomicMarker(name, detail = {}) {
  const file = marker(name);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ phase: name, at: Date.now(), ...detail }));
  fs.renameSync(temp, file);
}
async function waitFor(name, deadline) {
  while (!fs.existsSync(marker(name))) {
    if (fs.existsSync(marker('abort'))) return 'abort';
    if (Date.now() >= deadline) return 'failsafe';
    await sleep(5);
  }
  return name;
}

let db;
let released = false;
function release() {
  if (released) return;
  released = true;
  atomicMarker('releaseStarted');
  db.exec('COMMIT');
  db.close();
  atomicMarker('releaseComplete');
}

(async () => {
  db = new DatabaseSync(opts.dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA locking_mode = EXCLUSIVE');
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)')
    .run('fixture-holder', 'synthetic');
  atomicMarker('ready', { pid: process.pid, mode: opts.mode });

  const failsafeAt = Date.now() + Number(opts.failsafeMs || 15000);
  const entered = await waitFor('operationEntry', failsafeAt);
  if (entered === 'abort') {
    release();
    process.exit(0);
  }
  if (entered === 'failsafe') {
    atomicMarker('failsafe', { stage: 'operationEntry' });
    release();
    process.exit(1);
  }
  atomicMarker('armed');

  if (opts.mode === 'finite') {
    const holdUntil = Date.now() + Number(opts.holdMs || 1500);
    while (Date.now() < holdUntil && !fs.existsSync(marker('abort'))) {
      if (Date.now() >= failsafeAt) {
        atomicMarker('failsafe', { stage: 'finite' });
        release();
        process.exit(1);
      }
      await sleep(5);
    }
  } else if (opts.mode === 'hold-until-outcome') {
    const outcome = await waitFor('outcome', failsafeAt);
    if (outcome === 'failsafe') {
      atomicMarker('failsafe', { stage: 'outcome' });
      release();
      process.exit(1);
    }
  } else {
    throw new Error(`unknown holder mode: ${opts.mode}`);
  }
  release();
  process.exit(0);
})().catch((err) => {
  try {
    if (db && !released) release();
  } catch {
    // Primary fixture failure remains visible below.
  }
  process.stderr.write(`${err && (err.stack || err.message) || String(err)}\n`);
  process.exit(1);
});
