import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/config';
import { doctorQlb } from '../src/diagnostics';
import { validatedAdvisoryMessage } from '../src/migration-health';
import { openStore } from '../src/store';

async function doctorReport(
  home: string,
  seed: (store: ReturnType<typeof openStore>) => void,
) {
  const config = defaultConfig(home);
  const store = openStore(config.dbPath);
  seed(store);
  store.close();
  return doctorQlb(config, {
    command: (_command, args) => args[0] === 'list-keychains' ? 'ok' : '',
  });
}

describe('qlb doctor', () => {
  it('passes SQLite integrity and WARNs for an in-flight MIRRORED migration', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-test-'));
    const report = await doctorReport(home, (store) => {
      store.upsertMigration('pi-pool', 'MIRRORED', JSON.stringify({ qlbAccountIds: ['acct-a'] }));
    });
    assert.equal(report.checks.find((check) => check.name === 'sqlite')?.level, 'PASS');
    const migration = report.checks.find((check) => check.name === 'migrations');
    assert.equal(migration?.level, 'WARN');
    assert.match(migration?.message ?? '', /pi-pool=MIRRORED/);
    assert.equal(report.overall, 'WARN');
  });

  it('T-DOC-1: VALIDATED is advisory WARN, not complete/terminal/rolled-back', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-validated-'));
    const report = await doctorReport(home, (store) => {
      store.upsertMigration('pi-pool', 'VALIDATED', JSON.stringify({
        qlbAccountIds: ['acct-a'],
        rolledBackFrom: 'post-commit',
        ownerFilePath: join(home, '.pi', 'agent', 'qlb-owner.json'),
      }));
    });
    const migration = report.checks.find((check) => check.name === 'migrations');
    assert.equal(migration?.level, 'WARN');
    const expected = validatedAdvisoryMessage('pi-pool', 1);
    assert.match(migration?.message ?? '', new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(migration?.message ?? '', /terminal/i);
    assert.match(migration?.message ?? '', /not distinguished/);
  });

  it('WARNs for pre-switch VALIDATED with owner file present', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-validated-mid-'));
    const ownerDir = join(home, '.pi', 'agent');
    mkdirSync(ownerDir, { recursive: true });
    const ownerFile = join(ownerDir, 'qlb-owner.json');
    writeFileSync(ownerFile, '{"owner":"qlb"}\n');
    const report = await doctorReport(home, (store) => {
      store.upsertMigration('pi-pool', 'VALIDATED', JSON.stringify({
        qlbAccountIds: ['acct-a'],
        ownerFilePath: ownerFile,
      }));
    });
    const migration = report.checks.find((check) => check.name === 'migrations');
    assert.equal(migration?.level, 'WARN');
    assert.match(migration?.message ?? '', /prune-protected/);
  });

  it('WARNs untrusted VALIDATED JSON with the reason token', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-validated-badjson-'));
    const report = await doctorReport(home, (store) => {
      store.upsertMigration('pi-pool', 'VALIDATED', 'not-json');
    });
    const migration = report.checks.find((check) => check.name === 'migrations');
    assert.equal(migration?.level, 'WARN');
    assert.match(migration?.message ?? '', /untrusted \(malformed_json\)/);
  });

  it('native-retirement RETIRED with valid shape is not stuck (N1)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-retired-'));
    const report = await doctorReport(home, (store) => {
      store.upsertMigration('claude-code', 'RETIRED', JSON.stringify({
        retiredAt: Date.now(),
        retiredPath: '/tmp/cc',
        backupPath: '/tmp/cc.pre-qlb',
        sidecarPath: '/tmp/cc.pre-qlb.sidecar.json',
        fingerprint: 'ab'.repeat(32),
      }));
    });
    const migration = report.checks.find((check) => check.name === 'migrations');
    assert.equal(migration?.level, 'PASS');
  });

  it('WARNs when recovery marker is present', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-recovery-'));
    const report = await doctorReport(home, (store) => {
      store.setConfig('migrations.recovery_pending', '1');
    });
    const recovery = report.checks.find((check) => check.name === 'recovery');
    assert.equal(recovery?.level, 'WARN');
    assert.equal(
      recovery?.message,
      'recovery marker present — destructive maintenance refused until reconciled',
    );
  });

  it('returns FAIL for a corrupt SQLite store', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-corrupt-test-'));
    const config = defaultConfig(home);
    mkdirSync(join(home, '.qlb'), { recursive: true });
    writeFileSync(config.dbPath, 'not sqlite');

    const report = await doctorQlb(config, { command: () => 'ok' });
    assert.equal(report.overall, 'FAIL');
    assert.equal(report.checks.find((check) => check.name === 'sqlite')?.level, 'FAIL');
  });
});
