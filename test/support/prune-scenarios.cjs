'use strict';
// Ported parameterized prune scenarios. Bound to an explicit build/head.
// Never writes into /tmp/qlb-astra-16f1642.S9EpmE/.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

function die(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

function readGitHead(repo) {
  const headPath = path.join(repo, '.git', 'HEAD');
  if (!fs.existsSync(headPath)) return null;
  const raw = fs.readFileSync(headPath, 'utf8').trim();
  if (raw.startsWith('ref: ')) {
    const refPath = path.join(repo, '.git', raw.slice(5).trim());
    if (fs.existsSync(refPath)) return fs.readFileSync(refPath, 'utf8').trim();
    return null;
  }
  return raw;
}

function resolveHead(buildRoot, artifactRoot) {
  for (const candidate of [
    path.join(buildRoot, 'HEAD.receipt'),
    path.join(artifactRoot, 'HEAD.receipt'),
  ]) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8').trim();
  }
  return readGitHead(buildRoot);
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

const buildRoot = path.resolve(arg('--build-root', process.cwd()));
const expectHead = arg('--expect-head');
const artifactRoot = path.resolve(arg('--artifact-root', path.join(os.tmpdir(), 'qlb-scenarios')));
if (!expectHead) die('missing --expect-head');
fs.mkdirSync(artifactRoot, { recursive: true });
if (artifactRoot.includes('qlb-astra-16f1642')) {
  die('refusing to write into baseline Astra archive path');
}

const testedHead = resolveHead(buildRoot, artifactRoot);
if (!testedHead || testedHead !== expectHead) {
  die(`head mismatch: tested=${testedHead} expect=${expectHead}`, 2);
}

const guardPath = path.join(buildRoot, 'test/support/guard.cjs');
const guardSha256 = fs.existsSync(guardPath) ? sha256File(guardPath) : null;
const cliPath = path.join(buildRoot, 'dist/cli.js');
const storePath = path.join(buildRoot, 'dist/store.js');
const healthPath = path.join(buildRoot, 'dist/migration-health.js');
if (!fs.existsSync(cliPath) || !fs.existsSync(storePath)) {
  die(`compiled CLI/store missing under ${buildRoot}`);
}

const { openStore } = require(storePath);
const { decodeJournalEvidence } = require(healthPath);

function runCli(dbPath, account, extraEnv) {
  const result = spawnSync(process.execPath, [cliPath, 'accounts', 'prune', '--account', account, '--confirm', '--db', dbPath], {
    encoding: 'utf8',
    env: { ...process.env, QLB_DB_PATH: dbPath, ...(extraEnv || {}) },
  });
  return {
    status: result.status == null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function seedDb(label, seed) {
  const dir = fs.mkdtempSync(path.join(artifactRoot, `${label}-`));
  const dbPath = path.join(dir, 'qlb.db');
  const store = openStore(dbPath);
  seed(store, dir);
  store.close();
  return dbPath;
}

const results = [];
function record(id, ok, extra) {
  results.push({ id, ok, ...extra });
  if (!ok) console.error('FAIL', id, extra);
}

{
  const dbPath = seedDb('f1-empty', (store) => {
    store.upsertAccount('victim', 'anthropic', 'v');
    store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: [] }), Date.now());
  });
  const r = runCli(dbPath, 'victim');
  const store = openStore(dbPath);
  record('F1-empty-qlbAccountIds', r.status === 2 && !!store.getAccount('victim'), { status: r.status });
  store.close();
}

{
  const dbPath = seedDb('f2-mismatch', (store) => {
    store.upsertAccount('victim', 'anthropic', 'v');
    store.upsertMigration(
      'pi-pool',
      'QLB_OWNED',
      JSON.stringify({ qlbAccountIds: ['a'], accounts: [{ id: 'b' }] }),
      Date.now(),
    );
  });
  const r = runCli(dbPath, 'victim');
  const store = openStore(dbPath);
  record('F2-contradictory-dual', r.status === 2 && !!store.getAccount('victim'), { status: r.status });
  store.close();
}

{
  const dbPath = seedDb('f3-stale', (store) => {
    store.upsertAccount('victim', 'anthropic', 'v');
    store.upsertMigration(
      'pi-pool',
      'VALIDATED',
      JSON.stringify({
        qlbAccountIds: ['victim'],
        ownerFilePath: '/tmp/qlb-owner.json',
        rolledBackFrom: 'post-commit',
      }),
      Date.now(),
    );
  });
  const r = runCli(dbPath, 'victim');
  const store = openStore(dbPath);
  record('F3-stale-receipt-VALIDATED', r.status === 2 && !!store.getAccount('victim') && /protected:VALIDATED/.test(r.stderr), {
    status: r.status,
    stderr: r.stderr.slice(0, 200),
  });
  store.close();
}

{
  const dbPath = seedDb('orphan', (store) => {
    store.upsertAccount('orphan', 'anthropic', 'o');
  });
  const r = runCli(dbPath, 'orphan');
  const store = openStore(dbPath);
  record('clean-orphan', r.status === 0 && !store.getAccount('orphan'), { status: r.status });
  store.close();
}

{
  const ev = decodeJournalEvidence({
    store: 'pi-pool',
    state: 'QLB_OWNED',
    detail_json: '{"qlbAccountIds":[""]}',
  });
  record('decoder-empty-id', !ev.trusted && ev.reason === 'bad_id', ev);
}

const ok = results.every((row) => row.ok);
const report = {
  testedHead,
  buildRoot,
  guardSha256,
  artifactRoot,
  ok,
  results,
};
fs.writeFileSync(path.join(artifactRoot, 'scenarios.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(ok ? 0 : 1);
