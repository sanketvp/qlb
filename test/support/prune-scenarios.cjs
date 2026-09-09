'use strict';
// Head-bound prune scenarios. Identity comes ONLY from build-root input
// (HEAD.receipt or .git), never from --artifact-root receipts.

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
  return /^[0-9a-f]{40}$/.test(raw) ? raw : null;
}

function resolveInputHead(buildRoot) {
  const receipt = path.join(buildRoot, 'HEAD.receipt');
  if (fs.existsSync(receipt)) {
    const value = fs.readFileSync(receipt, 'utf8').trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/.test(value)) die(`invalid build-root HEAD.receipt: ${value}`);
    return value;
  }
  return readGitHead(buildRoot);
}

const buildRoot = path.resolve(arg('--build-root', process.cwd()));
const expectHead = arg('--expect-head');
const artifactRoot = path.resolve(arg('--artifact-root', path.join(os.tmpdir(), 'qlb-scenarios')));
if (!expectHead) die('missing --expect-head');
if (!/^[0-9a-f]{40}$/.test(expectHead)) die(`expect-head is not a 40-char sha: ${expectHead}`);
fs.mkdirSync(artifactRoot, { recursive: true });
if (artifactRoot.includes('qlb-astra-16f1642') || artifactRoot.includes('qlb-astra-bcd9dfc')) {
  die('refusing to write into historical Astra evidence paths');
}

const testedHead = resolveInputHead(buildRoot);
if (!testedHead) die('no independent input head at build-root (need HEAD.receipt or .git)');
if (testedHead !== expectHead) {
  die(`head mismatch: tested=${testedHead} expect=${expectHead}`, 2);
}

const guardPath = path.join(buildRoot, 'test/support/guard.cjs');
const cliPath = path.join(buildRoot, 'dist/cli.js');
const storePath = path.join(buildRoot, 'dist/store.js');
const healthPath = path.join(buildRoot, 'dist/migration-health.js');
const migrationPath = path.join(buildRoot, 'dist/migration.js');
const keychainPath = path.join(buildRoot, 'dist/keychain.js');
if (!fs.existsSync(cliPath) || !fs.existsSync(storePath)) {
  die(`compiled CLI/store missing under ${buildRoot}`);
}

const { openStore } = require(storePath);
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

const results = [];
function record(id, ok, extra) {
  results.push({ id, ok, ...extra });
  if (!ok) console.error('FAIL', id, extra);
}

function expectRefuse(id, seed, account = 'victim') {
  const { dbPath } = seedDb(id, seed);
  const r = runCli(dbPath, account);
  const store = openStore(dbPath);
  const survived = !!store.getAccount(account);
  store.close();
  record(id, r.status === 2 && survived, { status: r.status, stderr: r.stderr.slice(0, 180) });
}

expectRefuse('T-SCEN-1-empty-qlbAccountIds', (store) => {
  store.upsertAccount('victim', 'anthropic', 'v');
  store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: [] }), Date.now());
});
expectRefuse('T-SCEN-2-empty-accounts', (store) => {
  store.upsertAccount('victim', 'anthropic', 'v');
  store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ accounts: [] }), Date.now());
});
expectRefuse('T-SCEN-3-both-empty', (store) => {
  store.upsertAccount('victim', 'anthropic', 'v');
  store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: [], accounts: [] }), Date.now());
});
expectRefuse('T-SCEN-4-missing-inventory', (store) => {
  store.upsertAccount('victim', 'anthropic', 'v');
  store.upsertMigration('pi-pool', 'QLB_OWNED', '{}', Date.now());
});
expectRefuse('T-SCEN-5-contradictory-dual', (store) => {
  store.upsertAccount('victim', 'anthropic', 'v');
  store.upsertMigration(
    'pi-pool',
    'QLB_OWNED',
    JSON.stringify({ qlbAccountIds: ['a'], accounts: [{ id: 'b' }] }),
    Date.now(),
  );
});
expectRefuse('T-SCEN-6-empty-string-id', (store) => {
  store.upsertAccount('victim', 'anthropic', 'v');
  store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: [''] }), Date.now());
});
expectRefuse('T-SCEN-7-wrong-typed-id', (store) => {
  store.upsertAccount('victim', 'anthropic', 'v');
  store.upsertMigration('pi-pool', 'QLB_OWNED', JSON.stringify({ qlbAccountIds: [1] }), Date.now());
});
expectRefuse('T-SCEN-8-malformed-validated', (store) => {
  store.upsertAccount('victim', 'anthropic', 'v');
  store.upsertMigration('pi-pool', 'VALIDATED', 'not-json', Date.now());
});
expectRefuse('T-SCEN-9-unknown-state', (store) => {
  store.upsertAccount('victim', 'anthropic', 'v');
  store.upsertMigration('pi-pool', 'WEIRD', JSON.stringify({ qlbAccountIds: ['victim'] }), Date.now());
});
expectRefuse('T-SCEN-10-first-cycle-validated-no-receipt', (store) => {
  store.upsertAccount('victim', 'anthropic', 'v');
  store.upsertMigration('pi-pool', 'VALIDATED', JSON.stringify({ qlbAccountIds: ['victim'] }), Date.now());
});
expectRefuse('T-SCEN-11-stale-receipt-validated', (store) => {
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
expectRefuse('T-SCEN-15-enotdir-owner-path', (store, dir) => {
  const asDir = path.join(dir, 'owner-dir');
  fs.mkdirSync(asDir, { recursive: true });
  store.upsertAccount('victim', 'anthropic', 'v');
  store.upsertMigration(
    'pi-pool',
    'VALIDATED',
    JSON.stringify({ qlbAccountIds: ['victim'], ownerFilePath: asDir }),
    Date.now(),
  );
});
expectRefuse('T-SCEN-18-unsupported-version', (store) => {
  store.upsertAccount('victim', 'anthropic', 'v');
  store.upsertMigration(
    'pi-pool',
    'QLB_OWNED',
    JSON.stringify({ qlbAccountIds: ['victim'], schemaVersion: 99 }),
    Date.now(),
  );
});
expectRefuse('T-SCEN-19-provider-conflict', (store) => {
  store.upsertAccount('victim', 'anthropic', 'v');
  store.upsertMigration(
    'pi-pool',
    'QLB_OWNED',
    JSON.stringify({
      accounts: [
        { id: 'a', provider: 'xai' },
        { id: 'a', provider: 'anthropic' },
      ],
    }),
    Date.now(),
  );
});

{
  const { dbPath } = seedDb('orphan', (store) => {
    store.upsertAccount('orphan', 'anthropic', 'o');
  });
  const r = runCli(dbPath, 'orphan');
  const store = openStore(dbPath);
  record('T-SCEN-16-clean-orphan', r.status === 0 && !store.getAccount('orphan'), { status: r.status });
  store.close();
}

{
  const ev = decodeJournalEvidence({
    store: 'pi-pool',
    state: 'QLB_OWNED',
    detail_json: '{"qlbAccountIds":[""]}',
  });
  record('T-SCEN-17-decoder-empty-id', !ev.trusted && ev.reason === 'bad_id', ev);
}

async function writerCycle(kind) {
  const { dbPath, dir } = seedDb(`writer-${kind}`, () => {});
  const store = openStore(dbPath);
  const kc = new MockKeychain();
  const ownerPath = path.join(dir, 'qlb-owner.json');
  const okRehearse = async () => ({ ok: true });
  if (kind === 'pool') {
    const poolPath = path.join(dir, 'anthropic-pool.json');
    fs.writeFileSync(poolPath, JSON.stringify({
      version: 1,
      accounts: [{
        id: 'victim',
        name: 'Victim',
        credentials: {
          type: 'oauth',
          access: 'sk-ant-oat-fake',
          refresh: 'sk-ant-ort-fake',
          expires: Date.now() + 7 * 24 * 3600 * 1000,
        },
      }],
    }));
    const mig = new Migration(store, kc, poolPath, ownerPath);
    mig.stage();
    await mig.rehearse(okRehearse);
    mig.commit();
    mig.rollback();
    mig.stage();
    await mig.rehearse(okRehearse);
    return { store, dbPath, dir, ownerPath, account: 'victim' };
  }
  if (kind === 'single-grant') {
    const authPath = path.join(dir, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({
      xai: {
        type: 'oauth',
        access: 'xai-access-fake',
        refresh: 'xai-refresh-fake',
        expires: Date.now() + 7 * 24 * 3600 * 1000,
      },
    }));
    const mig = createSingleGrantMigration(store, kc, 'xai', authPath, ownerPath);
    mig.stage();
    await mig.rehearse(okRehearse);
    mig.commit();
    mig.rollback();
    mig.stage();
    await mig.rehearse(okRehearse);
    return { store, dbPath, dir, ownerPath, account: 'xai-default' };
  }
  const mig = createStaticKeyMigration(store, kc, 'openrouter', ownerPath, () => 'or-key-fake');
  mig.stage();
  await mig.rehearse(okRehearse);
  mig.commit();
  mig.rollback();
  mig.stage();
  await mig.rehearse(okRehearse);
  return { store, dbPath, dir, ownerPath, account: 'openrouter-default' };
}

(async () => {
  const pool = await writerCycle('pool');
  {
    const r = runCli(pool.dbPath, pool.account);
    record('T-SCEN-12-fresh-post-rollback-then-second-cycle', r.status === 2 && !!pool.store.getAccount(pool.account) && /protected:VALIDATED/.test(r.stderr), {
      status: r.status,
      stderr: r.stderr.slice(0, 180),
    });
  }
  {
    const staging = `${pool.ownerPath}.staging`;
    try { fs.unlinkSync(staging); } catch { /* may be absent after rename */ }
    try { fs.symlinkSync(path.join(pool.dir, 'missing-staging'), staging); } catch { /* ok */ }
    const r = runCli(pool.dbPath, pool.account);
    record('T-SCEN-13-dangling-staging-symlink', r.status === 2 && !!pool.store.getAccount(pool.account), { status: r.status });
  }
  pool.store.close();

  {
    const rolled = await writerCycle('pool');
    rolled.store.close();
    const store = openStore(rolled.dbPath);
    const mig = new Migration(
      store,
      new MockKeychain(),
      path.join(rolled.dir, 'anthropic-pool.json'),
      rolled.ownerPath,
    );
    if (fs.existsSync(rolled.ownerPath)) {
      try { fs.unlinkSync(rolled.ownerPath); } catch { /* */ }
    }
    try { fs.symlinkSync(path.join(rolled.dir, 'missing-owner'), rolled.ownerPath); } catch { /* */ }
    const r = runCli(rolled.dbPath, 'victim');
    record('T-SCEN-14-dangling-owner-symlink', r.status === 2 && !!store.getAccount('victim'), { status: r.status });
    store.close();
  }

  {
    const sg = await writerCycle('single-grant');
    const r = runCli(sg.dbPath, sg.account);
    record('T-SCEN-20-second-cycle-single-grant', r.status === 2 && !!sg.store.getAccount(sg.account), { status: r.status });
    sg.store.close();
  }

  const ok = results.every((row) => row.ok);
  const report = {
    testedHead,
    buildRoot,
    artifactRoot,
    inputReceipt: fs.existsSync(path.join(buildRoot, 'HEAD.receipt')),
    ok,
    results,
  };
  fs.writeFileSync(path.join(artifactRoot, 'scenarios.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
