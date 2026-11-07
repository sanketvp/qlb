/**
 * AC41 writer scenarios (HP-H3-12). Each scenario drives a real production
 * writer or command with the synthetic AC41 failure body and returns only the
 * artifacts that writer actually persisted or printed. Callers assert on those
 * artifacts; nothing here calls a redactor.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { credentialWithFixtureAccess } from './support/claude-fixtures';

import { runExecutingCommand } from '../src/app';
import { runAuto } from '../src/auto';
import { pollAnthropic } from '../src/auto/anthropic';
import { claudePaths } from '../src/cc-paths';
import { ProbeVerdictMemo, type LiveIdentity } from '../src/cc-resync';
import { ClaudeSlots, InMemoryClaudeSlotRepository, SqliteClaudeSlotRepository } from '../src/cc-slots';
import { switchClaude, type ClaudeSwitchDeps } from '../src/cc-switch';
import { claudeSwitchJournalPath, createClaudeSwitchJournal, deleteClaudeSwitchJournal, updateClaudeSwitchJournal } from '../src/cc-switch-journal';
import { createReportCutoverCommand, type ReportCutoverCommandDeps } from '../src/commands/report-cutover';
import { runAutoCommand } from '../src/commands/auto';
import { createClaudeJournalResolveCommand } from '../src/commands/claude-journal-resolve';
import importCswapCommand from '../src/commands/import-cswap';
import lifecycleCommand from '../src/commands/lifecycle';
import { runUndoCswapCommand } from '../src/commands/undo-cswap';
import { beginCutover, transition } from '../src/lifecycle';
import { defaultConfig } from '../src/config';
import { doctorQlb } from '../src/diagnostics';
import { MockKeychain } from '../src/keychain';
import type { CommandContext } from '../src/registry';
import { recordRelogin } from '../src/relogin';
import { recordStash } from '../src/unclaimed-index';
import { QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
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
        await slots.createSlot({ accountId: id, credential: credentialWithFixtureAccess(id, `fixture-refresh-${id}`, now + 3_600_000), email: `${id}@example.test`, orgUuid: `org-${id}`, configJson: JSON.stringify({ oauthAccount: { accountUuid: id } }), source: 'cswap-import' });
      }
      await backend.set(paths.keychainService, 'fixture-user', credentialWithFixtureAccess('a', 'fixture-refresh-a', now + 3_600_000));
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
      // Capture the switch journal exactly as written, just before the rollback removes it.
      let journal: string | null = null;
      const journalPath = claudeSwitchJournalPath({ home, env });
      const result = await switchClaude({
        journalOps: {
          update: updateClaudeSwitchJournal,
          remove: (held, options) => { journal = readFileSync(journalPath, 'utf8'); return deleteClaudeSwitchJournal(held, options); },
        },
        store, slots, live: { backend: live, paths, account: 'fixture-user' },
        readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')),
        resolveProfile: async () => ({ uuid: 'a', email: 'a@example.test', organizationUuid: 'org-a' }),
        consume: { postRefresh: async () => ({ status: 500, body: '' }), withConsumeLock: async (fn) => fn(), withSwitchLock: async (fn) => fn() },
        env, home, now: () => now, by: 'qlb-cli', attempt: 'ac41-attempt', journalOwner: { pid: process.pid, lstart: '' },
      }, { to: 'b', trigger: 'manual' });
      const row = new DatabaseSync(dbPath).prepare("SELECT error, detail, steps_json FROM switch_log WHERE outcome = 'rolled-back'").get() as
        { error: string | null; detail: string | null; steps_json: string | null } | undefined;
      return { outcome: result.outcome, thrown: String(thrown), error: row?.error ?? null, detail: row?.detail ?? null, stepsJson: row?.steps_json ?? null, journal };
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
    await slots.createSlot({ accountId: 'active', credential: credentialWithFixtureAccess('active', 'fixture-refresh-active', (nowS + 3600) * 1000), email: 'active@example.test', orgUuid: 'active-org', slotNum: 1, source: 'fixture' });
    await slots.createSlot({ accountId: 'inactive', credential: credentialWithFixtureAccess('inactive', 'fixture-refresh-inactive', (nowS + 3600) * 1000), email: 'inactive@example.test', orgUuid: 'inactive-org', slotNum: 2, source: 'fixture' });
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

/** Doctor artifacts: the named row from `qlb doctor --json`, both outputs, and the newest `health_log.failing_json`. */
export type DoctorArtifacts = { level: string | null; message: string | null; text: string; json: string; history: string; historyHasRow: boolean };

/**
 * Seeds an isolated test-mode store at lifecycle `phase`, lets `seed` plant the
 * AC41 input, then runs the real `qlb doctor` CLI for text. Without `seams` the
 * --json report also comes from the CLI; with `seams` it comes from an in-process
 * doctorQlb call that injects them. Each run appends health history; the newest
 * failing_json row is returned. Test mode disables Keychain clients, so no
 * credential store is read.
 */
async function runDoctorRow(
  name: string,
  phase: string,
  seed: (dir: string, dbPath: string, cliEnv: NodeJS.ProcessEnv) => (() => void) | void | Promise<void>,
  seams?: Pick<NonNullable<Parameters<typeof doctorQlb>[1]>, 'keychain' | 'claudeVersionRunner'>,
): Promise<DoctorArtifacts> {
  const dir = root('doctor');
  try {
    mkdirSync(join(dir, 'plugins'));
    const dbPath = join(dir, 'qlb.db');
    const cliEnv: NodeJS.ProcessEnv = {
      QLB_TEST_MODE: '1', QLB_HOME: dir, HOME: dir, QLB_DB_PATH: dbPath,
      QLB_PLUGINS_DIR: join(dir, 'plugins'), QLB_CONFIG_PATH: join(dir, 'config.json'),
      QLB_ANTHROPIC_POOL_PATH: join(dir, 'missing-anthropic.json'), QLB_PI_AUTH_JSON_PATH: join(dir, 'missing-pi-auth.json'),
      QLB_CODEX_AUTH_JSON_PATH: join(dir, 'missing-codex-auth.json'), QLB_KIMI_CREDENTIALS_FILE: join(dir, 'missing-kimi.md'),
      QLB_CLAUDE_CODE_CREDENTIALS_PATH: join(dir, 'missing-claude-credentials'),
      QLB_CSWAP_SEQUENCE_PATH: join(dir, 'cswap', 'sequence.json'), QLB_CSWAP_USAGE_PATH: join(dir, 'missing-usage.json'),
    };
    openStore(dbPath).close();
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare('INSERT INTO lifecycle (state, began_at, cutover_at, window_end) VALUES (?, 1, 1, 2)').run(phase);
    } finally { db.close(); }
    const refresh = await seed(dir, dbPath, cliEnv);
    const doctor = (args: string[]): string => {
      refresh?.();
      const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(__dirname, '..', 'src', 'cli.js'), 'doctor', ...args], { encoding: 'utf8', env: cliEnv, timeout: 120_000 });
      if (result.status !== 0 && result.status !== 1) throw new Error(`qlb doctor exited ${String(result.status)}: ${result.stderr}`);
      return result.stdout;
    };
    const text = doctor([]);
    // Test mode disables Keychain clients and the Claude version process, so a
    // row that reads either receives the AC41 body only through doctorQlb's
    // injection seams. Its JSON report and health append then come from that
    // in-process call; the CLI text above is still the real command output.
    const json = seams === undefined
      ? doctor(['--json'])
      : JSON.stringify(await doctorQlb({ ...defaultConfig(dir), dbPath }, {
        ...seams, appendHealthLog: true, command: () => '', hostCommand: () => '', hostPlatform: 'linux',
        claudeUnclaimedStashDir: join(dir, '.qlb', 'unclaimed'), piProcessList: () => '',
      }));
    const row = (JSON.parse(json) as { checks: Array<{ name: string; level: string; message: string }> }).checks.find((check) => check.name === name);
    const history = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const failing = (history.prepare('SELECT failing_json FROM health_log ORDER BY id DESC LIMIT 1').get() as { failing_json: string } | undefined)?.failing_json ?? '';
      const historyHasRow = (JSON.parse(failing || '[]') as Array<{ name?: string }>).some((entry) => entry.name === name);
      return { level: row?.level ?? null, message: row?.message ?? null, text, json, history: failing, historyHasRow };
    } finally { history.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Row 4: an orphaned Claude switch journal whose `from` and `to` account fields carry the AC41 body. */
export function runDoctorSwitchJournal(): Promise<DoctorArtifacts> {
  return runDoctorRow('claude:switch-journal', 'cutover', (_dir, _dbPath, cliEnv) => {
    const paths = claudePaths({ env: cliEnv });
    const options = { env: cliEnv, configPath: paths.globalConfigPath, keychainService: paths.keychainService };
    createClaudeSwitchJournal({
      v: 1, provider: 'anthropic', attemptId: 'ac41-attempt', from: AC41_BODY, to: AC41_BODY, trigger: 'manual', by: 'qlb-cli', republish: false, injected: false, detail: null,
      decision: { leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null }, outgoingKind: null, bindingJson: null, step: 7,
      stagedBlobService: 'qlb:anthropic:staged-rollback:ac41', stagedAccount: 'qlb', stagedWritten: false,
      keychainService: options.keychainService, configPath: options.configPath, configText: null, configWrittenHash: null, fromOauthAccount: null,
      credentialsWrittenHash: null, credentialsWriteStarted: false, credentialsWritten: false, configWriteStarted: false, configWritten: false,
      closed: null, startedAt: 1, owner: { pid: 999_999, lstart: 'ac41-dead-owner' },
    }, options);
  });
}

/**
 * Row 5: a fresh C-swap import lock with import journals whose run ids are the
 * AC41 fixtures. A run id is a directory name, so each carries one fixture rather
 * than the whole 2 KB body; each journal file holds the body.
 */
export function runDoctorJournalInProgress(): Promise<DoctorArtifacts> {
  return runDoctorRow('journal:in-progress', 'cutover', (dir) => {
    const backups = join(dir, '.qlb', 'backups');
    for (const fixture of AC41_FIXTURES) {
      mkdirSync(join(backups, `cswap-import-${fixture}`), { recursive: true });
      writeFileSync(join(backups, `cswap-import-${fixture}`, 'journal.json'), AC41_BODY);
    }
    const lock = join(backups, 'cswap-import.lock');
    writeFileSync(lock, '');
    return () => utimesSync(lock, new Date(), new Date());
  });
}

/** Row 6: an unfinished undo whose lifecycle note carries the AC41 body. */
export function runDoctorUndoIncomplete(): Promise<DoctorArtifacts> {
  return runDoctorRow('undo:incomplete', 'undoing', (_dir, dbPath) => {
    const db = new DatabaseSync(dbPath);
    try { db.prepare('UPDATE lifecycle SET undo_began_at = 1234, note = ?').run(AC41_BODY); } finally { db.close(); }
  });
}

/** Row 7: a rolled-back undo whose Claude slot email carries the AC41 body. */
export function runDoctorUndoLineage(): Promise<DoctorArtifacts> {
  return runDoctorRow('undo:lineage-match', 'rolled-back', (_dir, dbPath) => {
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare('UPDATE lifecycle SET undo_began_at = 1234').run();
      db.prepare(`INSERT INTO claude_slots (account_id, slot_num, email, config_json, fingerprint, added_at, source)
        VALUES ('ac41-slot', 1, ?, '{}', 'sha256:ac41', 1, 'cswap-import')`).run(AC41_BODY);
    } finally { db.close(); }
  });
}

/** Row 8: the active Claude login names a dead slot whose email carries the AC41 body. */
export function runDoctorClaudeActive(): Promise<DoctorArtifacts> {
  return runDoctorRow('claude:active', 'cutover', (_dir, dbPath) => {
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`INSERT INTO claude_slots (account_id, slot_num, email, config_json, fingerprint, dead, added_at)
        VALUES ('ac41-slot', 1, ?, '{}', 'sha256:ac41', 1, 1)`).run(AC41_BODY);
      db.prepare("INSERT INTO active_login (provider, account_id, since, set_by) VALUES ('anthropic', 'ac41-slot', 1, 'manual')").run();
    } finally { db.close(); }
  });
}

/** Row 11: unpersisted-token evidence for a live Claude slot whose account id is the AC41 body. */
export function runDoctorUnpersistedToken(): Promise<DoctorArtifacts> {
  return runDoctorRow('claude:unpersisted-token', 'cutover', (_dir, dbPath) => {
    const store = openStore(dbPath);
    try {
      store.recordSwitch({ ts: 10, provider: 'anthropic', toAccount: AC41_BODY, trigger: 'automatic', outcome: 'refused', detail: 'freshen-consume-gate-unpersisted' });
    } finally { store.close(); }
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`INSERT INTO claude_slots (account_id, slot_num, email, config_json, fingerprint, added_at)
        VALUES (?, 1, 'ac41@example.test', '{}', 'sha256:ac41', 1)`).run(AC41_BODY);
    } finally { db.close(); }
  });
}

/** Row 3: the automatic-switching park marker holds the AC41 body. */
export function runDoctorAutoParked(): Promise<DoctorArtifacts> {
  return runDoctorRow('auto:parked', 'cutover', (_dir, dbPath) => {
    const store = openStore(dbPath);
    try { store.setConfig('auto.anthropic.parkedUntil', AC41_BODY); } finally { store.close(); }
  });
}

/** Row 9: a live Claude slot whose stored credential is the AC41 body (via the injected Keychain). */
export function runDoctorLoginExpiry(): Promise<DoctorArtifacts> {
  const keychain = new MockKeychain();
  keychain.setSync(qlbKeychainService('anthropic', 'ac41-slot'), QLB_KEYCHAIN_ACCOUNT, AC41_BODY);
  return runDoctorRow('claude:login-expiry', 'cutover', (_dir, dbPath) => {
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`INSERT INTO claude_slots (account_id, slot_num, email, config_json, fingerprint, added_at)
        VALUES ('ac41-slot', 1, 'ac41@example.test', '{}', 'sha256:ac41', 1)`).run();
    } finally { db.close(); }
  }, { keychain });
}

export const AC41_STASH_ID = '2025-01-01T00-00-00.000Z-ac41';

/** Row 10: a 30-day-old unclaimed Claude stash whose stored body file holds the AC41 body. */
export function runDoctorUnclaimed(): Promise<DoctorArtifacts> {
  return runDoctorRow('claude:unclaimed', 'cutover', async (dir) => {
    const stashRoot = join(dir, '.qlb', 'unclaimed');
    await recordStash(stashRoot, {
      provider: 'anthropic', accountId: 'ac41-slot', stashId: AC41_STASH_ID, consumedFp: 'sha256:ac41', location: 'file', createdAt: Date.UTC(2025, 0, 1),
    });
    mkdirSync(join(stashRoot, 'anthropic'), { recursive: true });
    writeFileSync(join(stashRoot, 'anthropic', `${AC41_STASH_ID}.json`), AC41_BODY);
  });
}

/** Row 12: an abandoned QLB atomic-write temp whose contents are the AC41 body. */
export function runDoctorStrayTemps(): Promise<DoctorArtifacts> {
  return runDoctorRow('fs:stray-temps', 'cutover', (dir) => {
    const path = join(dir, '.qlb-ac41.999999999.aaaaaaaaaaaaaaaa.tmp');
    writeFileSync(path, AC41_BODY);
    const old = new Date(Date.now() - 120_000);
    utimesSync(path, old, old);
  });
}

/** Row 13: a recorded Claude version sentinel and an installed-version probe that prints the AC41 body. */
export function runDoctorVersionDrift(): Promise<DoctorArtifacts> {
  return runDoctorRow('claude:version-drift', 'cutover', (_dir, dbPath) => {
    const store = openStore(dbPath);
    try { store.setConfig('sentinel.claudeCodeVersion', 'Claude Code 1.0.0'); } finally { store.close(); }
  }, { claudeVersionRunner: () => AC41_BODY });
}

/**
 * Row 15: the Claude switch journal written by the row-1 step-7 failure. Returns
 * every journal field except `configText`, which is verbatim rollback material
 * and deliberately outside the AC41 assertion.
 */
export async function runSwitchJournalFields(): Promise<ScenarioArtifacts> {
  const { journal } = await runSwitchStep7();
  if (journal === null) return { journal: null, detail: null, keys: null };
  const parsed = JSON.parse(journal) as Record<string, unknown>;
  delete parsed.configText;
  return { journal: JSON.stringify(parsed), detail: parsed.detail === null ? null : String(parsed.detail), keys: Object.keys(parsed).sort().join(',') };
}

type CommandRun = { code: number | null; stdout: string; stderr: string };

/** A test-mode command context rooted at `home`; every path stays inside it. */
function commandContext(home: string, dbPath: string, extra: Partial<CommandContext> = {}): { ctx: CommandContext; take: (code: number | null) => CommandRun } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const config = { ...defaultConfig(home), dbPath, cswapSequencePath: join(home, 'cswap', 'sequence.json') };
  const ctx: CommandContext = {
    stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
    env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, config, loadConfig: () => config, home,
    registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [], ...extra,
  };
  return { ctx, take: (code) => ({ code, stdout: stdout.splice(0).join('\n'), stderr: stderr.splice(0).join('\n') }) };
}

function cutoverStore(dbPath: string): ReturnType<typeof openStore> {
  const store = openStore(dbPath);
  beginCutover(store, 10);
  transition(store, 'cutover', 20);
  return store;
}

function flatten(runs: Record<string, CommandRun>): ScenarioArtifacts {
  return Object.fromEntries(Object.entries(runs).flatMap(([name, run]) => [
    [`${name}Code`, String(run.code)], [`${name}Stdout`, run.stdout], [`${name}Stderr`, run.stderr],
  ]));
}

/**
 * Row 18: `qlb auto resume anthropic` (text and --json) with the AC41 body as the
 * suspension marker, and `qlb auto drill-begin` whose agent bootout fails with the
 * body as its message (status 3, the not-loaded result the command accepts).
 */
export async function runAutoResumeDrillBegin(): Promise<ScenarioArtifacts> {
  const home = root('auto-cmd');
  try {
    const dbPath = join(home, 'qlb.db');
    cutoverStore(dbPath).close();
    const { ctx, take } = commandContext(home, dbPath);
    const mark = () => { const store = openStore(dbPath); try { store.setConfig('auto.anthropic.suspendedUntil', AC41_BODY); } finally { store.close(); } };
    const deps = {
      runAuto: async () => { throw new Error('not used'); },
      acquireFlock: async () => async () => {},
      exec: () => { throw Object.assign(new Error(AC41_BODY), { status: 3 }); },
      now: () => 30,
    };
    mark();
    const resumeText = take(await runAutoCommand(['resume', 'anthropic'], ctx, deps));
    mark();
    const resumeJson = take(await runAutoCommand(['resume', 'anthropic', '--json'], ctx, deps));
    const drillText = take(await runAutoCommand(['drill-begin'], ctx, deps));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const marker = (db.prepare("SELECT value FROM config WHERE key = 'auto.anthropic.suspendedUntil'").get() as { value: string }).value;
      const drillBeganAt = (db.prepare('SELECT drill_began_at AS value FROM lifecycle').get() as { value: number | null }).value;
      return { ...flatten({ resumeText, resumeJson, drillText }), storedMarker: marker, storedDrillBeganAt: String(drillBeganAt) };
    } finally { db.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Row 19: `qlb lifecycle drill-done` refused while a non-drill injected switch row carries the AC41 body. */
export async function runLifecycleDrillDone(): Promise<ScenarioArtifacts> {
  const home = root('drill-done');
  try {
    const dbPath = join(home, 'qlb.db');
    const store = cutoverStore(dbPath);
    try {
      store.recordSwitch({ ts: 25, provider: 'anthropic', toAccount: 'ac41', trigger: 'failover', outcome: 'refused', injected: true, detail: AC41_BODY, error: AC41_BODY });
    } finally { store.close(); }
    const { ctx, take } = commandContext(home, dbPath);
    const text = take(await runExecutingCommand({ command: lifecycleCommand, args: ['drill-done'] }, ctx));
    const json = take(await runExecutingCommand({ command: lifecycleCommand, args: ['drill-done', '--json'] }, ctx));
    return flatten({ text, json });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Row 20: `qlb undo cswap --dry-run --record-drill` (text and --json) with a Claude slot email holding the AC41 body. */
export async function runUndoRecordDrill(): Promise<ScenarioArtifacts> {
  const home = root('undo-drill');
  try {
    const dbPath = join(home, 'qlb.db');
    cutoverStore(dbPath).close();
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`INSERT INTO claude_slots (account_id, slot_num, email, config_json, fingerprint, added_at, source)
        VALUES ('ac41-slot', 1, ?, '{}', 'sha256:ac41', 1, 'cswap-import')`).run(AC41_BODY);
    } finally { db.close(); }
    const store = openStore(dbPath);
    try { store.setActiveLogin('anthropic', 'ac41-slot', 'fixture', 123); } finally { store.close(); }
    const { ctx, take } = commandContext(home, dbPath);
    const recordCtx = { ...ctx, env: { ...ctx.env, QLB_FAULT_INJECTION: '1' } };
    const keychain = new MockKeychain();
    await keychain.set(qlbKeychainService('anthropic', 'ac41-slot'), QLB_KEYCHAIN_ACCOUNT, credentialWithFixtureAccess('ac41-slot', 'fixture-refresh-ac41-slot', 3_600_000));
    const deps = {
      keychain, backupDir: join(home, 'cswap'), now: () => 123,
    };
    const command = { name: 'undo cswap', execute: (args: string[], commandCtx: CommandContext) => runUndoCswapCommand(args, commandCtx, deps) };
    const text = take(await runExecutingCommand({ command, args: ['--dry-run', '--record-drill'] }, recordCtx));
    const json = take(await runExecutingCommand({ command, args: ['--dry-run', '--record-drill', '--json'] }, recordCtx));
    const read = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const stored = (read.prepare("SELECT value FROM config WHERE key = 'drill.undoDryRunAt'").get() as { value: string } | undefined)?.value ?? null;
      return { ...flatten({ text, json }), storedDryRunAt: stored };
    } finally { read.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Row 21: `qlb claude journal resolve --back` on an orphaned journal with AC41 failure detail. */
export async function runJournalResolve(): Promise<ScenarioArtifacts> {
  const now = 1_000_000;
  const dir = root('resolve');
  try {
    const home = join(dir, 'home');
    const env = { QLB_TEST_MODE: '1', HOME: home, QLB_HOME: home };
    const paths = claudePaths({ home, env });
    mkdirSync(paths.configHome, { recursive: true });
    writeFileSync(paths.globalConfigPath, `${JSON.stringify({ oauthAccount: { accountUuid: 'a' } })}\n`);
    const backend = new MockKeychain();
    await backend.set(paths.keychainService, 'fixture-user', credentialWithFixtureAccess('a', 'fixture-refresh-a', now + 3_600_000));
    const dbPath = join(dir, 'qlb.sqlite');
    const store = cutoverStore(dbPath);
    const repository = SqliteClaudeSlotRepository.open(dbPath);
    try {
      const slots = new ClaudeSlots({ backend, repository, stashDir: join(dir, 'unclaimed'), now: () => now });
      for (const id of ['ac41-from-slot', 'ac41-to-slot']) {
        await slots.createSlot({ accountId: id, credential: credentialWithFixtureAccess(id, `fixture-refresh-${id}`, now + 3_600_000), email: `${id}@example.test`, orgUuid: `org-${id}`, configJson: JSON.stringify({ oauthAccount: { accountUuid: id } }), source: 'cswap-import' });
      }
      const options = { home, env, configPath: paths.globalConfigPath, keychainService: paths.keychainService };
      createClaudeSwitchJournal({
        v: 1, provider: 'anthropic', attemptId: 'ac41-attempt', from: 'ac41-from-slot', to: 'ac41-to-slot', trigger: 'manual', by: 'qlb-cli', republish: false, injected: false, detail: AC41_BODY,
        decision: { leftHeadroom: null, leftRecoveryAt: null, leftTrigger: null }, outgoingKind: null, bindingJson: null, step: 7,
        stagedBlobService: 'qlb:anthropic:staged-rollback:ac41', stagedAccount: 'qlb', stagedWritten: false,
        keychainService: paths.keychainService, configPath: paths.globalConfigPath, configText: null, configWrittenHash: null, fromOauthAccount: null,
        credentialsWrittenHash: null, credentialsWriteStarted: false, credentialsWritten: false, configWriteStarted: false, configWritten: false,
        closed: null, startedAt: now, owner: { pid: 999_999, lstart: 'ac41-dead-owner' },
      }, options);
      const deps: ClaudeSwitchDeps = {
        store, slots, live: { backend, paths, account: 'fixture-user' },
        readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')),
        resolveProfile: async () => null,
        consume: { postRefresh: async () => ({ status: 500, body: '' }), withConsumeLock: async (fn) => fn(), withSwitchLock: async (fn) => fn() },
        env, home, now: () => now, by: 'qlb-cli', attempt: 'ac41-resolve', journalOwner: { pid: process.pid, lstart: '' },
        stillTheSameProcess: async () => false, cswapProcesses: () => [],
      };
      const { ctx, take } = commandContext(home, dbPath);
      const command = createClaudeJournalResolveCommand({ makeSwitchDeps: async () => ({ deps }) });
      const back = take(await runExecutingCommand({ command, args: ['--back'] }, ctx));
      const rows = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return { ...flatten({ back }), switchRows: JSON.stringify(rows.prepare('SELECT from_account, to_account, detail, error, steps_json FROM switch_log').all()) };
      } finally { rows.close(); }
    } finally { repository.close(); store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Row 22: `qlb import cswap --reconcile` (text and --json) with an orphaned import journal whose file is the AC41 body. */
export async function runImportReconcile(): Promise<ScenarioArtifacts> {
  const home = root('import');
  try {
    const dbPath = join(home, 'qlb.db');
    cutoverStore(dbPath).close();
    const journal = join(home, '.qlb', 'backups', 'cswap-import-ac41-run');
    mkdirSync(journal, { recursive: true });
    writeFileSync(join(journal, 'journal.json'), AC41_BODY);
    const { ctx, take } = commandContext(home, dbPath);
    const text = take(await runExecutingCommand({ command: importCswapCommand, args: ['--reconcile'] }, ctx));
    const json = take(await runExecutingCommand({ command: importCswapCommand, args: ['--reconcile', '--json'] }, ctx));
    return flatten({ text, json });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Row 23: `qlb lifecycle sentinels record` (text and --json) whose Claude version probe prints the AC41 body. */
export async function runSentinelsRecord(): Promise<ScenarioArtifacts> {
  const home = root('sentinels');
  try {
    const dbPath = join(home, 'qlb.db');
    openStore(dbPath).close();
    const { ctx, take } = commandContext(home, dbPath, { claudeVersionRunner: () => AC41_BODY });
    const text = take(await runExecutingCommand({ command: lifecycleCommand, args: ['sentinels', 'record'] }, ctx));
    const json = take(await runExecutingCommand({ command: lifecycleCommand, args: ['sentinels', 'record', '--json'] }, ctx));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const stored = (db.prepare("SELECT value FROM config WHERE key = 'sentinel.claudeCodeVersion'").get() as { value: string } | undefined)?.value ?? null;
      return { ...flatten({ text, json }), storedVersion: stored };
    } finally { db.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}
