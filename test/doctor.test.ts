import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultConfig } from '../src/config';
import { createCommandRunner, doctorQlb, inspectProviders, registeredDoctorChecks } from '../src/diagnostics';
import { discoverChecks } from '../src/registry';
import { MACOS_SECURITY_TIMEOUT_MS } from '../src/keychain';
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
    hostCommand: () => '',
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
    // overall can be FAIL when unrelated hermes/pi machine checks fail; this case only asserts sqlite + migrations.
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

  it('emits recorded Keychain matrix and live-item authorization results on darwin', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-keychain-recorded-'));
    const values = new Map<string, string>([
      ['keychain.helperCheckResult', 'ok'],
      ['keychain.helperCheckPrompted', 'false'],
      ['keychain.helperCheckAt', '123'],
      ['keychain.helperCheckBinaryHash', 'binary-hash'],
      ['keychain.helperCheckIdentityHash', 'identity-hash'],
      ['keychain.liveItemsReadAuthorizedAt', '123'],
      ['keychain.liveItemsReadAuthorizedIdentityHash', 'identity-hash'],
    ]);
    const green = await doctorQlb(defaultConfig(home), {
      command: () => 'ok', hostCommand: () => '', hostPlatform: 'darwin', configReader: (key) => values.get(key) ?? null,
      helperSigning: () => ({ authority: 'QLB Keychain Helper', binaryHash: 'binary-hash', identityHash: 'identity-hash' }),
      helperIdentityVerifier: () => ({ trusted: true }), now: () => 124,
    });
    assert.equal(green.checks.find((check) => check.name === 'keychain:helper')?.level, 'PASS');
    assert.equal(green.checks.find((check) => check.name === 'keychain:live-items-authorized')?.level, 'PASS');

    values.set('keychain.helperCheckPrompted', 'true');
    values.delete('keychain.liveItemsReadAuthorizedAt');
    const blocked = await doctorQlb(defaultConfig(home), {
      command: () => 'ok', hostCommand: () => '', hostPlatform: 'darwin', configReader: (key) => values.get(key) ?? null,
      helperSigning: () => ({ authority: 'QLB Keychain Helper', binaryHash: 'binary-hash', identityHash: 'identity-hash' }),
      helperIdentityVerifier: () => ({ trusted: true }), now: () => 124,
    });
    assert.equal(blocked.checks.find((check) => check.name === 'keychain:helper')?.level, 'FAIL');
    assert.equal(blocked.checks.find((check) => check.name === 'keychain:live-items-authorized')?.level, 'WARN');
  });

  it('fails the helper doctor row when the recorded pin does not verify', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-keychain-pin-'));
    const values = new Map<string, string>([
      ['keychain.helperCheckResult', 'ok'],
      ['keychain.helperCheckPrompted', 'false'],
      ['keychain.helperCheckAt', '123'],
      ['keychain.helperCheckBinaryHash', 'binary-hash'],
      ['keychain.helperCheckIdentityHash', 'identity-hash'],
    ]);
    let pin: string | undefined;
    const report = await doctorQlb(defaultConfig(home), {
      command: () => 'ok', hostCommand: () => '', hostPlatform: 'darwin', configReader: (key) => values.get(key) ?? null,
      helperSigning: () => ({ authority: 'QLB Keychain Helper', binaryHash: 'binary-hash', identityHash: 'identity-hash' }),
      helperIdentityVerifier: (_path, candidate) => {
        pin = candidate;
        return { trusted: false, reason: 'pinned leaf certificate did not verify' };
      },
      now: () => 124,
    });
    assert.equal(pin, 'identity-hash');
    assert.equal(report.checks.find((check) => check.name === 'keychain:helper')?.level, 'FAIL');
  });

  it('bounds the production security command runner', () => {
    let timeoutMs: number | undefined;
    const run = createCommandRunner((_file, _args, options) => {
      timeoutMs = options?.timeout;
      return '';
    });

    assert.equal(run('/fake/security', ['list-keychains']), '');
    assert.equal(timeoutMs, MACOS_SECURITY_TIMEOUT_MS);
  });

  it('reports a timed out Keychain probe as WARN, never PASS', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-keychain-timeout-'));
    const timeout = Object.assign(new Error('fake security timed out'), { code: 'ETIMEDOUT' });
    const report = await doctorQlb(defaultConfig(home), {
      command: () => { throw timeout; },
    });
    const keychain = report.checks.find((check) => check.name === 'keychain');
    const openrouter = report.providers.find((provider) => provider.provider === 'openrouter');

    assert.equal(keychain?.level, 'WARN');
    assert.match(keychain?.message ?? '', /timed out after 5s/);
    assert.equal(openrouter?.level, 'WARN');
    assert.equal(openrouter?.message, 'security find-generic-password timed out after 5s');
    assert.doesNotMatch(openrouter?.message ?? '', /credential source not found/);
    assert.doesNotMatch(openrouter?.example ?? '', /security add-generic-password/);
  });

  it('reports the fixed pi-openrouter source and pinned security binary', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-openrouter-default-'));
    const config = defaultConfig(home);
    const calls: Array<{ command: string; args: string[] }> = [];
    const providers = inspectProviders(config, (command, args) => {
      calls.push({ command, args });
      return args[0] === 'find-generic-password' ? 'test-key' : 'ok';
    });
    const openrouter = providers.find((provider) => provider.provider === 'openrouter');

    assert.equal(openrouter?.level, 'PASS');
    assert.equal(openrouter?.source.includes('pi-openrouter'), true);
    assert.deepEqual(calls[0], {
      command: '/usr/bin/security',
      args: ['find-generic-password', '-s', 'pi-openrouter', '-w'],
    });
  });

  it('reports a non-default OpenRouter Keychain service as unsupported without a setup hint', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-openrouter-unsupported-'));
    const config = { ...defaultConfig(home), openrouterKeychainService: 'other-service' };
    const providers = inspectProviders(config, () => {
      throw new Error('unsupported service must not be probed');
    });
    const openrouter = providers.find((provider) => provider.provider === 'openrouter');

    assert.equal(openrouter?.level, 'WARN');
    assert.match(openrouter?.message ?? '', /only pi-openrouter is supported/);
    assert.doesNotMatch(openrouter?.message ?? '', /credential source not found|security add-generic-password/);
    assert.doesNotMatch(openrouter?.example ?? '', /security add-generic-password/);
  });

  it('returns FAIL for a corrupt SQLite store', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-corrupt-test-'));
    const config = defaultConfig(home);
    mkdirSync(join(home, '.qlb'), { recursive: true });
    writeFileSync(config.dbPath, 'not sqlite');

    const report = await doctorQlb(config, { command: () => 'ok', hostCommand: () => '' });
    assert.equal(report.overall, 'FAIL');
    assert.equal(report.checks.find((check) => check.name === 'sqlite')?.level, 'FAIL');
  });

  it('keeps a single sqlite FAIL when an older migrations schema cannot be queried', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-old-schema-'));
    const config = defaultConfig(home);
    mkdirSync(join(home, '.qlb'), { recursive: true });
    const db = new DatabaseSync(config.dbPath);
    db.exec('CREATE TABLE migrations (store TEXT, state TEXT)');
    db.close();

    const report = await doctorQlb(config, { command: () => 'ok', hostCommand: () => '' });
    const sqlite = report.checks.filter((check) => check.name === 'sqlite');
    assert.equal(sqlite.length, 1);
    assert.equal(sqlite[0]?.level, 'FAIL');
    assert.match(sqlite[0]?.message ?? '', /detail_json/);
  });

  it('keeps a failed integrity result when a later schema query fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-integrity-schema-'));
    const config = defaultConfig(home);
    mkdirSync(join(home, '.qlb'), { recursive: true });
    new DatabaseSync(config.dbPath).close();
    const sqlite = require('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
    const OriginalDatabaseSync = sqlite.DatabaseSync;
    sqlite.DatabaseSync = class IntegrityFailingDatabase extends OriginalDatabaseSync {
      override prepare(sql: string) {
        if (sql === 'PRAGMA integrity_check') {
          return { get: () => ({ integrity_check: 'fixture corruption' }) } as unknown as ReturnType<DatabaseSync['prepare']>;
        }
        if (sql.includes("sqlite_master WHERE type='table' AND name='migrations'")) {
          return { get: () => ({ name: 'migrations' }) } as unknown as ReturnType<DatabaseSync['prepare']>;
        }
        if (sql === 'SELECT store, state, detail_json FROM migrations') {
          throw new Error('fixture schema query failed');
        }
        return super.prepare(sql);
      }
    } as typeof DatabaseSync;
    try {
      const report = await doctorQlb(config, { command: () => 'ok', hostCommand: () => '' });
      const sqliteCheck = report.checks.find((check) => check.name === 'sqlite');
      assert.equal(sqliteCheck?.level, 'FAIL');
      assert.equal(sqliteCheck?.message, 'PRAGMA integrity_check failed; database query failed: fixture schema query failed');
      assert.deepEqual(sqliteCheck?.detail, {
        integrity: { integrity_check: 'fixture corruption' },
        queryError: 'fixture schema query failed',
      });
    } finally {
      sqlite.DatabaseSync = OriginalDatabaseSync;
    }
  });

  it('returns runtime checks and a registry FAIL when discovery cannot load', () => {
    const runtime = [{ name: 'sqlite', level: 'PASS' as const, message: 'fixture runtime check' }];
    const missing = join(mkdtempSync(join(tmpdir(), 'qlb-doctor-missing-checks-')), 'checks');
    const report = registeredDoctorChecks(runtime, () => discoverChecks(missing));

    assert.deepEqual(report.slice(0, -1), runtime);
    const registry = report.at(-1);
    assert.equal(registry?.name, 'doctor:registry');
    assert.equal(registry?.level, 'FAIL');
    assert.match(registry?.message ?? '', /ENOENT/);
  });

  it('returns a report with a registry WARN for unregistered and duplicate check names', () => {
    const report = registeredDoctorChecks([
      { name: 'not:registered', level: 'PASS', message: 'unexpected' },
      { name: 'sqlite', level: 'PASS', message: 'first' },
      { name: 'sqlite', level: 'FAIL', message: 'second' },
      { name: 'native-sync:account-1', level: 'WARN', message: 'drift' },
      { name: 'hermes:seam:anthropic_route_is_oauth', level: 'PASS', message: 'present' },
    ]);

    assert.equal(report.filter((check) => check.name === 'not:registered').length, 1);
    assert.equal(report.filter((check) => check.name === 'sqlite').length, 2);
    assert.equal(report.find((check) => check.name === 'native-sync:account-1')?.level, 'WARN');
    assert.equal(report.find((check) => check.name === 'hermes:seam:anthropic_route_is_oauth')?.level, 'PASS');
    const registry = report.find((check) => check.name === 'doctor:registry');
    assert.equal(registry?.level, 'WARN');
    assert.match(registry?.message ?? '', /not:registered/);
    assert.match(registry?.message ?? '', /duplicate sqlite/);
  });
});
