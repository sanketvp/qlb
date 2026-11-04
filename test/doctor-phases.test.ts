import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { claudeLoginExpiryCheck } from '../src/checks/claude-login-expiry';
import { defaultConfig } from '../src/config';
import { doctorQlb, s64DoctorVerdict } from '../src/diagnostics';
import { LIFECYCLE_STATES } from '../src/checks/lifecycle-phase';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { openStore } from '../src/store';

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

function fixture(): string {
  const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-phases-'));
  const dbPath = join(home, 'qlb.db');
  const store = openStore(dbPath);
  store.close();
  return dbPath;
}

function insertSlot(dbPath: string, accountId: string, archivedAt: number | null = null, dead = 0): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`INSERT INTO claude_slots (account_id, config_json, dead, added_at, archived_at)
      VALUES (?, '{}', ?, ?, ?)`).run(accountId, dead, NOW, archivedAt);
  } finally {
    db.close();
  }
}

function credential(expiresAt: unknown): string {
  return JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: expiresAt } });
}

function keychain(...entries: Array<[string, string]>): MockKeychain {
  const result = new MockKeychain();
  for (const [accountId, value] of entries) {
    result.setSync(qlbKeychainService('anthropic', accountId), QLB_KEYCHAIN_ACCOUNT, value);
  }
  return result;
}

describe('claude:login-expiry doctor check', () => {
  it('is advisory, checks only live slots, and never exposes credential failures', () => {
    const dbPath = fixture();
    insertSlot(dbPath, 'expired');
    insertSlot(dbPath, 'archived', NOW);
    insertSlot(dbPath, 'dead', null, 1);
    const row = claudeLoginExpiryCheck(dbPath, keychain(['expired', credential(NOW - 1)]), NOW);
    assert.deepEqual(row, {
      name: 'claude:login-expiry', level: 'FAIL',
      message: 'expired Claude login: expired (2025-12-31T23:59:59Z)',
    });

    const unreadable = claudeLoginExpiryCheck(dbPath, keychain(), NOW);
    assert.equal(unreadable.level, 'WARN');
    assert.equal(unreadable.message, 'Claude credential unreadable for slot expired');
    assert.doesNotMatch(JSON.stringify(unreadable), /refresh-token-value/);
  });

  it('reports missing expiry, near expiry, and valid expiry without refresh or writes', () => {
    const dbPath = fixture();
    insertSlot(dbPath, 'slot');
    assert.deepEqual(claudeLoginExpiryCheck(dbPath, keychain(['slot', credential(0)]), NOW), {
      name: 'claude:login-expiry', level: 'PASS', message: 'expiry not reported',
    });
    assert.deepEqual(claudeLoginExpiryCheck(dbPath, keychain(['slot', credential(NOW + 7 * 24 * 60 * 60 * 1_000)]), NOW), {
      name: 'claude:login-expiry', level: 'WARN',
      message: 'Claude login expires within 7 days: slot (2026-01-08T00:00:00Z)',
    });
    assert.deepEqual(claudeLoginExpiryCheck(dbPath, keychain(['slot', credential(NOW + 8 * 24 * 60 * 60 * 1_000)]), NOW), {
      name: 'claude:login-expiry', level: 'PASS', message: 'Claude login expiry is valid',
    });
  });

  it('warns when a live slot credential is not parseable', () => {
    const dbPath = fixture();
    insertSlot(dbPath, 'slot');
    const row = claudeLoginExpiryCheck(dbPath, keychain(['slot', 'not-json']), NOW);
    assert.deepEqual(row, {
      name: 'claude:login-expiry', level: 'WARN',
      message: 'Claude credential unreadable for slot slot',
    });
    assert.doesNotMatch(JSON.stringify(row), /not-json/);
  });

  it('reports every non-passing login expiry observation together', () => {
    const dbPath = fixture();
    insertSlot(dbPath, 'expired');
    insertSlot(dbPath, 'unreadable');
    insertSlot(dbPath, 'expiring');
    assert.deepEqual(claudeLoginExpiryCheck(dbPath, keychain(
      ['expired', credential(NOW - 1)],
      ['expiring', credential(NOW + 7 * 24 * 60 * 60 * 1_000)],
    ), NOW), {
      name: 'claude:login-expiry', level: 'FAIL',
      message: 'expired Claude login: expired (2025-12-31T23:59:59Z); Claude credential unreadable for slot unreadable; Claude login expires within 7 days: expiring (2026-01-08T00:00:00Z)',
    });
  });

  it('runs in every lifecycle phase and does not lower the S64 verdict', async () => {
    for (const state of LIFECYCLE_STATES) {
      const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-login-expiry-phase-'));
      const config = defaultConfig(home);
      const store = openStore(config.dbPath);
      store.close();
      insertSlot(config.dbPath, 'slot');
      const db = new DatabaseSync(config.dbPath);
      try {
        db.prepare('INSERT INTO lifecycle (state, began_at) VALUES (?, ?)').run(state, NOW);
      } finally {
        db.close();
      }
      const report = await doctorQlb(config, {
        command: () => '', hostCommand: () => '', now: () => NOW,
        keychain: keychain(['slot', credential(NOW - 1)]),
      });
      assert.equal(report.checks.find((row) => row.name === 'claude:login-expiry')?.level, 'FAIL', state);
      assert.deepEqual(s64DoctorVerdict({
        checks: [{ name: 'claude:login-expiry', level: 'FAIL', message: 'expired Claude login: slot' }],
        providers: [],
      }), { overall: 'PASS', autoAgent: 'FAIL' }, state);
    }
  });

  it('passes when there are no live Claude slots', () => {
    assert.deepEqual(claudeLoginExpiryCheck(fixture(), keychain(), NOW), {
      name: 'claude:login-expiry', level: 'PASS', message: 'no live Claude slots',
    });
  });
});
