'use strict';
// Provenance-bound prune scenarios. A trusted verifier first runs
// build-provenance.cjs, which clean-compiles the immutable source and writes
// an external manifest. This driver verifies source, executable, guard, and
// driver bytes against that manifest before loading any build output.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifyManifest } = require('./build-provenance.cjs');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}
function die(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const buildRoot = path.resolve(arg('--build-root', process.cwd()));
const expectHead = arg('--expect-head');
const provenancePath = path.resolve(arg('--provenance-manifest', ''));
const artifactRoot = path.resolve(arg('--artifact-root', path.join(os.tmpdir(), 'qlb-scenarios')));
if (!expectHead || !/^[0-9a-f]{40}$/.test(expectHead)) die(`invalid or missing --expect-head: ${expectHead || ''}`);
if (!arg('--provenance-manifest')) die('missing --provenance-manifest from trusted verifier preflight');
if (!fs.existsSync(provenancePath)) die(`provenance manifest missing: ${provenancePath}`);
if (provenancePath === buildRoot || provenancePath.startsWith(`${buildRoot}${path.sep}`)) {
  die('provenance manifest must be outside build root');
}
if (artifactRoot.includes('qlb-astra-16f1642') || artifactRoot.includes('qlb-astra-bcd9dfc')) {
  die('refusing to write into historical Astra evidence paths');
}

let provenance;
let binding;
try {
  provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  binding = verifyManifest(buildRoot, provenance, expectHead);
} catch (err) {
  die(`provenance rejected: ${err instanceof Error ? err.message : String(err)}`);
}

const guardPath = path.join(buildRoot, 'test/support/guard.cjs');
const loadedGuard = globalThis.__qlbIsolationGuard;
const expectedGuardRealpath = fs.realpathSync(guardPath);
const loadedGuardRealpath = loadedGuard?.path && fs.existsSync(loadedGuard.path)
  ? fs.realpathSync(loadedGuard.path)
  : null;
if (loadedGuardRealpath !== expectedGuardRealpath || !require.cache[require.resolve(guardPath)]) {
  die('isolation guard is not loaded from the provenance-bound build root');
}
fs.mkdirSync(artifactRoot, { recursive: true });

const cliPath = path.join(buildRoot, 'dist/cli.js');
const storePath = path.join(buildRoot, 'dist/store.js');
const healthPath = path.join(buildRoot, 'dist/migration-health.js');
const migrationPath = path.join(buildRoot, 'dist/migration.js');
const keychainPath = path.join(buildRoot, 'dist/keychain.js');
for (const file of [cliPath, storePath, healthPath, migrationPath, keychainPath]) {
  if (!fs.existsSync(file)) die(`compiled file missing after provenance check: ${file}`);
}

const { openStore, refreshLeaseName } = require(storePath);
const { decodeJournalEvidence } = require(healthPath);
const { Migration, createSingleGrantMigration, createStaticKeyMigration } = require(migrationPath);
const { MockKeychain } = require(keychainPath);

function runCli(dbPath, account) {
  const result = spawnSync(
    process.execPath,
    [cliPath, 'accounts', 'prune', '--account', account, '--confirm', '--db', dbPath],
    { encoding: 'utf8', env: { ...process.env, QLB_DB_PATH: dbPath } },
  );
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
  return { dbPath, dir };
}

function seedMetadata(store, id, createAccount = true) {
  if (createAccount) store.upsertAccount(id, 'anthropic', `${id}@fixture.invalid`);
  store.upsertSnapshot(id, '5h', {
    usedPct: 1,
    fetchedAt: Date.now(),
    source: 'poll',
    confidence: 'authoritative',
  });
  store.upsertOverride({ kind: 'exclude', accountId: id, until: Date.now() + 60_000 });
  store.claimPoll(id, `poll-${id}`, 15_000);
  store.acquireRefreshLease(id, `lease-${id}`, process.pid, 0, 15_000);
  store.recordDecision({
    requested_model: 'fixture-model',
    mode: 'proxy',
    reason: 'fixture',
    snapshot_json: '{}',
    account_id: id,
  });
}

function metadataCounts(store, id) {
  const db = store.db;
  return {
    accounts: Number(db.prepare('SELECT COUNT(*) n FROM accounts WHERE id=?').get(id).n),
    snapshots: Number(db.prepare('SELECT COUNT(*) n FROM snapshots WHERE account_id=?').get(id).n),
    overrides: Number(db.prepare('SELECT COUNT(*) n FROM overrides WHERE account_id=?').get(id).n),
    pollClaims: Number(db.prepare('SELECT COUNT(*) n FROM poll_claims WHERE account_id=?').get(id).n),
    leases: Number(db.prepare('SELECT COUNT(*) n FROM leases WHERE name=?').get(refreshLeaseName(id)).n),
    decisions: Number(db.prepare('SELECT COUNT(*) n FROM decisions WHERE account_id=?').get(id).n),
  };
}
const sixPresent = { accounts: 1, snapshots: 1, overrides: 1, pollClaims: 1, leases: 1, decisions: 1 };
function sixSurvive(store, id) {
  return JSON.stringify(metadataCounts(store, id)) === JSON.stringify(sixPresent);
}

const results = [];
function record(id, ok, extra = {}) {
  results.push({ id, ok, ...extra });
  if (!ok) process.stderr.write(`FAIL ${id} ${JSON.stringify(extra)}\n`);
}

function expectGlobalRefusal(id, journalSeed) {
  const { dbPath } = seedDb(id, (store, dir) => {
    seedMetadata(store, 'victim');
    seedMetadata(store, 'unrelated');
    journalSeed(store, dir);
  });
  const named = runCli(dbPath, 'victim');
  const unrelated = runCli(dbPath, 'unrelated');
  const store = openStore(dbPath);
  const namedCounts = metadataCounts(store, 'victim');
  const unrelatedCounts = metadataCounts(store, 'unrelated');
  const ok = named.status === 2 && unrelated.status === 2
    && sixSurvive(store, 'victim') && sixSurvive(store, 'unrelated');
  store.close();
  record(id, ok, {
    namedStatus: named.status,
    unrelatedStatus: unrelated.status,
    namedCounts,
    unrelatedCounts,
    stderr: named.stderr.slice(0, 180),
  });
}

expectGlobalRefusal('T-SCEN-1-empty-qlbAccountIds', (store) => {
  store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: [] }), Date.now());
});
expectGlobalRefusal('T-SCEN-2-empty-accounts', (store) => {
  store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ accounts: [] }), Date.now());
});
expectGlobalRefusal('T-SCEN-3-both-empty', (store) => {
  store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: [], accounts: [] }), Date.now());
});
expectGlobalRefusal('T-SCEN-4-missing-inventory', (store) => {
  store.upsertMigration('pi-pool', 'QLB_OWNED', '{}', Date.now());
});
expectGlobalRefusal('T-SCEN-5-contradictory-dual', (store) => {
  store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: ['victim'], accounts: [{ id: 'other' }] }), Date.now());
});
expectGlobalRefusal('T-SCEN-6-empty-string-id', (store) => {
  store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: [''] }), Date.now());
});
expectGlobalRefusal('T-SCEN-7-wrong-typed-id', (store) => {
  store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: [1] }), Date.now());
});
expectGlobalRefusal('T-SCEN-8-malformed-validated', (store) => {
  store.upsertMigration('pi-pool', 'VALIDATED', 'not-json', Date.now());
});
expectGlobalRefusal('T-SCEN-9-unknown-state', (store) => {
  store.upsertMigration('pi-pool', 'WEIRD', JSON.stringify({ qlbAccountIds: ['victim'] }), Date.now());
});

function expectProtectedFixture(id, detail) {
  const { dbPath } = seedDb(id, (store) => {
    seedMetadata(store, 'victim');
    store.upsertMigration('pi-pool', 'VALIDATED', JSON.stringify(detail), Date.now());
  });
  const run = runCli(dbPath, 'victim');
  const store = openStore(dbPath);
  const counts = metadataCounts(store, 'victim');
  const ok = run.status === 2 && /protected:VALIDATED/.test(run.stderr) && sixSurvive(store, 'victim');
  store.close();
  record(id, ok, { status: run.status, counts, stderr: run.stderr.slice(0, 180) });
}
expectProtectedFixture('T-SCEN-10-first-cycle-validated-no-receipt', {
  qlbAccountIds: ['victim'], ownerFilePath: '/tmp/qlb-fixture-owner',
});
expectProtectedFixture('T-SCEN-11-stale-receipt-validated', {
  qlbAccountIds: ['victim'], ownerFilePath: '/tmp/qlb-fixture-owner', rolledBackFrom: 'post-commit',
});

expectGlobalRefusal('T-SCEN-19-unsupported-version', (store) => {
  store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: ['victim'], schemaVersion: 99 }), Date.now());
});
expectGlobalRefusal('T-SCEN-20-provider-conflict', (store) => {
  store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({
    accounts: [
      { id: 'victim', provider: 'xai' },
      { id: 'victim', provider: 'anthropic' },
    ],
  }), Date.now());
});

{
  const { dbPath } = seedDb('clean-orphan', (store) => seedMetadata(store, 'orphan'));
  const run = runCli(dbPath, 'orphan');
  const store = openStore(dbPath);
  const counts = metadataCounts(store, 'orphan');
  record('T-SCEN-17-clean-orphan', run.status === 0
    && counts.accounts === 0 && counts.snapshots === 0 && counts.overrides === 0
    && counts.pollClaims === 0 && counts.leases === 0 && counts.decisions === 1,
  { status: run.status, counts });
  store.close();
}

{
  const ev = decodeJournalEvidence({
    store: 'pi-pool', state: 'QLB_OWNED', detail_json: '{"qlbAccountIds":[""]}',
  });
  record('T-SCEN-18-decoder-empty-id', !ev.trusted && ev.reason === 'bad_id', ev);
}

async function createWriterFixture(kind) {
  const { dbPath, dir } = seedDb(`writer-${kind}`, () => {});
  const store = openStore(dbPath);
  const keychain = new MockKeychain();
  const ownerPath = path.join(dir, 'qlb-owner.json');
  const rehearse = async () => ({ ok: true });
  let migration;
  let account;
  if (kind === 'pool') {
    const nativePath = path.join(dir, 'anthropic-pool.json');
    fs.writeFileSync(nativePath, JSON.stringify({
      version: 1,
      accounts: [{
        id: 'victim',
        name: 'Victim',
        credentials: {
          type: 'oauth', access: 'sk-ant-oat-fake', refresh: 'sk-ant-ort-fake',
          expires: Date.now() + 7 * 24 * 3600 * 1000,
        },
      }],
    }));
    migration = new Migration(store, keychain, nativePath, ownerPath);
    account = 'victim';
  } else if (kind === 'single-grant') {
    const nativePath = path.join(dir, 'auth.json');
    fs.writeFileSync(nativePath, JSON.stringify({
      xai: { type: 'oauth', access: 'xai-access-fake', refresh: 'xai-refresh-fake', expires: Date.now() + 86400000 },
    }));
    migration = createSingleGrantMigration(store, keychain, 'xai', nativePath, ownerPath);
    account = 'xai-default';
  } else {
    migration = createStaticKeyMigration(store, keychain, 'openrouter', ownerPath, () => 'or-key-fake');
    account = 'openrouter-default';
  }
  migration.stage();
  await migration.rehearse(rehearse);
  migration.commit();
  migration.rollback();
  seedMetadata(store, account, false);
  return { store, dbPath, dir, ownerPath, account, migration, rehearse };
}

function requireDanglingSymlink(link, missingTarget) {
  if (fs.existsSync(link) || fs.lstatSync(path.dirname(link)).isSymbolicLink()) {
    throw new Error(`unexpected pre-existing symlink fixture path: ${link}`);
  }
  fs.symlinkSync(missingTarget, link);
  const stat = fs.lstatSync(link);
  if (!stat.isSymbolicLink() || fs.existsSync(link)) throw new Error(`failed to establish dangling symlink: ${link}`);
}

function runProtectedWriter(id, fixture) {
  const run = runCli(fixture.dbPath, fixture.account);
  const counts = metadataCounts(fixture.store, fixture.account);
  record(id, run.status === 2 && /protected:VALIDATED/.test(run.stderr) && sixSurvive(fixture.store, fixture.account), {
    status: run.status,
    counts,
    stderr: run.stderr.slice(0, 180),
  });
}

(async () => {
  const freshPool = await createWriterFixture('pool');
  runProtectedWriter('T-SCEN-12-fresh-post-commit-rollback-pool', freshPool);
  freshPool.store.close();

  const secondPool = await createWriterFixture('pool');
  secondPool.migration.stage();
  await secondPool.migration.rehearse(secondPool.rehearse);
  runProtectedWriter('T-SCEN-13-second-cycle-stale-receipt-pool', secondPool);
  secondPool.store.close();

  const danglingOwner = await createWriterFixture('pool');
  requireDanglingSymlink(danglingOwner.ownerPath, path.join(danglingOwner.dir, 'missing-owner'));
  runProtectedWriter('T-SCEN-14-fresh-post-rollback-dangling-owner', danglingOwner);
  danglingOwner.store.close();

  const danglingStaging = await createWriterFixture('pool');
  danglingStaging.migration.stage();
  await danglingStaging.migration.rehearse(danglingStaging.rehearse);
  const stagingPath = `${danglingStaging.ownerPath}.staging`;
  fs.unlinkSync(stagingPath);
  requireDanglingSymlink(stagingPath, path.join(danglingStaging.dir, 'missing-staging'));
  runProtectedWriter('T-SCEN-15-second-cycle-dangling-staging', danglingStaging);
  danglingStaging.store.close();

  {
    const { dbPath } = seedDb('enotdir', (store, dir) => {
      seedMetadata(store, 'victim');
      const nonDirectory = path.join(dir, 'not-a-directory');
      fs.writeFileSync(nonDirectory, 'fixture');
      const ownerPath = path.join(nonDirectory, 'owner.json');
      let code;
      try { fs.lstatSync(ownerPath); } catch (err) { code = err.code; }
      if (code !== 'ENOTDIR') throw new Error(`expected ENOTDIR fixture, observed ${code || 'no error'}`);
      store.upsertMigration('pi-pool', 'VALIDATED', JSON.stringify({ qlbAccountIds: ['victim'], ownerFilePath: ownerPath }), Date.now());
    });
    const run = runCli(dbPath, 'victim');
    const store = openStore(dbPath);
    record('T-SCEN-16-true-enotdir-ancestor', run.status === 2 && sixSurvive(store, 'victim'), {
      status: run.status,
      counts: metadataCounts(store, 'victim'),
    });
    store.close();
  }

  const single = await createWriterFixture('single-grant');
  single.migration.stage();
  await single.migration.rehearse(single.rehearse);
  runProtectedWriter('T-SCEN-21-second-cycle-single-grant', single);
  single.store.close();

  const staticKey = await createWriterFixture('static-key');
  staticKey.migration.stage();
  await staticKey.migration.rehearse(staticKey.rehearse);
  runProtectedWriter('T-SCEN-22-second-cycle-static-key', staticKey);
  staticKey.store.close();

  {
    const { dbPath } = seedDb('committed-owner', (store, dir) => {
      seedMetadata(store, 'victim');
      const ownerPath = path.join(dir, 'qlb-owner.json');
      fs.writeFileSync(ownerPath, JSON.stringify({ owner: 'qlb', stores: ['pi-pool'], qlbAccountIds: ['victim'] }));
      store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: ['victim'], ownerFilePath: ownerPath }), Date.now());
    });
    const run = runCli(dbPath, 'victim');
    const store = openStore(dbPath);
    record('T-SCEN-23-committed-owner-protected', run.status === 2 && sixSurvive(store, 'victim'), {
      status: run.status,
      counts: metadataCounts(store, 'victim'),
    });
    store.close();
  }

  const ok = results.length >= 20 && results.every((row) => row.ok);
  const report = {
    testedHead: expectHead,
    buildRoot,
    artifactRoot,
    provenanceManifest: provenancePath,
    provenanceManifestSha256: sha256(provenancePath),
    sourceTreeSha256: binding.sourceTreeSha256,
    buildTreeSha256: binding.buildTreeSha256,
    guardSha256: provenance.guardSha256,
    guardLoaded: true,
    supportedIsolationSurface: 'inspected Node test processes and propagated Node children; test-owned loopback only; explicit credential/native mocks; not an OS sandbox',
    ok,
    results,
  };
  fs.writeFileSync(path.join(artifactRoot, 'scenarios.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
