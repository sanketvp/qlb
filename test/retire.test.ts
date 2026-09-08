import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  checkRetirementEligibility,
  MIN_OK_DECISIONS,
  retireNativeStore,
  SOAK_MS,
  type RetireHarness,
} from '../src/retire';
import { openStore, type Store } from '../src/store';

const temps: string[] = [];
after(() => {
  for (const dir of temps) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-retire-'));
  temps.push(dir);
  return dir;
}

function openTempStore(): { dir: string; store: Store } {
  const dir = tmp();
  return { dir, store: openStore(join(dir, 'qlb.db')) };
}

const HARNESS: RetireHarness = 'codex-cli';
const DAY = 24 * 60 * 60 * 1000;

function seedOwned(store: Store, committedAt: number, harness: RetireHarness = HARNESS): void {
  store.upsertMigration(
    harness,
    'QLB_OWNED',
    JSON.stringify({ committedAt }),
    committedAt,
  );
}

function seedOkDecisions(
  store: Store,
  count: number,
  harness: string,
  since: number,
): void {
  for (let i = 0; i < count; i++) {
    store.recordDecision({
      ts: since + i * 1000,
      harness,
      requested_model: 'gpt-5.4',
      mode: 'proxy',
      reason: 'ok',
      snapshot_json: JSON.stringify({ outcome: 'ok', n: i }),
    });
  }
}

function seedEligible(store: Store, harness: RetireHarness = HARNESS): { committedAt: number } {
  const committedAt = Date.now() - SOAK_MS - DAY;
  seedOwned(store, committedAt, harness);
  seedOkDecisions(store, MIN_OK_DECISIONS, harness, committedAt + 1000);
  return { committedAt };
}

describe('checkRetirementEligibility — Phase 4 gates', () => {
  it('returns false with a specific reason when migration state is not QLB_OWNED', () => {
    const { store } = openTempStore();
    try {
      const empty = checkRetirementEligibility(store, HARNESS);
      assert.equal(empty.eligible, false);
      assert.ok(
        empty.reasons.some((r) => /no migration recorded/i.test(r)),
        `expected "no migration recorded", got: ${empty.reasons.join(' | ')}`,
      );
      assert.ok(
        empty.reasons.some((r) => /migration state is not QLB_OWNED/i.test(r)),
        `expected "migration state is not QLB_OWNED", got: ${empty.reasons.join(' | ')}`,
      );

      store.upsertMigration(HARNESS, 'NATIVE', '{}');
      const native = checkRetirementEligibility(store, HARNESS);
      assert.equal(native.eligible, false);
      assert.ok(
        native.reasons.some((r) => /migration state is NATIVE, not QLB_OWNED/i.test(r)),
        `expected NATIVE-state reason, got: ${native.reasons.join(' | ')}`,
      );
    } finally {
      store.close();
    }
  });

  it('returns false with a soak-period reason when fewer than 7 days have elapsed', () => {
    const { store } = openTempStore();
    try {
      const committedAt = Date.now() - 2 * DAY;
      seedOwned(store, committedAt);
      seedOkDecisions(store, MIN_OK_DECISIONS, HARNESS, committedAt + 1000);
      const result = checkRetirementEligibility(store, HARNESS);
      assert.equal(result.eligible, false);
      assert.ok(
        result.reasons.some((r) => /7 days/i.test(r) && /elapsed/i.test(r)),
        `expected 7-day soak reason, got: ${result.reasons.join(' | ')}`,
      );
      assert.equal(
        result.reasons.some((r) => /only \d+ of 20 clean/i.test(r)),
        false,
        'soak-only fixture should not fail the decision-count gate',
      );
    } finally {
      store.close();
    }
  });

  it('returns false with a decision-count reason when fewer than 20 clean decisions exist', () => {
    const { store } = openTempStore();
    try {
      const committedAt = Date.now() - SOAK_MS - DAY;
      seedOwned(store, committedAt);
      seedOkDecisions(store, 5, HARNESS, committedAt + 1000);
      const result = checkRetirementEligibility(store, HARNESS);
      assert.equal(result.eligible, false);
      assert.ok(
        result.reasons.some((r) => /only 5 of 20 clean \(outcome=ok\) decisions/i.test(r)),
        `expected 20-decision reason, got: ${result.reasons.join(' | ')}`,
      );
    } finally {
      store.close();
    }
  });

  it('returns false when an unresolved failed/auth_* decision sits in the soak window', () => {
    const { store } = openTempStore();
    try {
      seedEligible(store);
      store.recordDecision({
        ts: Date.now() - DAY,
        harness: HARNESS,
        requested_model: 'gpt-5.4',
        mode: 'proxy',
        reason: 'auth_revoked',
        snapshot_json: JSON.stringify({ outcome: 'failed' }),
      });
      const result = checkRetirementEligibility(store, HARNESS);
      assert.equal(result.eligible, false);
      assert.ok(
        result.reasons.some((r) => /unresolved failed/i.test(r)),
        `expected unresolved-failed reason, got: ${result.reasons.join(' | ')}`,
      );
    } finally {
      store.close();
    }
  });

  it('returns true when all conditions are synthetically satisfied', () => {
    const { store } = openTempStore();
    try {
      seedEligible(store);
      const result = checkRetirementEligibility(store, HARNESS);
      assert.equal(result.eligible, true);
      assert.deepEqual(result.reasons, []);
      assert.equal(result.migrationState, 'QLB_OWNED');
      assert.equal(result.okDecisionCount, MIN_OK_DECISIONS);
      assert.equal(result.failedDecisionCount, 0);
    } finally {
      store.close();
    }
  });
});

describe('retireNativeStore — extra safety gates', () => {
  it('refuses when eligibility is false, even if confirmRealRetirement is true', async () => {
    const { dir, store } = openTempStore();
    const fixture = join(dir, 'auth.json');
    writeFileSync(fixture, '{"tokens":{}}\n', { encoding: 'utf8', mode: 0o600 });
    try {
      await assert.rejects(
        () =>
          retireNativeStore(store, HARNESS, {
            nativePathToRemove: fixture,
            confirmRealRetirement: true,
            pingFn: async () => true,
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /REFUSED/);
          assert.match(err.message, /not eligible/);
          return true;
        },
      );
      assert.equal(existsSync(fixture), true, 'ineligible retire must not touch the fixture');
    } finally {
      store.close();
    }
  });

  it('refuses when confirmRealRetirement is false, even if eligible', async () => {
    const { dir, store } = openTempStore();
    const fixture = join(dir, 'auth.json');
    writeFileSync(fixture, '{"tokens":{}}\n', { encoding: 'utf8', mode: 0o600 });
    seedEligible(store);
    try {
      await assert.rejects(
        () =>
          retireNativeStore(store, HARNESS, {
            nativePathToRemove: fixture,
            confirmRealRetirement: false,
            pingFn: async () => true,
          }),
        /REFUSED: confirmRealRetirement is required/,
      );
      assert.equal(existsSync(fixture), true, 'unconfirmed retire must not touch the fixture');
      assert.equal(store.getMigration(HARNESS)?.state, 'QLB_OWNED');
    } finally {
      store.close();
    }
  });

  it('refuses if the injected pingFn returns false even if everything else passes', async () => {
    const { dir, store } = openTempStore();
    const fixture = join(dir, 'auth.json');
    writeFileSync(fixture, '{"tokens":{}}\n', { encoding: 'utf8', mode: 0o600 });
    seedEligible(store);
    try {
      await assert.rejects(
        () =>
          retireNativeStore(store, HARNESS, {
            nativePathToRemove: fixture,
            confirmRealRetirement: true,
            pingFn: async () => false,
          }),
        /REFUSED: live native ping failed/,
      );
      assert.equal(existsSync(fixture), true, 'failed ping must not touch the fixture');
      assert.equal(store.getMigration(HARNESS)?.state, 'QLB_OWNED');
    } finally {
      store.close();
    }
  });

  it('happy path: retires only a TEMP fixture, journals RETIRED', async () => {
    const { dir, store } = openTempStore();
    const fixture = join(dir, 'auth.json');
    const payload = '{"tokens":{"access_token":"fixture-only"}}\n';
    writeFileSync(fixture, payload, { encoding: 'utf8', mode: 0o600 });
    seedEligible(store);

    const resolved = resolve(fixture);
    assert.ok(
      resolved.startsWith(resolve(dir) + sep),
      `fixture must live under the temp dir, got ${resolved}`,
    );
    assert.equal(resolved.includes(`${sep}.codex${sep}`), false);
    assert.equal(resolved.includes(`${sep}.claude${sep}`), false);

    try {
      const result = await retireNativeStore(store, HARNESS, {
        nativePathToRemove: fixture,
        confirmRealRetirement: true,
        pingFn: async () => true,
      });
      assert.equal(result.ok, true);
      assert.equal(result.state, 'RETIRED');
      assert.equal(result.harness, HARNESS);
      assert.equal(existsSync(fixture), false, 'original fixture path must be gone');
      assert.equal(existsSync(result.backupPath), true);
      assert.equal(existsSync(result.sidecarPath), true);
      assert.equal(readFileSync(result.backupPath, 'utf8'), payload);
      assert.equal(store.getMigration(HARNESS)?.state, 'RETIRED');
      const sidecar = JSON.parse(readFileSync(result.sidecarPath, 'utf8')) as {
        harness: string;
        fingerprint: string;
      };
      assert.equal(sidecar.harness, HARNESS);
      assert.equal(typeof sidecar.fingerprint, 'string');
      assert.ok(sidecar.fingerprint.length > 0);
    } finally {
      store.close();
    }
  });
});
