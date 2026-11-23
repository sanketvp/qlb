import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { codexFirstSwitchCheck } from '../src/checks/codex-first-switch';
import { codexSlotsCheck } from '../src/checks/codex-slots';
import type { HealthCheck } from '../src/checks/claude-slots';
import { openStore } from '../src/store';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const DAY = 86_400_000;
const cutover = { available: true as const, phase: 'cutover' };

function freshDb(seed?: (db: DatabaseSync) => void): string {
  const path = join(mkdtempSync(join(tmpdir(), 'qlb-codex-check-codes-')), 'qlb.db');
  openStore(path).close();
  if (seed) {
    const db = new DatabaseSync(path);
    try {
      seed(db);
    } finally {
      db.close();
    }
  }
  return path;
}

const missingDb = (): string => join(mkdtempSync(join(tmpdir(), 'qlb-codex-check-codes-missing-')), 'absent', 'qlb.db');
const lifecycle = (cutoverAt: number) => (db: DatabaseSync): void => {
  db.prepare("INSERT INTO lifecycle (state, began_at, cutover_at) VALUES ('cutover', ?, ?)").run(cutoverAt - DAY, cutoverAt);
};

/** Every WARN and FAIL outcome of the two checks, with today's level and message. */
function outcomes(): Array<{ outcome: string; result: HealthCheck; level: string; message: RegExp }> {
  return [
    {
      outcome: 'slots: phase unavailable',
      result: codexSlotsCheck(freshDb(), 'unknown'),
      level: 'WARN', message: /^lifecycle phase unavailable; Codex slots cannot be evaluated$/,
    },
    {
      outcome: 'slots: dead slot',
      result: codexSlotsCheck(freshDb((db) => {
        db.prepare(`INSERT INTO codex_slots (account_id, chatgpt_user_id, chatgpt_account_id, dead, dead_reason, added_at)
          VALUES ('fixture-user:fixture-account', 'fixture-user', 'fixture-account', 1, 'invalid_grant', 1)`).run();
      }), 'cutover'),
      level: 'FAIL', message: /^1 dead Codex slot\(s\) require re-login$/,
    },
    {
      outcome: 'slots: check threw',
      result: codexSlotsCheck(missingDb(), 'cutover'),
      level: 'FAIL', message: /^check failed: /,
    },
    {
      outcome: 'first-switch: phase unavailable',
      result: codexFirstSwitchCheck(freshDb(), { available: false, phase: 'unknown', reason: 'fixture' }, NOW),
      level: 'WARN', message: /^lifecycle phase unavailable$/,
    },
    {
      outcome: 'first-switch: receipt invalid',
      result: codexFirstSwitchCheck(freshDb((db) => {
        lifecycle(NOW - DAY)(db);
        db.prepare("INSERT INTO config (key, value) VALUES ('codex.l13VerifiedAt', 'not-a-time')").run();
      }), cutover, NOW),
      level: 'WARN', message: /^C9 receipt invalid$/,
    },
    {
      outcome: 'first-switch: cutover_at missing',
      result: codexFirstSwitchCheck(freshDb(), cutover, NOW),
      level: 'WARN', message: /^cutover_at missing$/,
    },
    {
      outcome: 'first-switch: receipt overdue',
      result: codexFirstSwitchCheck(freshDb(lifecycle(NOW - 4 * DAY)), cutover, NOW),
      level: 'WARN', message: /records the C9 receipt \(X2 step 4b\) — overdue$/,
    },
    {
      outcome: 'first-switch: check threw',
      result: codexFirstSwitchCheck(missingDb(), cutover, NOW),
      level: 'FAIL', message: /^check failed: /,
    },
  ];
}

describe('stable Codex check result codes', () => {
  it("keeps each outcome's level and message", () => {
    for (const { outcome, result, level, message } of outcomes()) {
      assert.equal(result.level, level, outcome);
      assert.match(result.message, message, outcome);
    }
  });

  it('gives each WARN and FAIL outcome of a check its own code', () => {
    const byCheck = new Map<string, Map<string, string>>();
    for (const { outcome, result } of outcomes()) {
      assert.equal(typeof result.code, 'string', `${outcome} has a code`);
      const codes = byCheck.get(result.name) ?? new Map<string, string>();
      assert.equal(codes.get(result.code!), undefined, `${outcome} reuses the code of ${codes.get(result.code!)}`);
      codes.set(result.code!, outcome);
      byCheck.set(result.name, codes);
    }
  });

  it('names a thrown check check-threw', () => {
    assert.equal(codexSlotsCheck(missingDb(), 'cutover').code, 'check-threw');
  });

  it('adds no code to PASS, INFO or N/A outcomes', () => {
    assert.equal(codexSlotsCheck(freshDb(), 'cutover').code, undefined);
    assert.equal(codexSlotsCheck(freshDb(), 'pre-cutover').code, undefined);
    assert.equal(codexFirstSwitchCheck(freshDb(lifecycle(NOW - DAY)), cutover, NOW).code, undefined);
  });
});
