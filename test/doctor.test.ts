import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/config';
import { doctorQlb } from '../src/diagnostics';
import { openStore } from '../src/store';

async function doctorMigrations(
  home: string,
  seed: (store: ReturnType<typeof openStore>, config: ReturnType<typeof defaultConfig>) => void,
) {
  const config = defaultConfig(home);
  const store = openStore(config.dbPath);
  seed(store, config);
  store.close();
  const report = await doctorQlb(config, {
    command: (_command, args) => args[0] === 'list-keychains' ? 'ok' : '',
  });
  return report.checks.find((check) => check.name === 'migrations');
}

describe('qlb doctor', () => {
  it('passes SQLite integrity and prominently warns about an incomplete migration', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-test-'));
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    store.upsertMigration('pi-pool', 'MIRRORED', JSON.stringify({ qlbAccountIds: ['acct-a'] }));
    store.close();

    const report = await doctorQlb(config, {
      command: (_command, args) => args[0] === 'list-keychains' ? 'ok' : '',
    });
    assert.equal(report.checks.find((check) => check.name === 'sqlite')?.level, 'PASS');
    const migration = report.checks.find((check) => check.name === 'migrations');
    assert.equal(migration?.level, 'WARN');
    assert.match(migration?.message ?? '', /migrate resume or qlb migrate rollback/);
    assert.equal(report.overall, 'WARN');
  });

  it('treats post-rollback VALIDATED with ownerFile absent as PASS, not WARN', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-validated-'));
    const migration = await doctorMigrations(home, (store) => {
      store.upsertMigration('pi-pool', 'VALIDATED', JSON.stringify({
        qlbAccountIds: ['acct-a'],
        rolledBackFrom: 'post-commit',
        ownerFilePath: join(home, '.pi', 'agent', 'qlb-owner.json'),
      }));
    });
    assert.equal(migration?.level, 'PASS');
    assert.match(migration?.message ?? '', /no incomplete migrations/);
  });

  it('still WARNs for VALIDATED when the owner file is mid-flight (present)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-validated-mid-'));
    const ownerDir = join(home, '.pi', 'agent');
    mkdirSync(ownerDir, { recursive: true });
    const ownerFile = join(ownerDir, 'qlb-owner.json');
    writeFileSync(ownerFile, '{"owner":"qlb"}\n');
    const migration = await doctorMigrations(home, (store) => {
      store.upsertMigration('pi-pool', 'VALIDATED', JSON.stringify({
        qlbAccountIds: ['acct-a'],
        ownerFilePath: ownerFile,
      }));
    });
    assert.equal(migration?.level, 'WARN');
  });

  it('WARNs for VALIDATED with malformed JSON', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-validated-badjson-'));
    const migration = await doctorMigrations(home, (store) => {
      store.upsertMigration('pi-pool', 'VALIDATED', 'not-json');
    });
    assert.equal(migration?.level, 'WARN');
  });

  it('WARNs for VALIDATED with missing ownerFilePath (does not guess default)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-validated-nopath-'));
    const migration = await doctorMigrations(home, (store) => {
      store.upsertMigration('pi-pool', 'VALIDATED', JSON.stringify({
        qlbAccountIds: ['acct-a'],
        rolledBackFrom: 'post-commit',
      }));
    });
    assert.equal(migration?.level, 'WARN');
  });

  it('WARNs for VALIDATED with empty ownerFilePath', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-validated-emptypath-'));
    const migration = await doctorMigrations(home, (store) => {
      store.upsertMigration('pi-pool', 'VALIDATED', JSON.stringify({
        qlbAccountIds: ['acct-a'],
        ownerFilePath: '',
        rolledBackFrom: 'post-commit',
      }));
    });
    assert.equal(migration?.level, 'WARN');
  });

  it('WARNs for VALIDATED with wrong-typed ownerFilePath even if custom staging exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-validated-wrongpath-'));
    const customOwner = join(home, 'custom-owner.json');
    writeFileSync(`${customOwner}.staging`, '{"owner":"qlb"}\n');
    const migration = await doctorMigrations(home, (store) => {
      store.upsertMigration('pi-pool', 'VALIDATED', JSON.stringify({
        qlbAccountIds: ['acct-a'],
        ownerFilePath: 123,
      }));
    });
    assert.equal(migration?.level, 'WARN');
  });

  it('WARNs for VALIDATED with files absent but missing rollback evidence', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-validated-noreb-'));
    const ownerFile = join(home, '.pi', 'agent', 'qlb-owner.json');
    const migration = await doctorMigrations(home, (store) => {
      store.upsertMigration('pi-pool', 'VALIDATED', JSON.stringify({
        qlbAccountIds: ['acct-a'],
        ownerFilePath: ownerFile,
      }));
    });
    assert.equal(migration?.level, 'WARN');
  });

  it('WARNs for VALIDATED with invalid rolledBackFrom', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-validated-badreb-'));
    const ownerFile = join(home, '.pi', 'agent', 'qlb-owner.json');
    const migration = await doctorMigrations(home, (store) => {
      store.upsertMigration('pi-pool', 'VALIDATED', JSON.stringify({
        qlbAccountIds: ['acct-a'],
        ownerFilePath: ownerFile,
        rolledBackFrom: 'pre-commit',
      }));
    });
    assert.equal(migration?.level, 'WARN');
  });

  it('WARNs for VALIDATED with empty/mixed qlbAccountIds even with rollback evidence', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-validated-emptyids-'));
    const ownerFile = join(home, '.pi', 'agent', 'qlb-owner.json');
    const migration = await doctorMigrations(home, (store) => {
      store.upsertMigration('pi-pool', 'VALIDATED', JSON.stringify({
        qlbAccountIds: ['ok', ''],
        ownerFilePath: ownerFile,
        rolledBackFrom: 'post-commit',
      }));
    });
    assert.equal(migration?.level, 'WARN');
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
