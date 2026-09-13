'use strict';
// Fresh-process import-order check. Loads one entry, then the public decoder.

const path = require('path');
const fs = require('fs');

const entry = process.argv[2];
if (!entry) {
  console.error('usage: entry-order.cjs <module.js> [...args]');
  process.exit(2);
}

const extra = process.argv.slice(3);
const origExit = process.exit.bind(process);
process.exit = (code) => {
  const err = Object.assign(new Error(`ENTRY_ORDER_EXIT:${code ?? 0}`), { exitCode: code ?? 0 });
  throw err;
};
process.on('unhandledRejection', (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith('ENTRY_ORDER_EXIT:')) return;
  throw err;
});

if (path.basename(entry) === 'cli.js') {
  process.argv = [process.execPath, path.resolve(entry), ...extra];
}

try {
  require(path.resolve(entry));
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.startsWith('ENTRY_ORDER_EXIT:')) throw err;
}

const buildRoot = path.dirname(path.resolve(entry));
const health = require(path.join(buildRoot, 'migration-health.js'));
const kinds = require(path.join(buildRoot, 'journal-kinds.js'));

const retiredDetail = JSON.stringify({
  retiredAt: 1,
  retiredPath: '/tmp/native',
  backupPath: '/tmp/native.pre-qlb',
  sidecarPath: '/tmp/native.pre-qlb.sidecar.json',
  fingerprint: 'a'.repeat(64),
});

const rows = [
  { store: 'pi-pool', state: 'QLB_OWNED', detail_json: '{"qlbAccountIds":["a"]}' },
  { store: 'claude-code', state: 'RETIRED', detail_json: retiredDetail },
];

const decoded = rows.map((row) => {
  const ev = health.decodeJournalEvidence(row);
  return {
    store: row.store,
    trusted: ev.trusted,
    kind: ev.trusted ? ev.kind : null,
    reason: ev.trusted ? null : ev.reason,
  };
});

console.log(JSON.stringify({
  entry: path.basename(entry),
  decoded,
  PI_TRANSFER_STORES: kinds.PI_TRANSFER_STORES,
  NATIVE_RETIREMENT_STORES: kinds.NATIVE_RETIREMENT_STORES,
}));
