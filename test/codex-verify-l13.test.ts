import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { codexFirstSwitchCheck } from '../src/checks/codex-first-switch';
import type { LifecycleState } from '../src/checks/lifecycle-phase';
import { openStore, openStoreConnection } from '../src/store';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const RECEIPT_MESSAGE = 'automatic Codex switching stays off until qlb codex verify-l13 --complete records the C9 receipt (X2 step 4b)';

function fixture(state: LifecycleState, cutoverAt: number | null = null): { home: string; dbPath: string } {
  const home = mkdtempSync(join(tmpdir(), 'qlb-codex-verify-l13-'));
  const dbPath = join(home, 'qlb.db');
  openStore(dbPath).close();
  const db = openStoreConnection(dbPath);
  try {
    db.prepare('INSERT INTO lifecycle (state, began_at, cutover_at) VALUES (?, ?, ?)').run(state, NOW, cutoverAt);
  } finally {
    db.close();
  }
  return { home, dbPath };
}

function check(state: LifecycleState, cutoverAt: number | null = null) {
  const subject = fixture(state, cutoverAt);
  return {
    ...subject,
    result: codexFirstSwitchCheck(subject.dbPath, { available: true, phase: state }, NOW),
  };
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('QLB_') || key.startsWith('HERMES_') || key.startsWith('PI_')) delete env[key];
  }
  return {
    ...env,
    HOME: home,
    QLB_HOME: home,
    QLB_TEST_MODE: '1',
    HERMES_HOME: join(home, '.hermes'),
    QLB_ANTHROPIC_POOL_PATH: join(home, 'missing-anthropic-pool.json'),
    QLB_PI_AUTH_JSON_PATH: join(home, 'missing-pi-auth.json'),
    QLB_CODEX_AUTH_JSON_PATH: join(home, 'missing-codex-auth.json'),
    QLB_KIMI_CREDENTIALS_FILE: join(home, 'missing-kimi-credentials.md'),
    QLB_OPENROUTER_KEYCHAIN_SERVICE: 'qlb-test-codex-first-switch-missing-openrouter',
    QLB_DB_PATH: join(home, '.qlb', 'qlb.db'),
    QLB_PLUGINS_DIR: join(home, '.qlb', 'plugins'),
    QLB_PROXY_INFO_PATH: join(home, '.qlb', 'proxy.json'),
    QLB_CLAUDE_CODE_CREDENTIALS_PATH: join(home, '.claude', 'missing-credentials'),
    QLB_CSWAP_SEQUENCE_PATH: join(home, '.claude-swap-backup', 'missing-sequence.json'),
    QLB_CSWAP_USAGE_PATH: join(home, '.claude-swap-backup', 'cache', 'missing-usage.json'),
    QLB_CONFIG_PATH: join(home, '.qlb', 'config.json'),
    QLB_HERMES_PLUGIN_STATUS: join(home, '.qlb', 'hermes-plugin.json'),
    QLB_PI_PACKAGE_ROOT: join(home, 'missing-pi-package'),
  };
}

describe('C6b-4 codex:first-switch', () => {
  it('codex:first-switch is N/A in pre-cutover', () => {
    const subject = check('pre-cutover');
    try {
      assert.deepEqual(subject.result, {
        name: 'codex:first-switch', level: 'N/A', message: 'not applicable in phase=pre-cutover',
      });
    } finally {
      rmSync(subject.home, { recursive: true, force: true });
    }
  });

  it('codex:first-switch is INFO in cutting-over', () => {
    const subject = check('cutting-over');
    try {
      assert.deepEqual(subject.result, { name: 'codex:first-switch', level: 'INFO', message: RECEIPT_MESSAGE });
    } finally {
      rmSync(subject.home, { recursive: true, force: true });
    }
  });

  it('codex:first-switch is INFO within 3 days of cutover_at without the receipt', () => {
    const subject = check('cutover', NOW - (3 * DAY_MS));
    try {
      assert.deepEqual(subject.result, { name: 'codex:first-switch', level: 'INFO', message: RECEIPT_MESSAGE });
    } finally {
      rmSync(subject.home, { recursive: true, force: true });
    }
  });

  it('codex:first-switch is WARN 4 days after cutover_at without the receipt', () => {
    const subject = check('cutover', NOW - (4 * DAY_MS));
    try {
      assert.deepEqual(subject.result, { name: 'codex:first-switch', level: 'WARN', message: `${RECEIPT_MESSAGE} — overdue` });
    } finally {
      rmSync(subject.home, { recursive: true, force: true });
    }
  });

  it('codex:first-switch is PASS once codex.l13VerifiedAt is set', () => {
    const subject = check('cutover', NOW - (4 * DAY_MS));
    try {
      const db = openStoreConnection(subject.dbPath);
      try {
        db.prepare("INSERT INTO config (key, value) VALUES ('codex.l13VerifiedAt', ?)").run(String(NOW - DAY_MS));
      } finally {
        db.close();
      }
      assert.deepEqual(codexFirstSwitchCheck(subject.dbPath, { available: true, phase: 'cutover' }, NOW), {
        name: 'codex:first-switch', level: 'PASS', message: `C9 receipt recorded at ${new Date(NOW - DAY_MS).toISOString()}`,
      });
    } finally {
      rmSync(subject.home, { recursive: true, force: true });
    }
  });

  it('codex:first-switch is PASS in retired', () => {
    const subject = check('retired');
    try {
      assert.deepEqual(subject.result, {
        name: 'codex:first-switch', level: 'PASS', message: 'retire refuses codex-l13-missing',
      });
    } finally {
      rmSync(subject.home, { recursive: true, force: true });
    }
  });

  it('codex:first-switch is WARN when the lifecycle phase is unavailable', () => {
    assert.deepEqual(codexFirstSwitchCheck('unused.db', {
      available: false, phase: 'unknown', reason: 'fixture unavailable',
    }, NOW), {
      name: 'codex:first-switch', level: 'WARN', message: 'lifecycle phase unavailable',
    });
  });

  it('doctor --list-checks lists codex:first-switch', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-verify-l13-cli-'));
    try {
      const output = execFileSync(process.execPath, [join(__dirname, '..', 'src', 'cli.js'), 'doctor', '--list-checks', '--json'], {
        encoding: 'utf8',
        env: isolatedEnv(home),
      });
      assert.ok((JSON.parse(output) as string[]).includes('codex:first-switch'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('doctor emits codex:first-switch', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-codex-verify-l13-doctor-'));
    try {
      const result = spawnSync(process.execPath, [join(__dirname, '..', 'src', 'cli.js'), 'doctor', '--json'], {
        encoding: 'utf8', env: isolatedEnv(home),
      });
      assert.ok(result.status === 0 || result.status === 1, result.stderr);
      const checks = (JSON.parse(result.stdout) as { checks: Array<{ name: string; level: string; message: string }> }).checks;
      assert.deepEqual(checks.find((entry) => entry.name === 'codex:first-switch'), {
        name: 'codex:first-switch', level: 'WARN', message: 'lifecycle phase unavailable',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
