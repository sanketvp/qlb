import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { parseOpenRouterCredits } from '../src/adapters/openrouter';
import { SqliteClaudeSlotRepository } from '../src/cc-slots';
import { defaultConfig } from '../src/config';
import { doctorQlb } from '../src/diagnostics';
import { parseUsageHeaders } from '../src/proxy';
import { resolveFromSnapshots } from '../src/resolve';
import { classifyProviderPercentage, PROVIDER_READING_MAX_AGE_MS } from '../src/routing-authority';
import {
  openStore,
  readOnlySchemaRefusal,
  USAGE_DISCREPANCY_MAX_ROWS,
  USAGE_DISCREPANCY_RETENTION_MS,
  USAGE_DISCREPANCY_TOLERANCE_PCT,
  usageDiscrepancyAggregate,
} from '../src/store';
import type { BucketReading } from '../src/types';

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'qlb-provider-discrepancy-')), 'qlb.db');
}

function reading(
  usedPct: number | null,
  source: BucketReading['source'],
  confidence: BucketReading['confidence'] = 'authoritative',
  fetchedAt = Date.now(),
): BucketReading {
  return { usedPct, source, confidence, fetchedAt };
}

function provider(usedPct: number | null, fetchedAt = Date.now()): BucketReading {
  return reading(usedPct, 'provider-poll', 'authoritative', fetchedAt);
}

function local(usedPct: number | null, fetchedAt = Date.now()): BucketReading {
  return reading(usedPct, 'poll', 'authoritative', fetchedAt);
}

function rows(path: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM usage_discrepancies ORDER BY id').all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function snapshotDecision(accountId: string, buckets: Record<string, BucketReading>) {
  return resolveFromSnapshots({
    model: 'claude-sonnet-5',
    snapshots: [{ accountId, provider: 'anthropic', label: accountId, buckets }],
  });
}

describe('provider usage discrepancy records', () => {
  it('keeps provider 70 canonical vs QLB 90 in both arrival orders', async () => {
    for (const order of ['qlb-then-provider', 'provider-then-qlb'] as const) {
      const path = dbPath();
      const now = Date.now();
      const store = openStore(path);
      try {
        if (order === 'qlb-then-provider') {
          store.upsertSnapshot('acct', '5h', local(90, now - 1));
          store.upsertSnapshot('acct', '5h', provider(70, now));
        } else {
          store.upsertSnapshot('acct', '5h', provider(70, now - 1));
          store.upsertSnapshot('acct', '5h', local(90, now));
        }
        assert.equal(store.getSnapshot('acct', '5h')?.usedPct, 70);
        const persisted = rows(path);
        assert.equal(persisted.length, 1);
        assert.equal(persisted[0]?.resolution, 'provider-wins-discrepancy');
        assert.equal(persisted[0]?.provider_value, 70);
        assert.equal(persisted[0]?.comparison_value, 90);
        assert.equal(persisted[0]?.tolerance, USAGE_DISCREPANCY_TOLERANCE_PCT);
        const decision = snapshotDecision('acct', store.getAllSnapshots('acct'));
        assert.equal(decision.ok, true);
        if (decision.ok) assert.equal(decision.snapshot.buckets['5h']?.usedPct, 70);
      } finally {
        store.close();
      }
      const report = await doctorQlb({
        ...defaultConfig(mkdtempSync(join(tmpdir(), 'qlb-provider-doctor-'))),
        dbPath: path,
      }, { command: () => '', hostCommand: () => '', hostPlatform: 'linux' });
      const check = report.checks.find(({ name }) => name === 'usage:provider-discrepancies');
      assert.equal(check?.level, 'WARN');
      assert.match(check?.message ?? '', /1 provider-wins discrepancy/);
    }
  });

  it('records a one-point disagreement, ignores a pair skewed beyond five minutes, and dedupes value pairs', () => {
    const path = dbPath();
    const now = Date.now();
    const store = openStore(path);
    try {
      store.upsertSnapshot('bound', '5h', local(71, now - 1));
      store.upsertSnapshot('bound', '5h', provider(70, now));
      const onePoint = rows(path).filter((row) => row.account_id === 'bound');
      assert.equal(onePoint.length, 1);
      assert.equal(onePoint[0]?.provider_value, 70);
      assert.equal(onePoint[0]?.comparison_value, 71);

      store.upsertSnapshot('skew', '5h', local(90, now - PROVIDER_READING_MAX_AGE_MS - 1));
      store.upsertSnapshot('skew', '5h', provider(70, now));
      assert.equal(rows(path).filter((row) => row.account_id === 'skew').length, 0);

      store.upsertSnapshot('pair', '5h', local(90, now - 1));
      store.upsertSnapshot('pair', '5h', provider(70, now));
      store.upsertSnapshot('pair', '5h', local(90, now + 2));
      assert.equal(rows(path).filter((row) => row.account_id === 'pair').length, 1);
      store.upsertSnapshot('pair', '5h', local(91, now + 3));
      const persisted = rows(path);
      const pairRows = persisted.filter((row) => row.account_id === 'pair');
      assert.equal(pairRows.length, 2);
      assert.deepEqual(pairRows.map((row) => row.comparison_value).sort(), [90, 91]);
    } finally {
      store.close();
    }
  });

  it('keeps a recurring discrepancy in the thirty-day doctor window', () => {
    const path = dbPath();
    const firstObservedAt = 1_700_000_000_000;
    const recurringAt = firstObservedAt + USAGE_DISCREPANCY_RETENTION_MS - 0.1 * 24 * 60 * 60 * 1000;
    const checkedAt = firstObservedAt + USAGE_DISCREPANCY_RETENTION_MS + 0.1 * 24 * 60 * 60 * 1000;
    const originalNow = Date.now;
    const store = openStore(path);
    try {
      Date.now = () => firstObservedAt;
      store.upsertSnapshot('recurring', '5h', local(90, firstObservedAt - 1));
      store.upsertSnapshot('recurring', '5h', provider(70, firstObservedAt));
      Date.now = () => recurringAt;
      store.upsertSnapshot('recurring', '5h', local(90, firstObservedAt - 1));

      const persisted = rows(path);
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0]?.observed_at, firstObservedAt);
      assert.equal(persisted[0]?.last_observed_at, recurringAt);
      const ledger = new DatabaseSync(path, { readOnly: true });
      try {
        assert.deepEqual(usageDiscrepancyAggregate(ledger, checkedAt), { discrepancies: 1, anomalies: 0 });
      } finally {
        ledger.close();
      }
    } finally {
      Date.now = originalNow;
      store.close();
    }
  });

  it('classifies null as absent, 101 as exhausted, and negative/non-finite as one anomaly', () => {
    const path = dbPath();
    const now = Date.now();
    const store = openStore(path);
    try {
      store.upsertSnapshot('nulls', '5h', provider(null, now));
      store.upsertSnapshot('overspend', '5h', provider(101, now));
      store.upsertSnapshot('overspend', '7d', provider(101, now));
      store.upsertSnapshot('bad', '5h', provider(-1, now));
      store.upsertSnapshot('bad', '5h', provider(-1, now + 1));
      store.upsertSnapshot('nan', '5h', provider(Number.NaN, now));
      store.upsertSnapshot('nan', '5h', provider(Number.NaN, now + 1));

      const openrouterOverspend = parseOpenRouterCredits({ data: { total_credits: 10, total_usage: 15 } }, now);
      assert.equal(classifyProviderPercentage(openrouterOverspend.credits?.usedPct), 'exhausted');
      const openrouterAbsent = parseOpenRouterCredits({ data: { total_credits: 0, total_usage: 0 } }, now);
      assert.equal(classifyProviderPercentage(openrouterAbsent.credits?.usedPct), 'absent');
      const kimiUsed = 150;
      const kimiLimit = 100;
      const kimiOverspend = (kimiUsed / kimiLimit) * 100;
      assert.equal(classifyProviderPercentage(kimiOverspend), 'exhausted');

      assert.equal(rows(path).filter((row) => row.account_id === 'nulls').length, 0);
      assert.equal(rows(path).filter((row) => row.account_id === 'overspend').length, 0);
      const anomalies = rows(path).filter((row) => row.resolution === 'provider-anomaly-unavailable');
      assert.equal(anomalies.length, 2);
      assert.equal(store.getSnapshot('overspend', '5h')?.usedPct, 101);
      const exhausted = snapshotDecision('overspend', store.getAllSnapshots('overspend'));
      assert.equal(exhausted.ok, false);
      if (!exhausted.ok) assert.equal(exhausted.error, 'EXHAUSTED');
      const unavailable = snapshotDecision('bad', store.getAllSnapshots('bad'));
      assert.equal(unavailable.ok, false);
      if (!unavailable.ok) assert.equal(unavailable.error, 'UNAVAILABLE');
    } finally {
      store.close();
    }
  });

  it('records the same canonical snapshot and one discrepancy on poll, header, and import writes', () => {
    const now = Date.now();
    const path = dbPath();
    const store = openStore(path);
    try {
      store.upsertSnapshot('poll', '5h', local(90, now - 1));
      store.recordUsagePollResult('anthropic', 'poll', {
        attemptedAt: Math.floor(now / 1000),
        status: 'ok',
        readings: { '5h': provider(70, now) },
      });
      assert.equal(store.getSnapshot('poll', '5h')?.usedPct, 70);

      store.upsertSnapshot('headers', 'primary', local(90, now - 1));
      const headerReadings = parseUsageHeaders({ 'x-codex-primary-used-percent': '70' }, now);
      for (const [bucket, value] of Object.entries(headerReadings)) {
        store.upsertSnapshot('headers', bucket, value);
      }
      assert.equal(store.getSnapshot('headers', 'primary')?.usedPct, 70);

      store.upsertSnapshot('claim', '5h', local(90, now - 1));
      assert.equal(store.claimPoll('claim', 'holder', 60_000), true);
      const claim = store.getPollClaim('claim');
      assert.ok(claim);
      assert.equal(store.completePoll('claim', 'holder', claim.claimed_at, { '5h': provider(70, now) }), true);
      assert.equal(store.getSnapshot('claim', '5h')?.usedPct, 70);

      store.upsertSnapshot('import', '5h', provider(70, now - 1));
    } finally {
      store.close();
    }

    const repository = SqliteClaudeSlotRepository.open(path);
    try {
      repository.commitCswapImport({
        runId: 'disc-import',
        startedAt: now,
        committedAt: now,
        slots: [{
          slot: {
            accountId: 'import',
            fingerprint: 'fp',
            prevFingerprint: null,
            addedAt: now,
            configJson: '{}',
          },
          lineageFrom: null,
        }],
        activeAccountId: null,
        snapshots: [{ accountId: 'import', bucket: '5h', usedPct: 90, fetchedAt: now }],
      });
    } finally {
      repository.close();
    }

    const reopened = openStore(path);
    try {
      assert.equal(reopened.getSnapshot('import', '5h')?.usedPct, 70);
      assert.equal(reopened.getSnapshot('import', '5h')?.source, 'provider-poll');
      const persisted = rows(path);
      assert.equal(persisted.length, 4);
      assert.ok(persisted.every((row) => row.resolution === 'provider-wins-discrepancy'));
      assert.ok(persisted.every((row) => row.provider_value === 70 && row.comparison_value === 90));
    } finally {
      reopened.close();
    }
  });

  it('tolerates a real v6 database without usage_discrepancies until a writer migrates it', async () => {
    const path = dbPath();
    const now = Date.now();
    let store = openStore(path);
    store.upsertAccount('existing', 'anthropic', 'existing');
    store.upsertSnapshot('existing', '5h', local(42, now));
    store.close();

    const raw = new DatabaseSync(path);
    raw.exec('DROP TABLE usage_discrepancies');
    assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 6);
    assert.equal((raw.prepare('SELECT used_pct FROM snapshots WHERE account_id = ?').get('existing') as { used_pct: number }).used_pct, 42);
    raw.close();

    const readonly = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(readOnlySchemaRefusal(readonly), null);
      assert.deepEqual(usageDiscrepancyAggregate(readonly), { discrepancies: 0, anomalies: 0 });
    } finally {
      readonly.close();
    }
    const report = await doctorQlb({
      ...defaultConfig(mkdtempSync(join(tmpdir(), 'qlb-provider-migrate-doctor-'))),
      dbPath: path,
    }, { command: () => '', hostCommand: () => '', hostPlatform: 'linux' });
    const check = report.checks.find(({ name }) => name === 'usage:provider-discrepancies');
    assert.equal(check?.level, 'PASS');
    assert.equal(report.checks.find(({ name }) => name === 'sqlite')?.level, 'PASS');

    const backupsDir = join(dirname(path), 'backups');
    const beforeBackups = existsSync(backupsDir) ? new Set(readdirSync(backupsDir)) : new Set<string>();
    store = openStore(path);
    assert.equal(store.getSnapshot('existing', '5h')?.usedPct, 42);
    store.close();
    const newBackups = existsSync(backupsDir)
      ? readdirSync(backupsDir).filter((name) => !beforeBackups.has(name) && name.endsWith('.sqlite'))
      : [];
    assert.equal(newBackups.length, 1);

    const migrated = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'usage_discrepancies'").get() as { count: number }).count, 1);
      assert.equal((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 6);
      assert.equal((migrated.prepare('SELECT used_pct FROM snapshots WHERE account_id = ?').get('existing') as { used_pct: number }).used_pct, 42);
    } finally {
      migrated.close();
    }

    store = openStore(path);
    store.close();
    const again = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal((again.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'usage_discrepancies'").get() as { count: number }).count, 1);
    } finally {
      again.close();
    }
  });

  it('purges expired rows on the next insert and caps to 10000 preferring recent discrepancies', () => {
    const path = dbPath();
    const now = Date.now();
    const store = openStore(path);
    store.close();

    const raw = new DatabaseSync(path);
    raw.exec('BEGIN');
    const insert = raw.prepare(`INSERT INTO usage_discrepancies (
      observed_at, last_observed_at, account_id, bucket, source_class, comparison_source_class,
      provider_observed_at, comparison_observed_at, provider_value, comparison_value,
      tolerance, resolution
    ) VALUES (?, ?, 'seed', ?, 'provider-direct', NULL, ?, NULL, -1, NULL, ?, 'provider-anomaly-unavailable')`);
    for (let index = 0; index < USAGE_DISCREPANCY_MAX_ROWS + 1; index += 1) {
      insert.run(now - 1_000 - index, now - 1_000 - index, `b${index}`, now, USAGE_DISCREPANCY_TOLERANCE_PCT);
    }
    raw.prepare(`INSERT INTO usage_discrepancies (
      observed_at, last_observed_at, account_id, bucket, source_class, comparison_source_class,
      provider_observed_at, comparison_observed_at, provider_value, comparison_value,
      tolerance, resolution
    ) VALUES (?, ?, 'expired', '5h', 'provider-direct', NULL, ?, NULL, -2, NULL, ?, 'provider-anomaly-unavailable')`)
      .run(now - USAGE_DISCREPANCY_RETENTION_MS - 1, now - USAGE_DISCREPANCY_RETENTION_MS - 1, now - USAGE_DISCREPANCY_RETENTION_MS - 1, USAGE_DISCREPANCY_TOLERANCE_PCT);
    raw.exec('COMMIT');
    raw.close();

    const writer = openStore(path);
    try {
      writer.upsertSnapshot('fresh', '5h', local(90, now - 1));
      writer.upsertSnapshot('fresh', '5h', provider(70, now));
      const persisted = rows(path);
      assert.equal(persisted.length, USAGE_DISCREPANCY_MAX_ROWS);
      assert.ok(persisted.some((row) => row.account_id === 'fresh' && row.resolution === 'provider-wins-discrepancy'));
      assert.equal(persisted.some((row) => row.account_id === 'expired'), false);
      assert.equal(persisted.filter((row) => row.resolution === 'provider-anomaly-unavailable').length, USAGE_DISCREPANCY_MAX_ROWS - 1);
    } finally {
      writer.close();
    }
  });

  it('removes audit rows with the account cascade', () => {
    const path = dbPath();
    const now = Date.now();
    const store = openStore(path);
    try {
      store.upsertAccount('acct', 'anthropic', 'acct');
      store.upsertSnapshot('acct', '5h', local(90, now - 1));
      store.upsertSnapshot('acct', '5h', provider(70, now));
      assert.equal(rows(path).length, 1);
      const removed = store.deleteAccountCascade('acct');
      assert.equal(removed.usageDiscrepancies, 1);
      assert.equal(rows(path).length, 0);
    } finally {
      store.close();
    }
  });

  it('doctor counts only in-window rows and does not probe providers', async () => {
    const path = dbPath();
    const now = Date.now();
    const store = openStore(path);
    store.upsertSnapshot('acct', '5h', local(90, now - 1));
    store.upsertSnapshot('acct', '5h', provider(70, now));
    store.close();

    const raw = new DatabaseSync(path);
    raw.prepare(`INSERT INTO usage_discrepancies (
      observed_at, last_observed_at, account_id, bucket, source_class, comparison_source_class,
      provider_observed_at, comparison_observed_at, provider_value, comparison_value,
      tolerance, resolution
    ) VALUES (?, ?, 'old', '5h', 'provider-direct', 'local', ?, ?, 70, 90, ?, 'provider-wins-discrepancy')`)
      .run(now - USAGE_DISCREPANCY_RETENTION_MS - 1, now - USAGE_DISCREPANCY_RETENTION_MS - 1, now, now, USAGE_DISCREPANCY_TOLERANCE_PCT);
    raw.close();

    const report = await doctorQlb({
      ...defaultConfig(mkdtempSync(join(tmpdir(), 'qlb-provider-window-doctor-'))),
      dbPath: path,
    }, { command: () => '', hostCommand: () => '', hostPlatform: 'linux', live: false });
    const check = report.checks.find(({ name }) => name === 'usage:provider-discrepancies');
    assert.equal(check?.level, 'WARN');
    assert.match(check?.message ?? '', /1 provider-wins discrepancy/);
    assert.doesNotMatch(JSON.stringify(report), /sk-ant-|Authorization|Bearer /);
    assert.equal(report.providers.every((row) => row.live == null), true);
  });

  it('reports discrepancy records as unreadable when the database query fails', async () => {
    const path = dbPath();
    writeFileSync(path, 'not a sqlite database');
    const report = await doctorQlb({
      ...defaultConfig(mkdtempSync(join(tmpdir(), 'qlb-provider-unreadable-'))),
      dbPath: path,
    }, { command: () => '', hostCommand: () => '', hostPlatform: 'linux' });
    const check = report.checks.find(({ name }) => name === 'usage:provider-discrepancies');
    assert.equal(check?.level, 'WARN');
    assert.equal(check?.message, 'could not read discrepancy records');
  });

  it('never persists token-shaped detail or headers', async () => {
    const path = dbPath();
    const secret = 'sk-ant-api03-fixture-secret-must-not-persist';
    const store = openStore(path);
    try {
      store.upsertSnapshot('acct', '5h', {
        ...local(90),
        detail: secret,
      });
      store.upsertSnapshot('acct', '5h', {
        ...provider(70),
        detail: `Authorization: Bearer ${secret}`,
      });
    } finally {
      store.close();
    }
    const persisted = JSON.stringify(rows(path));
    assert.doesNotMatch(persisted, new RegExp(secret));
    assert.doesNotMatch(persisted, /Authorization|Bearer /);
    const report = await doctorQlb({
      ...defaultConfig(mkdtempSync(join(tmpdir(), 'qlb-provider-redact-doctor-'))),
      dbPath: path,
    }, { command: () => '', hostCommand: () => '', hostPlatform: 'linux' });
    assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
  });
});
