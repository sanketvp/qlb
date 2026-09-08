import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/config';
import { doctorQlb } from '../src/diagnostics';
import { openStore } from '../src/store';

describe('qlb doctor', () => {
  it('passes SQLite integrity and prominently warns about an incomplete migration', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-test-'));
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    store.upsertMigration('pi-pool', 'MIRRORED');
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
