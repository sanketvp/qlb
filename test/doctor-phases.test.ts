import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { claudeLoginExpiryCheck } from '../src/checks/claude-login-expiry';
import { claudeUnclaimedCheck } from '../src/checks/claude-unclaimed';
import { claudeUnpersistedTokenCheck } from '../src/checks/claude-unpersisted-token';
import { strayTempDirectories, strayTempsCheck } from '../src/checks/fs-stray-temps';
import { defaultConfig } from '../src/config';
import { doctorQlb, s64DoctorVerdict } from '../src/diagnostics';
import { LIFECYCLE_STATES } from '../src/checks/lifecycle-phase';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { openStore } from '../src/store';
import { recordStash } from '../src/unclaimed-index';

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

async function withTestQlbHome<T>(home: string, operation: () => Promise<T>): Promise<T> {
  const previousTestMode = process.env.QLB_TEST_MODE;
  const previousQlbHome = process.env.QLB_HOME;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.QLB_TEST_MODE = '1';
  process.env.QLB_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  try {
    return await operation();
  } finally {
    if (previousTestMode === undefined) delete process.env.QLB_TEST_MODE;
    else process.env.QLB_TEST_MODE = previousTestMode;
    if (previousQlbHome === undefined) delete process.env.QLB_HOME;
    else process.env.QLB_HOME = previousQlbHome;
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  }
}

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

function credential(expiresAt: unknown, tokens: Record<string, string> = {}): string {
  return JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: expiresAt, ...tokens } });
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
    const row = claudeLoginExpiryCheck(dbPath, keychain(['expired', credential(NOW - 1, {
      refreshToken: 'refresh-token-value', accessToken: 'access-token-value',
    })]), NOW);
    assert.deepEqual(row, {
      name: 'claude:login-expiry', level: 'FAIL',
      message: 'expired Claude login: expired (2025-12-31T23:59:59Z)',
    });
    assert.doesNotMatch(JSON.stringify(row), /refresh-token-value|access-token-value/);

    const unreadable = claudeLoginExpiryCheck(dbPath, keychain(), NOW);
    assert.equal(unreadable.level, 'WARN');
    assert.equal(unreadable.message, 'Claude credential unreadable for slot expired');
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

  it('keeps missing expiry observations visible alongside valid logins', () => {
    const dbPath = fixture();
    insertSlot(dbPath, 'valid');
    insertSlot(dbPath, 'unreported');
    assert.deepEqual(claudeLoginExpiryCheck(dbPath, keychain(
      ['valid', credential(NOW + 8 * 24 * 60 * 60 * 1_000)],
      ['unreported', credential(0)],
    ), NOW), {
      name: 'claude:login-expiry', level: 'PASS',
      message: 'Claude login expiry is valid; expiry not reported for slot unreported',
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

describe('claude:unclaimed doctor check', () => {
  const stashId = '2025-11-30T00-00-00.000Z-fixture';

  async function stash(root: string, createdAt: number): Promise<void> {
    await recordStash(root, {
      provider: 'anthropic', accountId: 'slot-1', stashId, consumedFp: 'fixture-lineage', location: 'keychain', createdAt,
    });
  }

  it('WARNs for an older stash and names the restore command without reading credentials', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-doctor-unclaimed-old-'));
    await stash(root, NOW - 30 * 24 * 60 * 60 * 1_000 - 1);
    assert.deepEqual(await claudeUnclaimedCheck(root, 'cutover', NOW), {
      name: 'claude:unclaimed', level: 'WARN',
      message: `1 unclaimed Claude stash(es) older than 30 days: qlb claude restore-unclaimed ${stashId} slot-1`,
    });
  });

  it('reports an INFO count for younger stashes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-doctor-unclaimed-young-'));
    await stash(root, NOW - 1);
    assert.deepEqual(await claudeUnclaimedCheck(root, 'retired', NOW), {
      name: 'claude:unclaimed', level: 'INFO', message: '1 unclaimed Claude stash(es) younger than 30 days',
    });
  });

  it('PASSes when no stashes exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-doctor-unclaimed-none-'));
    assert.deepEqual(await claudeUnclaimedCheck(root, 'cutover', NOW), {
      name: 'claude:unclaimed', level: 'PASS', message: 'no unclaimed Claude stashes',
    });
  });

  it('FAILs closed for unavailable or malformed index metadata', async () => {
    const unavailableRoot = mkdtempSync(join(tmpdir(), 'qlb-doctor-unclaimed-index-unavailable-'));
    mkdirSync(join(unavailableRoot, 'index'), { recursive: true });
    writeFileSync(join(unavailableRoot, 'index', 'anthropic'), 'not a directory');
    const unavailable = await claudeUnclaimedCheck(unavailableRoot, 'cutover', NOW);
    assert.deepEqual(unavailable, {
      name: 'claude:unclaimed', level: 'FAIL', message: 'unclaimed stash index unavailable',
    });

    const malformedRoot = mkdtempSync(join(tmpdir(), 'qlb-doctor-unclaimed-index-malformed-'));
    mkdirSync(join(malformedRoot, 'index', 'anthropic'), { recursive: true });
    writeFileSync(join(malformedRoot, 'index', 'anthropic', `${stashId}.json`), 'not JSON');
    const malformed = await claudeUnclaimedCheck(malformedRoot, 'cutover', NOW);
    assert.deepEqual(malformed, {
      name: 'claude:unclaimed', level: 'FAIL', message: 'unclaimed stash index contains malformed metadata',
    });
    assert.deepEqual(s64DoctorVerdict({ checks: [unavailable, malformed], providers: [] }), {
      overall: 'FAIL', autoAgent: 'FAIL',
    });
  });

  it('WARNs when the lifecycle phase is unavailable or invalid, and is N/A before cutover', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-doctor-unclaimed-unavailable-'));
    assert.deepEqual(await claudeUnclaimedCheck(root, 'unknown', NOW), {
      name: 'claude:unclaimed', level: 'WARN', message: 'lifecycle phase unavailable; unclaimed Claude stashes cannot be evaluated',
    });
    assert.deepEqual(await claudeUnclaimedCheck(root, 'invalid-phase', NOW), {
      name: 'claude:unclaimed', level: 'WARN', message: 'cannot evaluate: unknown lifecycle state',
    });
    assert.deepEqual(await claudeUnclaimedCheck(root, 'pre-cutover', NOW), {
      name: 'claude:unclaimed', level: 'N/A', message: 'not applicable in phase=pre-cutover',
    });
  });

  it('uses the production stash root and the injected stash-root seam in cutover', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-unclaimed-wiring-'));
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    store.close();
    const db = new DatabaseSync(config.dbPath);
    try {
      db.prepare('INSERT INTO lifecycle (state, began_at) VALUES (?, ?)').run('cutover', NOW);
    } finally {
      db.close();
    }
    const productionRoot = join(home, '.qlb', 'unclaimed');
    const seamRoot = mkdtempSync(join(tmpdir(), 'qlb-doctor-unclaimed-seam-'));
    await stash(productionRoot, NOW - 30 * 24 * 60 * 60 * 1_000 - 1);
    await stash(seamRoot, NOW - 1);
    await withTestQlbHome(home, async () => {
      const productionReport = await doctorQlb(config, {
        command: () => '', hostCommand: () => '', now: () => NOW,
      });
      assert.deepEqual(productionReport.checks.find((row) => row.name === 'claude:unclaimed'), {
        name: 'claude:unclaimed', level: 'WARN',
        message: `1 unclaimed Claude stash(es) older than 30 days: qlb claude restore-unclaimed ${stashId} slot-1`,
      });
    });
    const seamReport = await doctorQlb(config, {
      command: () => '', hostCommand: () => '', now: () => NOW, claudeUnclaimedStashDir: seamRoot,
    });
    assert.deepEqual(seamReport.checks.find((row) => row.name === 'claude:unclaimed'), {
      name: 'claude:unclaimed', level: 'INFO', message: '1 unclaimed Claude stash(es) younger than 30 days',
    });
  });
});

describe('claude:unpersisted-token doctor check', () => {
  function recordUsage(dbPath: string, accountId: string, status: string, attemptedAt: number, succeeded = false): void {
    const store = openStore(dbPath);
    try {
      store.recordUsagePollResult('anthropic', accountId, {
        attemptedAt,
        status,
        readings: succeeded ? {
          '5h': { usedPct: 1, fetchedAt: attemptedAt * 1000, source: 'poll', confidence: 'authoritative' },
        } : undefined,
      });
    } finally {
      store.close();
    }
  }

  function insertSwitch(dbPath: string, accountId: string, outcome: string, at: number, injected: number, detail: string | null, fromAccount: string | null = null): void {
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`INSERT INTO switch_log (ts, provider, from_account, to_account, trigger, outcome, injected, detail)
        VALUES (?, 'anthropic', ?, ?, 'manual', ?, ?, ?)`).run(at, fromAccount, accountId, outcome, injected, detail);
    } finally {
      db.close();
    }
  }

  function insertLineage(dbPath: string, accountId: string, at: number): void {
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`INSERT INTO lineage_log (ts, provider, account_id, to_fp, cause, by)
        VALUES (?, 'anthropic', ?, 'replacement', 'replace', 'test')`).run(at, accountId);
    } finally {
      db.close();
    }
  }

  it('claude:unpersisted-token fails on an unpersisted successor with no later recovery', () => {
    const dbPath = fixture();
    insertSlot(dbPath, 'successor');
    insertSwitch(dbPath, 'successor', 'refused', NOW, 0, 'freshen-consume-gate-unpersisted');
    const row = claudeUnpersistedTokenCheck(dbPath, 'cutover');
    assert.equal(row.level, 'FAIL');
    assert.match(row.message, /successor/);
    assert.match(row.message, /re-login affected slot/);
  });

  it('claude:unpersisted-token fails on an auto.log unpersisted line with no later lineage', () => {
    const dbPath = fixture();
    insertSlot(dbPath, 'active');
    const log = join(dirname(dbPath), 'auto.log');
    writeFileSync(log, `unknown line\nclaude:unpersisted-token provider=anthropic account=active at=${NOW}\n`);
    const row = claudeUnpersistedTokenCheck(dbPath, 'retired');
    assert.equal(row.level, 'FAIL');
    assert.match(row.message, /active/);
  });

  it('claude:unpersisted-token does not clear after a successful poll', () => {
    const dbPath = fixture();
    insertSlot(dbPath, 'active');
    writeFileSync(join(dirname(dbPath), 'auto.log'), `claude:unpersisted-token provider=anthropic account=active at=${NOW}`);
    recordUsage(dbPath, 'active', 'ok', Math.floor(NOW / 1000) + 1, true);
    assert.equal(claudeUnpersistedTokenCheck(dbPath, 'cutover').level, 'FAIL');
  });

  it('claude:unpersisted-token does not recover after switch-away and switch-back alone', () => {
    for (const [outcome, injected, detail, fromAccount] of [
      ['ok', 1, 'fault-injection:breaker-rows:seed', 'other'],
      ['ok', 0, null, 'active'],
      ['noop', 0, null, 'active'],
      ['ok', 0, 'republish', 'active'],
      ['ok', 0, null, 'other'],
    ] as const) {
      const dbPath = fixture();
      insertSlot(dbPath, 'active');
      insertSwitch(dbPath, 'active', 'refused', NOW, 0, 'freshen-consume-gate-unpersisted');
      insertSwitch(dbPath, 'active', outcome, NOW + 1, injected, detail, fromAccount);
      assert.equal(claudeUnpersistedTokenCheck(dbPath, 'cutover').level, 'FAIL');
    }
  });

  it('claude:unpersisted-token does not let earlier lineage recover later poll evidence', () => {
    const dbPath = fixture();
    insertSlot(dbPath, 'inactive');
    insertLineage(dbPath, 'inactive', NOW - 1);
    recordUsage(dbPath, 'inactive', 'consume-consume-gate-unpersisted', Math.floor(NOW / 1000));
    assert.equal(claudeUnpersistedTokenCheck(dbPath, 'cutover').level, 'FAIL');
  });

  it('claude:unpersisted-token passes after later lineage replaces poll evidence', () => {
    const dbPath = fixture();
    insertSlot(dbPath, 'active');
    recordUsage(dbPath, 'active', 'consume-consume-gate-unpersisted', Math.floor(NOW / 1000));
    insertLineage(dbPath, 'active', NOW + 1);
    assert.equal(claudeUnpersistedTokenCheck(dbPath, 'cutover').level, 'PASS');
  });

  it('claude:unpersisted-token retains poll evidence after a later successful poll', () => {
    const dbPath = fixture();
    insertSlot(dbPath, 'active');
    recordUsage(dbPath, 'active', 'consume-consume-gate-unpersisted', Math.floor(NOW / 1000));
    recordUsage(dbPath, 'active', 'ok', Math.floor(NOW / 1000) + 1, true);
    assert.equal(claudeUnpersistedTokenCheck(dbPath, 'cutover').level, 'FAIL');
  });

  it('claude:unpersisted-token does not recover from another slot lineage', () => {
    const dbPath = fixture();
    insertSlot(dbPath, 'lost');
    insertSlot(dbPath, 'other');
    insertSwitch(dbPath, 'lost', 'refused', NOW, 0, 'freshen-consume-gate-unpersisted');
    insertLineage(dbPath, 'other', NOW + 1);
    const row = claudeUnpersistedTokenCheck(dbPath, 'cutover');
    assert.equal(row.level, 'FAIL');
    assert.match(row.message, /lost/);
  });

  it('claude:unpersisted-token ignores dead and archived slot evidence', () => {
    for (const [accountId, archivedAt, dead] of [
      ['dead', null, 1],
      ['archived', NOW, 0],
    ] as const) {
      const dbPath = fixture();
      insertSlot(dbPath, accountId, archivedAt, dead);
      insertSwitch(dbPath, accountId, 'refused', NOW, 0, 'freshen-consume-gate-unpersisted');
      assert.equal(claudeUnpersistedTokenCheck(dbPath, 'cutover').level, 'PASS');
    }
  });

  it('claude:unpersisted-token warns when auto.log is unreadable', () => {
    const dbPath = fixture();
    const log = join(dirname(dbPath), 'auto.log');
    mkdirSync(log);
    assert.deepEqual(claudeUnpersistedTokenCheck(dbPath, 'cutover'), {
      name: 'claude:unpersisted-token', level: 'WARN', message: 'auto.log unreadable',
    });
  });

  it('claude:unpersisted-token fails on database evidence when auto.log is unreadable', () => {
    const dbPath = fixture();
    insertSlot(dbPath, 'inactive');
    insertSwitch(dbPath, 'inactive', 'refused', NOW, 0, 'freshen-consume-gate-unpersisted');
    mkdirSync(join(dirname(dbPath), 'auto.log'));
    const row = claudeUnpersistedTokenCheck(dbPath, 'cutover');
    assert.equal(row.level, 'FAIL');
    assert.match(row.message, /auto\.log unreadable/);
  });

  it('claude:unpersisted-token is N/A pre-cutover', () => {
    assert.deepEqual(claudeUnpersistedTokenCheck(fixture(), 'pre-cutover'), {
      name: 'claude:unpersisted-token', level: 'N/A', message: 'not applicable in phase=pre-cutover',
    });
  });
});

describe('fs:stray-temps doctor check', () => {
  it('WARNs with every atomic-publish path in every lifecycle phase without deleting files', async () => {
    for (const state of LIFECYCLE_STATES) {
      const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-stray-temps-phase-'));
      try {
        await withTestQlbHome(home, async () => {
          const config = defaultConfig(home);
          const store = openStore(config.dbPath);
          store.close();
          const db = new DatabaseSync(config.dbPath);
          try {
            db.prepare('INSERT INTO lifecycle (state, began_at) VALUES (?, ?)').run(state, NOW);
          } finally {
            db.close();
          }
          const backupRoot = join(home, '.qlb', 'backups', 'pi-auth');
          const backupLeaf = join(backupRoot, 'by-auth', '0123456789abcdef');
          mkdirSync(backupLeaf, { recursive: true });
          const directories = [
            home,
            join(home, '.qlb'),
            join(home, '.qlb', 'journal'),
            join(home, '.claude'),
            join(home, 'Library', 'LaunchAgents'),
            join(home, '.codex'),
            join(home, '.pi', 'agent'),
            backupRoot,
            backupLeaf,
          ];
          const paths = directories.map((directory, index) => {
            mkdirSync(directory, { recursive: true });
            const path = join(directory, `.qlb-target-${index}.999999999.aaaaaaaaaaaaaaaa.tmp`);
            writeFileSync(path, 'not a credential');
            const old = new Date(Date.now() - 61_000);
            utimesSync(path, old, old);
            return path;
          });

          const report = await doctorQlb(config, { command: () => '', hostCommand: () => '' });
          const row = report.checks.find((check) => check.name === 'fs:stray-temps');
          assert.equal(row?.level, 'WARN', state);
          for (const path of paths) {
            assert.match(row?.message ?? '', new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
            assert.equal(existsSync(path), true, state);
          }
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it('PASSes when published targets contain no qualifying temporary files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-stray-temps-none-'));
    try {
      await withTestQlbHome(home, async () => {
        const config = defaultConfig(home);
        const store = openStore(config.dbPath);
        store.close();
        const report = await doctorQlb(config, { command: () => '', hostCommand: () => '' });
        assert.deepEqual(report.checks.find((check) => check.name === 'fs:stray-temps'), {
          name: 'fs:stray-temps', level: 'PASS', message: 'no stray temporary files found',
        });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('retains findings across unreadable directories and skips absent duplicate directories', () => {
    const found = '/qlb/found.tmp';
    const result = strayTempsCheck({
      directories: ['/qlb', '/qlb/.', '/absent', '/unreadable'],
      exists: (directory) => directory !== '/absent',
      list: (directory) => {
        if (directory === '/unreadable') throw new Error('EACCES');
        return [found];
      },
    });
    assert.deepEqual(result, {
      name: 'fs:stray-temps',
      level: 'WARN',
      message: `1 stray temporary file found: ${found}; unable to inspect stray temporary files in /unreadable`,
      detail: { paths: [found], unreadableDirectories: ['/unreadable'] },
    });
  });

  it('reports temps beside configured Codex and Pi publish targets', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-stray-temps-configured-'));
    try {
      await withTestQlbHome(home, async () => {
        const config = defaultConfig(home);
        config.codexAuthJsonPath = join(home, 'custom-codex', 'auth.json');
        config.piAuthJsonPath = join(home, 'custom-pi', 'auth.json');
        config.anthropicPoolPath = join(home, 'custom-pool', 'anthropic-pool.json');
        const store = openStore(config.dbPath);
        store.close();
        const paths = [config.codexAuthJsonPath, config.piAuthJsonPath, config.anthropicPoolPath].map((target, index) => {
          const directory = dirname(target);
          mkdirSync(directory, { recursive: true });
          const path = join(directory, `.qlb-target-${index}.999999999.aaaaaaaaaaaaaaaa.tmp`);
          writeFileSync(path, 'not a credential');
          const old = new Date(Date.now() - 61_000);
          utimesSync(path, old, old);
          return path;
        });
        const report = await doctorQlb(config, { command: () => '', hostCommand: () => '' });
        const row = report.checks.find((check) => check.name === 'fs:stray-temps');
        assert.equal(row?.level, 'WARN');
        assert.deepEqual(row?.detail, { paths, unreadableDirectories: [] });
        for (const path of paths) assert.equal(existsSync(path), true);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('discovers only immediate Pi backup leaves without following symlinks', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-stray-temps-backups-'));
    try {
      await withTestQlbHome(home, async () => {
        const root = join(home, '.qlb', 'backups', 'pi-auth', 'by-auth');
        const leaf = join(root, '0123456789abcdef');
        const nested = join(leaf, 'nested');
        mkdirSync(nested, { recursive: true });
        mkdirSync(join(root, 'not-a-hash'));
        symlinkSync(leaf, join(root, 'fedcba9876543210'));
        assert.deepEqual(strayTempDirectories(home).filter((directory) => directory.startsWith(root)), [leaf]);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('doctor lifecycle phase fixtures (HP-H3-11)', () => {
  const PHASES = ['pre-cutover', 'cutting-over', 'cutover', 'undoing', 'rolled-back', 'retired'] as const;
  type Phase = (typeof PHASES)[number];

  function level(report: Awaited<ReturnType<typeof doctorQlb>>, name: string): string | undefined {
    return report.checks.find((row) => row.name === name)?.level;
  }

  async function runFixture(phase: Phase): Promise<Awaited<ReturnType<typeof doctorQlb>>> {
    const home = mkdtempSync(join(tmpdir(), `qlb-doctor-phase-${phase}-`));
    const config = defaultConfig(home);
    const store = openStore(config.dbPath);
    store.close();
    const db = new DatabaseSync(config.dbPath);
    try {
      db.prepare('INSERT INTO lifecycle (state, began_at, undo_began_at) VALUES (?, ?, ?)')
        .run(phase, NOW, phase === 'undoing' || phase === 'rolled-back' ? NOW : null);
      if (phase === 'cutover') {
        db.prepare("INSERT INTO claude_slots (account_id, config_json, dead, added_at) VALUES ('dead-slot', '{}', 1, ?)").run(NOW);
        db.prepare("INSERT INTO config (key, value) VALUES ('auto.anthropic.suspendedUntil', ?)").run(String(Date.UTC(2099, 0, 1)));
      }
      if (phase === 'retired') {
        db.prepare("INSERT INTO config (key, value) VALUES ('auto.heartbeatAt', ?)").run(String(NOW));
      }
    } finally {
      db.close();
    }
    return withTestQlbHome(home, async () => {
      const report = await doctorQlb(config, {
        appendHealthLog: true,
        command: () => '',
        hostCommand: () => '',
        hostPlatform: 'linux',
        hostShell: undefined,
        hostShellExists: () => false,
        keychain: keychain(),
        now: () => NOW,
        piProcessList: () => '',
        cswapProcesses: () => [],
        cswapAgentStatus: () => 'not-loaded',
      });
      const healthRows = new DatabaseSync(config.dbPath);
      try {
        const { count } = healthRows.prepare('SELECT COUNT(*) AS count FROM health_log').get() as { count: number };
        assert.equal(count, 1, phase);
        const healthLogId = report.healthLogId;
        assert.ok(healthLogId !== undefined, phase);
        const row = healthRows.prepare('SELECT ts, phase, overall, dead_slots_json AS deadSlotsJson FROM health_log WHERE id = ?')
          .get(healthLogId) as { ts: number; phase: string; overall: string; deadSlotsJson: string } | undefined;
        assert.ok(row, phase);
        assert.equal(row.ts, NOW, phase);
        assert.equal(row.phase, phase, phase);
        assert.equal(row.overall, report.s64.overall, phase);
        assert.deepEqual(JSON.parse(row.deadSlotsJson), phase === 'cutover' ? ['dead-slot'] : [], phase);
      } finally {
        healthRows.close();
      }
      assert.equal(level(report, 'doctor:registry'), 'PASS', phase);
      return report;
    });
  }

  it('covers each phase class with controlled health-log, applicability, and S64 fixtures', async () => {
    const reports = new Map<Phase, Awaited<ReturnType<typeof doctorQlb>>>();
    for (const phase of PHASES) {
      reports.set(phase, await runFixture(phase));
    }

    for (const [phase, report] of reports) {
      for (const name of ['claude:login-expiry', 'fs:stray-temps', 'claude:version-drift', 'claude:locks', 'hosts:env', 'release:current']) {
        assert.notEqual(level(report, name), 'N/A', `${phase}: ${name} applies in every phase`);
      }
      const alwaysApplicable = report.checks.filter((row) => row.name.startsWith('claude:config-') || row.name.startsWith('keychain:'));
      assert.ok(alwaysApplicable.length > 0, `${phase}: expected config and keychain rows`);
      for (const row of alwaysApplicable) assert.notEqual(row.level, 'N/A', `${phase}: ${row.name} applies in every phase`);
    }

    const pre = reports.get('pre-cutover')!;
    for (const name of ['claude:slots', 'codex:slots', 'claude:active', 'relogin:7d', 'auto:parked', 'auto:agent', 'claude:switch-journal', 'journal:in-progress', 'journal:orphaned', 'undo:incomplete', 'undo:lineage-match']) {
      assert.equal(level(pre, name), 'N/A', `pre-cutover ${name}`);
    }
    for (const row of pre.checks.filter((row) => row.level === 'N/A')) {
      assert.equal(s64DoctorVerdict({ checks: [row], providers: [] }).overall, 'PASS', row.name);
    }
    assert.equal(pre.s64.overall, 'PASS');
    assert.deepEqual(
      s64DoctorVerdict({ checks: pre.checks.filter((row) => row.level !== 'N/A'), providers: pre.providers }),
      pre.s64,
      'N/A rows do not affect the aggregate S64 verdict',
    );

    assert.equal(reports.get('cutting-over')!.s64.overall, 'PASS');

    const cutover = reports.get('cutover')!;
    assert.equal(level(cutover, 'claude:slots'), 'FAIL', JSON.stringify(cutover.checks.find((row) => row.name === 'claude:slots')));
    assert.equal(level(cutover, 'auto:anthropic:breaker'), 'FAIL', JSON.stringify(cutover.checks.find((row) => row.name === 'auto:anthropic:breaker')));
    assert.equal(cutover.s64.overall, 'FAIL');

    const undoing = reports.get('undoing')!;
    assert.equal(level(undoing, 'undo:incomplete'), 'FAIL');
    assert.equal(undoing.s64.overall, 'FAIL');
    for (const name of ['undo:lineage-match', 'journal:in-progress', 'journal:orphaned', 'claude:slots', 'claude:active']) {
      assert.equal(level(undoing, name), 'N/A', `undoing ${name}`);
    }

    const rolledBack = reports.get('rolled-back')!;
    assert.equal(level(rolledBack, 'undo:incomplete'), 'PASS');
    assert.equal(level(rolledBack, 'undo:lineage-match'), 'PASS');
    assert.equal(rolledBack.s64.overall, 'PASS');
    const retired = reports.get('retired')!;
    assert.equal(level(retired, 'auto:agent'), 'PASS');
    assert.equal(level(retired, 'cswap:agent'), 'PASS');
    assert.equal(level(retired, 'cswap:processes'), 'PASS');
    assert.equal(retired.s64.overall, 'PASS');
  });
});
