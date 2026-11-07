/**
 * AC41 writer scenarios (HP-H3-12). Each scenario drives a real production
 * writer or command with the synthetic AC41 failure body and returns only the
 * artifacts that writer actually persisted or printed. Callers assert on those
 * artifacts; nothing here calls a redactor.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { runExecutingCommand } from '../src/app';
import { runAuto } from '../src/auto';
import { pollAnthropic } from '../src/auto/anthropic';
import { claudePaths } from '../src/cc-paths';
import { ProbeVerdictMemo, type LiveIdentity } from '../src/cc-resync';
import { ClaudeSlots, InMemoryClaudeSlotRepository, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { switchClaude, type ClaudeSwitchDeps } from '../src/cc-switch';
import { createReportCutoverCommand, type ReportCutoverCommandDeps } from '../src/commands/report-cutover';
import { defaultConfig } from '../src/config';
import { MockKeychain } from '../src/keychain';
import type { CommandContext } from '../src/registry';
import { recordRelogin } from '../src/relogin';
import { openStore } from '../src/store';

/** The three synthetic AC41 fixtures. They are fake and never read from the environment. */
export const AC41_FIXTURES = [
  'sk-ant-oat01-' + 'a'.repeat(64),
  'sk-ant-ort01-' + 'b'.repeat(64),
  ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJkcmlsbCJ9', 'c2lnbmF0dXJl'].join('.'),
] as const;

/** Deterministic failure body: 1,000 bytes of padding, the fixtures, 1,000 bytes of padding. */
export const AC41_BODY = `${'ac41-failure-pad '.repeat(59)}${AC41_FIXTURES.join(' ')} ${'ac41-failure-end '.repeat(59)}`;

/** Fixtures present in an artifact. An empty array is a clean artifact. */
export function leakedFixtures(artifact: string | null | undefined): string[] {
  return AC41_FIXTURES.filter((fixture) => (artifact ?? '').includes(fixture));
}

export type ScenarioArtifacts = Record<string, string | null>;

function root(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `qlb-ac41-${prefix}-`));
}

const credential = (tag: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: `fixture-access-${tag}`, refreshToken: `fixture-refresh-${tag}`, expiresAt } });

/** Row 1: a Claude switch whose step-7 live credential write throws the AC41 body. */
export async function runSwitchStep7(): Promise<ScenarioArtifacts> {
  const now = 1_000_000;
  const dir = root('switch');
  try {
    const home = join(dir, 'home');
    const env = { QLB_TEST_MODE: '1', HOME: home, QLB_HOME: join(dir, 'qlb') };
    const paths = claudePaths({ home, env });
    mkdirSync(paths.configHome, { recursive: true });
    writeFileSync(paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: 'a' } })}\n`);
    const backend = new MockKeychain();
    const dbPath = join(dir, 'qlb.sqlite');
    const store = openStore(dbPath);
    const repository = SqliteClaudeSlotRepository.open(dbPath);
    try {
      const slots = new ClaudeSlots({ backend, repository, stashDir: join(dir, 'unclaimed'), now: () => now });
      for (const id of ['a', 'b']) {
        await slots.createSlot({ accountId: id, credential: credential(id, now + 3_600_000), email: `${id}@example.test`, orgUuid: `org-${id}`, configJson: JSON.stringify({ oauthAccount: { accountUuid: id } }), source: 'cswap-import' });
      }
      await backend.set(paths.keychainService, 'fixture-user', credential('a', now + 3_600_000));
      store.setActiveLogin('anthropic', 'a', 'manual', now);
      let thrown = false;
      const live: ClaudeSwitchDeps['live']['backend'] = {
        kind: 'test-memory',
        get: (service, account) => backend.get(service, account),
        set: async (service, account, value) => {
          if (service === paths.keychainService && !thrown) { thrown = true; throw new Error(AC41_BODY); }
          return backend.set(service, account, value);
        },
        delete: (service, account) => backend.delete(service, account),
        setSync: (service, account, value) => backend.setSync(service, account, value),
        getSync: (service, account) => backend.getSync(service, account),
        deleteSync: (service, account) => backend.deleteSync(service, account),
      };
      const result = await switchClaude({
        store, slots, live: { backend: live, paths, account: 'fixture-user' },
        readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')),
        resolveProfile: async () => ({ uuid: 'a', email: 'a@example.test', organizationUuid: 'org-a' }),
        consume: { postRefresh: async () => ({ status: 500, body: '' }), withConsumeLock: async (fn) => fn(), withSwitchLock: async (fn) => fn() },
        env, home, now: () => now, by: 'qlb-cli', attempt: 'ac41-attempt', journalOwner: { pid: process.pid, lstart: '' },
      }, { to: 'b', trigger: 'manual' });
      const row = new DatabaseSync(dbPath).prepare("SELECT error, detail, steps_json FROM switch_log WHERE outcome = 'rolled-back'").get() as
        { error: string | null; detail: string | null; steps_json: string | null } | undefined;
      return { outcome: result.outcome, thrown: String(thrown), error: row?.error ?? null, detail: row?.detail ?? null, stepsJson: row?.steps_json ?? null };
    } finally { repository.close(); store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Row 2: an inactive-slot Anthropic usage poll answered with HTTP 403 and the AC41 body. */
export async function runPoll4xx(): Promise<ScenarioArtifacts> {
  const nowS = 1_700_000_000;
  const home = root('poll');
  const store = openStore(':memory:');
  try {
    const env = { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home };
    const backend = new MockKeychain();
    const slots = new ClaudeSlots({ backend, repository: new InMemoryClaudeSlotRepository(), stashDir: join(home, 'unclaimed'), now: () => nowS * 1000 });
    await slots.createSlot({ accountId: 'active', credential: credential('active', (nowS + 3600) * 1000), email: 'active@example.test', orgUuid: 'active-org', slotNum: 1, source: 'fixture' });
    await slots.createSlot({ accountId: 'inactive', credential: credential('inactive', (nowS + 3600) * 1000), email: 'inactive@example.test', orgUuid: 'inactive-org', slotNum: 2, source: 'fixture' });
    store.setActiveLogin('anthropic', 'active', 'fixture', nowS);
    store.writeUsagePollPlans('anthropic', { active: { nextDueAt: nowS + 300, pollIntervalS: 300 } });
    const paths = claudePaths({ home, env });
    let bodyServed = false;
    await pollAnthropic({
      store, slots, now: () => nowS, rng: () => 0.5,
      fetchActiveDeps: {
        live: { backend, paths, account: 'fixture', home, env }, env, now: () => nowS * 1000,
        verdicts: new ProbeVerdictMemo(), by: 'qlb-auto' as const, postRefresh: async () => ({ status: 500, body: '' }),
      },
      resyncDeps: {
        live: { backend, paths, account: 'fixture', home, env }, env, now: () => nowS * 1000,
        getProfile: async () => ({ status: 500, body: '' }), readLiveIdentity: (): LiveIdentity | null => null, by: 'qlb-auto' as const,
      },
      consumeDeps: { postRefresh: async () => ({ status: 500, body: '' }) },
      getUsage: async () => { bodyServed = true; return { status: 403, body: AC41_BODY }; },
    });
    return { bodyServed: String(bodyServed), lastStatus: store.listUsagePolls('anthropic').inactive?.lastStatus ?? null };
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
}

/** Row 14: one `qlb auto --once` loop whose tick throws the AC41 body. */
export async function runAutoThrownTick(): Promise<ScenarioArtifacts> {
  const lines: string[] = [];
  const binding = {
    store: { setConfig: () => {} },
    close: () => {},
    reconcile: async () => {},
    poll: async () => [] as [],
    tick: async (): Promise<never> => { throw new Error(AC41_BODY); },
  };
  await runAuto({ once: true }, {
    makeLiveBinding: () => binding as never,
    assertAdmitted: () => ({ ok: true }),
    listCswapProcesses: () => [],
    now: () => 100,
    log: (line) => lines.push(line),
  });
  return { log: lines.join('\n') };
}

/** Row 16: `qlb report cutover` text and `--json` with the AC41 body recorded as a dead slot. */
export async function runReportCutover(): Promise<ScenarioArtifacts> {
  const day = 24 * 60 * 60 * 1000;
  const now = 20 * day;
  const dir = root('report');
  try {
    const dbPath = join(dir, 'qlb.db');
    openStore(dbPath).close();
    const db = new DatabaseSync(dbPath);
    try {
      const cutoverAt = now - 15 * day;
      db.prepare(`INSERT INTO lifecycle (state, began_at, cutover_at, window_end, drill_began_at) VALUES ('cutover', ?, ?, ?, ?)`)
        .run(cutoverAt, cutoverAt, cutoverAt + 7 * day, cutoverAt);
      db.prepare(`INSERT INTO health_log (ts, phase, overall, failing_json, dead_slots_json) VALUES (?, 'cutover', 'PASS', '[]', ?)`)
        .run(cutoverAt + 1, JSON.stringify([AC41_BODY]));
      db.prepare(`INSERT INTO config (key, value) VALUES ('cutover.piDeferredAt', ?)`).run(String(cutoverAt));
    } finally { db.close(); }
    const config = { ...defaultConfig(dir), dbPath };
    const output: string[] = [];
    const context: CommandContext = {
      stdout: (line) => output.push(line), stderr: (line) => output.push(line),
      env: { QLB_TEST_MODE: '1', QLB_HOME: dir, HOME: dir }, config, loadConfig: () => config, home: dir,
      registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
    };
    const doctor: ReportCutoverCommandDeps['doctor'] = async () => {
      const health = new DatabaseSync(dbPath);
      try {
        const result = health.prepare(`INSERT INTO health_log (ts, phase, overall, failing_json, dead_slots_json) VALUES (?, 'cutover', 'PASS', '[]', '[]')`).run(now);
        return { command: 'doctor', overall: 'PASS', checks: [], providers: [], s64: { overall: 'PASS', autoAgent: 'PASS' }, healthLogId: Number(result.lastInsertRowid) };
      } finally { health.close(); }
    };
    const run = (args: string[]) => runExecutingCommand({ command: createReportCutoverCommand({ now: () => now, doctor }), args }, context);
    await run(['--json']);
    const json = output.splice(0).join('\n');
    await run([]);
    return { json, text: output.join('\n') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function runStatusCli(args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(__dirname, '..', 'src', 'cli.js'), ...args], { encoding: 'utf8', env, timeout: 60_000 });
  if (result.status !== 0) throw new Error(`qlb ${args.join(' ')} exited ${String(result.status)}: ${result.stderr}`);
  return result.stdout;
}

/** Row 17: real store writers receive the AC41 body; `qlb status` history and AC33 JSON read it back. */
export async function runStatusHistory(): Promise<ScenarioArtifacts> {
  const dir = root('status');
  try {
    mkdirSync(join(dir, 'plugins'));
    const dbPath = join(dir, 'qlb.db');
    const env = {
      QLB_TEST_MODE: '1', QLB_HOME: dir, HOME: dir, QLB_DB_PATH: dbPath,
      QLB_PLUGINS_DIR: join(dir, 'plugins'), QLB_CONFIG_PATH: join(dir, 'config.json'),
      QLB_ANTHROPIC_POOL_PATH: join(dir, 'missing-anthropic.json'), QLB_PI_AUTH_JSON_PATH: join(dir, 'missing-pi-auth.json'),
      QLB_CODEX_AUTH_JSON_PATH: join(dir, 'missing-codex-auth.json'), QLB_KIMI_CREDENTIALS_FILE: join(dir, 'missing-kimi.md'),
      QLB_CLAUDE_CODE_CREDENTIALS_PATH: join(dir, 'missing-claude-credentials'),
      QLB_CSWAP_SEQUENCE_PATH: join(dir, 'missing-sequence.json'), QLB_CSWAP_USAGE_PATH: join(dir, 'missing-usage.json'),
    };
    const nowMs = Date.now();
    const nowS = Math.floor(nowMs / 1000);
    const store = openStore(dbPath);
    try {
      store.recordSwitch({ ts: nowMs, provider: 'anthropic', fromAccount: 'claude-a', toAccount: 'claude-b', trigger: 'manual', outcome: 'failed', error: AC41_BODY, detail: AC41_BODY, stepsJson: JSON.stringify({ failure: AC41_BODY }) });
      recordRelogin(store, { ts: nowMs, provider: 'anthropic', accountId: 'claude-a', kind: 'external-login', detail: AC41_BODY });
      store.recordUsagePollResult('anthropic', 'claude-a', { attemptedAt: nowS, status: AC41_BODY });
    } finally { store.close(); }
    const db = new DatabaseSync(dbPath);
    let stored: { error: string | null; detail: string | null; steps_json: string | null };
    let reloginDetail: string | null;
    let usageStatus: string | null;
    try {
      db.prepare(`INSERT INTO claude_slots (account_id, slot_num, email, config_json, fingerprint, threshold, dead, added_at, archived_at)
        VALUES ('claude-a', 1, 'claude-a@example.test', '{}', 'sha256:claude-a', NULL, 0, ?, NULL)`).run(nowMs);
      db.prepare("INSERT INTO lifecycle (state, began_at, cutover_at, window_end) VALUES ('cutover', ?, ?, ?)").run(nowMs, nowMs, nowMs + 7 * 86_400_000);
      stored = db.prepare('SELECT error, detail, steps_json FROM switch_log').get() as typeof stored;
      reloginDetail = (db.prepare('SELECT detail FROM relogin_events').get() as { detail: string | null }).detail;
      usageStatus = (db.prepare('SELECT last_status FROM usage_polls').get() as { last_status: string | null }).last_status;
    } finally { db.close(); }
    return {
      storedSwitchError: stored.error, storedSwitchDetail: stored.detail, storedSwitchSteps: stored.steps_json,
      storedReloginDetail: reloginDetail, storedUsageStatus: usageStatus,
      switchesJson: runStatusCli(['status', '--switches', '--json'], env),
      reloginsJson: runStatusCli(['status', '--relogins', '--json'], env),
      statusJson: runStatusCli(['status', '--json'], env),
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
