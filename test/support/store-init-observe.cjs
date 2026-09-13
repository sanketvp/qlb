'use strict';
// Isolated Store-constructor observer. It records at the closest portable API
// boundary (DatabaseSync.exec for the exact WAL pragma) and delegates once to
// the saved native operation with the same receiver and SQL.
const fs = require('fs');
const path = require('path');
const sqlite = require('node:sqlite');
const OriginalDatabaseSync = sqlite.DatabaseSync;
const opts = JSON.parse(process.argv[2] || '{}');
const marker = (name) => path.join(opts.fixtureDir, `${name}.json`);
const waitArray = new Int32Array(new SharedArrayBuffer(4));
let captured;
let migrationOrigin;
let walObservation;
let injectedCloseError;

function errorRecord(err) {
  if (!err) return null;
  return {
    name: err.name,
    message: err.message,
    code: err.code,
    errcode: err.errcode,
    errstr: err.errstr,
  };
}
function atomicMarker(name, detail = {}) {
  const file = marker(name);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ phase: name, at: Date.now(), ...detail }));
  fs.renameSync(temp, file);
}
function waitSyncFor(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(marker(name))) {
    if (Date.now() >= deadline) return false;
    Atomics.wait(waitArray, 0, 0, 5);
  }
  return true;
}
function heldWindow() {
  return !fs.existsSync(marker('releaseStarted')) && !fs.existsSync(marker('failsafe'));
}

class ObservedDatabaseSync extends OriginalDatabaseSync {
  constructor(...args) {
    super(...args);
    this.closeCalls = 0;
    this.origins = [];
    this.execSql = [];
    captured = this;
  }

  exec(sql) {
    this.execSql.push(sql);
    if (opts.observeWal && sql === 'PRAGMA journal_mode = WAL') {
      if (this !== captured) throw new Error('fixture receiver mismatch');
      if (!heldWindow()) {
        atomicMarker('lostWindow', { stage: 'operationEntry' });
        throw new Error('fixture lost held window before WAL operation entry');
      }
      atomicMarker('operationEntry', { sql });
      const armed = waitSyncFor('armed', Number(opts.ackTimeoutMs || 2000));
      if (!armed || !heldWindow()) {
        atomicMarker('lostWindow', { stage: armed ? 'preDelegation' : 'armedTimeout' });
        throw new Error('fixture lost held window before WAL delegation');
      }
      const start = process.hrtime.bigint();
      try {
        const value = super.exec(sql);
        walObservation = {
          sql,
          receiverMatched: true,
          operationEntry: true,
          armed: true,
          recheckPassed: true,
          delegatedCalls: 1,
          returned: true,
          elapsedMs: Number(process.hrtime.bigint() - start) / 1e6,
        };
        return value;
      } catch (err) {
        this.origins.push({ phase: 'exec', sql, error: err });
        walObservation = {
          sql,
          receiverMatched: true,
          operationEntry: true,
          armed: true,
          recheckPassed: true,
          delegatedCalls: 1,
          returned: false,
          error: err,
          elapsedMs: Number(process.hrtime.bigint() - start) / 1e6,
        };
        throw err;
      }
    }
    try {
      return super.exec(sql);
    } catch (err) {
      this.origins.push({ phase: 'exec', sql, error: err });
      throw err;
    }
  }

  prepare(sql) {
    try {
      return super.prepare(sql);
    } catch (err) {
      this.origins.push({ phase: 'prepare', sql, error: err });
      throw err;
    }
  }

  close() {
    this.closeCalls += 1;
    if (opts.injectCloseFailure && !injectedCloseError) {
      injectedCloseError = new Error('injected-close-failure');
      throw injectedCloseError;
    }
    return super.close();
  }
}

sqlite.DatabaseSync = ObservedDatabaseSync;
const storeModule = require(opts.storePath);
const { Store, openStore } = storeModule;
const originalMigrate = Store.prototype.migrateIfNeeded;
Store.prototype.migrateIfNeeded = function observedMigration(...args) {
  try {
    return originalMigrate.apply(this, args);
  } catch (err) {
    migrationOrigin = err;
    throw err;
  }
};

async function waitForRun() {
  atomicMarker('observerReady');
  const deadline = Date.now() + Number(opts.runTimeoutMs || 5000);
  while (!fs.existsSync(marker('run'))) {
    if (fs.existsSync(marker('abort'))) throw new Error('fixture aborted before run');
    if (Date.now() >= deadline) throw new Error('observer run request timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function closedState(handle) {
  let closedError;
  try {
    handle.exec('SELECT 1');
  } catch (err) {
    closedError = errorRecord(err);
  }
  return {
    isOpen: typeof handle.isOpen === 'boolean' ? handle.isOpen : undefined,
    closedError,
  };
}

async function run() {
  if (opts.waitForRun) await waitForRun();
  let store;
  let caught;
  const started = process.hrtime.bigint();
  try {
    store = openStore(opts.dbPath);
  } catch (err) {
    caught = err;
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const handle = captured;
  const origin = opts.initKind === 'early'
    ? migrationOrigin
    : handle && handle.origins.length > 0
      ? handle.origins[handle.origins.length - 1].error
      : undefined;
  const sameOrigin = !!caught && caught === origin;
  const report = {
    mode: opts.mode,
    storeConstructed: !!store,
    elapsedMs,
    caught: errorRecord(caught),
    originating: errorRecord(origin),
    sameOrigin,
    closeCalls: handle ? handle.closeCalls : 0,
    execSql: handle ? handle.execSql : [],
    wal: walObservation && {
      ...walObservation,
      error: errorRecord(walObservation.error),
    },
    phases: {
      operationEntry: fs.existsSync(marker('operationEntry')),
      armed: fs.existsSync(marker('armed')),
      releaseStarted: fs.existsSync(marker('releaseStarted')),
      releaseComplete: fs.existsSync(marker('releaseComplete')),
      failsafe: fs.existsSync(marker('failsafe')),
      lostWindow: fs.existsSync(marker('lostWindow')),
    },
  };

  if (caught && handle) Object.assign(report, closedState(handle));
  if (opts.injectCloseFailure && handle) {
    report.injectedCloseError = errorRecord(injectedCloseError);
    try {
      OriginalDatabaseSync.prototype.close.call(handle);
    } catch {
      // It may already be closed; closed-state check below is authoritative.
    }
    report.afterFixtureCleanup = closedState(handle);
  }
  if (store) store.close();
  if (opts.writeOutcome) atomicMarker('outcome', { storeConstructed: !!store, error: errorRecord(caught) });
  if (opts.observationPath) {
    const temp = `${opts.observationPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(report));
    fs.renameSync(temp, opts.observationPath);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

run().catch((err) => {
  process.stderr.write(`${err && (err.stack || err.message) || String(err)}\n`);
  process.exit(1);
});
