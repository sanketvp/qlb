import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { addCodexAccount, productionCodexAddDeps } from '../src/codex-add';
import { codexFingerprint, parseCodexAuth, type CodexAuthDocument } from '../src/codex-auth';
import { consumeCodexSlot } from '../src/codex-consume';
import { CodexSlots, importActiveCodexSlot } from '../src/codex-slots';
import { readCodexLatch } from '../src/codex-stop';
import { runCodexAddCommand } from '../src/commands/codex-add';
import { runCodexImportActiveCommand } from '../src/commands/codex-import-active';
import { MockKeychain } from '../src/keychain';
import { PHASE_RULES } from '../src/lifecycle';
import { discoverCommands, resolveCommand, type CommandContext } from '../src/registry';
import { openStore } from '../src/store';

/**
 * U15: the back-to-dark runbook names only commands that exist, and the ones it
 * runs while a stop is latched are admitted and succeed against a latched test
 * home. Every qlb run here uses QLB_TEST_MODE=1 and a temporary home.
 */

const RUNBOOK = join(__dirname, '..', '..', 'docs', 'CODEX-GO-LIVE-RUNBOOK.md');
const CLI = join(__dirname, '..', 'src', 'cli.js');
const NOW = Date.now();
const PROVIDER = 'openai-codex';

function jwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture`;
}

function login(user: string, refresh: string, expiresAt = NOW + 3_600_000): CodexAuthDocument {
  const parsed = parseCodexAuth(JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: user, chatgpt_account_id: 'fixture-account' } }),
      access_token: jwt({ exp: Math.floor(expiresAt / 1_000), sub: `${refresh}-access` }),
      refresh_token: refresh,
      account_id: 'fixture-account',
    },
    last_refresh: new Date(NOW - 86_400_000).toISOString(),
  }));
  if (!parsed.ok) throw new Error('fixture document must parse');
  return parsed.doc;
}

/** The `qlb ...` lines inside the runbook's bash blocks. */
function runbookCommands(text: string): string[] {
  const commands: string[] = [];
  for (const block of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of block[1]!.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('qlb ')) commands.push(trimmed);
    }
  }
  return commands;
}

/** The runbook section under `heading`, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `runbook has no "## ${heading}" section`);
  const end = text.indexOf('\n## ', start + 1);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

interface Home {
  root: string;
  dbPath: string;
  env: NodeJS.ProcessEnv;
  stopId: number;
}

/** A test home in `phase` with a Stage 1 start and one recorded stop (a wiped login), and a native login in CODEX_HOME. */
function latchedHome(phase: 'cutover' | 'retired'): Home {
  const root = mkdtempSync(join(tmpdir(), 'qlb-codex-runbook-'));
  const dbPath = join(root, 'qlb.db');
  mkdirSync(join(root, 'plugins'));
  mkdirSync(join(root, 'codex'));
  writeFileSync(join(root, 'codex', 'auth.json'), JSON.stringify(login('native', 'runbook-native')), { mode: 0o600 });
  const store = openStore(dbPath);
  let stopId: number;
  try {
    (store as unknown as { db: DatabaseSync }).db
      .prepare('INSERT INTO lifecycle (state, began_at, cutover_at, window_end) VALUES (?, ?, ?, ?)').run(phase, NOW - 10_000_000, NOW - 9_000_000, NOW + 9_000_000);
    store.appendCodexStageEvent({ kind: 'stage-start', now: NOW - 5_000, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true, stage: 1, detail: { allow: [] } });
    store.recordRelogin({ ts: NOW - 4_000, provider: PROVIDER, accountId: 'fixture-user:fixture-account', kind: 'wiped' });
    const reloginId = ((store as unknown as { db: DatabaseSync }).db.prepare('SELECT MAX(id) AS id FROM relogin_events').get() as { id: number }).id;
    const id = store.appendCodexStageEvent({ kind: 'latch-set', now: NOW - 3_000, lifecycleId: 1, buildStamp: 'build-abc', flagEnabled: true,
      evidence: `relogin_events:${reloginId}`, detail: { rule: 'forced-relogin' } });
    assert.ok(id !== null);
    stopId = id;
    assert.equal(readCodexLatch(store).state, 'set');
  } finally {
    store.close();
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    QLB_TEST_MODE: '1', QLB_HOME: root, HOME: root, QLB_DB_PATH: dbPath, CODEX_HOME: join(root, 'codex'),
    QLB_PLUGINS_DIR: join(root, 'plugins'), QLB_CONFIG_PATH: join(root, 'config.json'),
    QLB_ANTHROPIC_POOL_PATH: join(root, 'missing-anthropic.json'), QLB_PI_AUTH_JSON_PATH: join(root, 'missing-pi-auth.json'),
    QLB_CODEX_AUTH_JSON_PATH: join(root, 'codex', 'auth.json'), QLB_KIMI_CREDENTIALS_FILE: join(root, 'missing-kimi.md'),
    QLB_CLAUDE_CODE_CREDENTIALS_PATH: join(root, 'missing-claude-credentials'),
    QLB_CSWAP_SEQUENCE_PATH: join(root, 'cswap', 'sequence.json'), QLB_CSWAP_USAGE_PATH: join(root, 'missing-usage.json'),
  };
  return { root, dbPath, env, stopId };
}

function qlb(home: Home, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { encoding: 'utf8', env: home.env, timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function count(home: Home, sql: string): number {
  const db = new DatabaseSync(home.dbPath, { readOnly: true });
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

const stageEvents = (home: Home, kind: string): number => count(home, `SELECT COUNT(*) AS n FROM codex_stage_events WHERE kind = '${kind}'`);

function latchState(home: Home): string {
  const store = openStore(home.dbPath);
  try {
    return readCodexLatch(store).state;
  } finally {
    store.close();
  }
}

function addContext(home: Home, output: string[]): CommandContext {
  return {
    stdout: (line) => output.push(line), stderr: (line) => output.push(`stderr:${line}`),
    env: home.env, config: { dbPath: home.dbPath, codexAuthJsonPath: join(home.root, 'codex', 'auth.json') } as CommandContext['config'],
    loadConfig: () => { throw new Error('not used'); }, home: home.root,
    registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
  };
}

/** `qlb codex add`, with the isolated native `codex login` replaced by one that writes `added`. */
async function codexAdd(home: Home, added: CodexAuthDocument, args: string[] = [], keychain = new MockKeychain()): Promise<{ code: number; output: string[] }> {
  const output: string[] = [];
  const code = await runCodexAddCommand(args, addContext(home, output), {
    openStore,
    add: addCodexAccount,
    productionDeps: (store, _platformKeychain, env) => {
      const deps = productionCodexAddDeps(store, keychain, env);
      deps.login = async (options) => {
        writeFileSync(join(options.cwd, 'auth.json'), JSON.stringify(added), { mode: 0o600 });
        return 0;
      };
      return deps;
    },
  });
  return { code, output };
}

describe('Codex go-live runbook (U15)', () => {
  const text = readFileSync(RUNBOOK, 'utf8');

  it('every qlb command the runbook names is a registered command', () => {
    const commands = runbookCommands(text);
    assert.ok(commands.length >= 8, `found only ${commands.length} qlb commands`);
    const registry = discoverCommands();
    for (const line of commands) {
      const words = line.split(/\s+/).slice(1);
      // `doctor` is parsed by the older argument parser in app.ts, not the registry.
      assert.ok(resolveCommand(words, registry) !== null || words[0] === 'doctor', `not a qlb command: ${line}`);
    }
    for (const name of ['codex import-active', 'codex latch clear', 'codex latch clear --through', 'codex latch clear --initialize',
      'codex stage report', 'codex stage start', 'codex stage close', 'codex add']) {
      assert.ok(commands.some((line) => line.startsWith(`qlb ${name}`)), `runbook does not name qlb ${name}`);
    }
  });

  it('never installs an older release, and the back-to-dark steps use no command the latch refuses', () => {
    assert.doesNotMatch(text, /--sha\b/);
    for (const heading of ['Back to dark after a stop', 'Back to dark in the retired phase']) {
      const steps = runbookCommands(section(text, heading)).join('\n');
      assert.doesNotMatch(steps, /^qlb (switch|codex refresh|codex stage start)\b/m, heading);
    }
  });

  it('states the R16 rule: a Stage 2 stop whose fix touches switch, watch or refresh code restarts at Stage 1', () => {
    const restart = section(text, 'Restarting after the fix');
    assert.match(restart, /When the fix touches switch, watch or refresh code, the restart is at Stage 1/);
    assert.match(restart, /restarts at Stage 2 only if the fix left the Codex switch, watch or refresh code alone/);
  });

  it('names the doctor-gate stop with the rule, evidence and refusal the switch writes', () => {
    const stops = section(text, 'How a stop reaches you');
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'codex-switch.ts'), 'utf8');
    assert.match(source, /rule: 'doctor-not-allowed'/);
    assert.match(source, /'codex-doctor-gate-unavailable'/);
    assert.match(stops, /`doctor-not-allowed`/);
    assert.match(stops, /`doctor:<check>:<code>@<stage-start id>`/);
    assert.match(stops, /`codex-doctor-gate-unavailable`/);
    assert.match(stops, /`codex:slots` and `codex:first-switch`/);
  });

  it('cutover: the back-to-dark commands succeed while latched, and only the owner\'s clear lifts the latch', () => {
    const home = latchedHome('cutover');
    try {
      const imported = qlb(home, ['codex', 'import-active']);
      assert.equal(imported.status, 0, imported.stderr);
      assert.equal(latchState(home), 'set');

      const probe = qlb(home, ['codex', 'latch', 'clear']);
      assert.equal(probe.status, 0, probe.stderr);
      assert.match(probe.stdout, new RegExp(`codex latch: latched, newest stop ${home.stopId}`));
      assert.equal(stageEvents(home, 'latch-clear'), 0);

      const report = qlb(home, ['codex', 'stage', 'report']);
      assert.equal(report.status, 0, report.stderr);
      assert.match(report.stdout, /Latch: latched/);

      const close = qlb(home, ['codex', 'stage', 'close']);
      assert.equal(close.status, 0, close.stderr);
      assert.equal(stageEvents(home, 'stage-close'), 1);

      const cleared = qlb(home, ['codex', 'latch', 'clear', '--through', String(home.stopId), '--reason', 'reviewed the wiped login']);
      assert.equal(cleared.status, 0, cleared.stderr);
      assert.equal(stageEvents(home, 'latch-clear'), 1);
      assert.equal(latchState(home), 'clear');

      // A dark build cannot start a stage: the restart needs the flag flip merged again.
      const start = qlb(home, ['codex', 'stage', 'start', '--stage', '1']);
      assert.equal(start.status, 3);
      assert.match(start.stderr + start.stdout, /flag-off/);
    } finally {
      rmSync(home.root, { recursive: true, force: true });
    }
  });

  it('retired: the owner\'s import is refused, and every command the retired path names is admitted and succeeds while latched', async () => {
    const home = latchedHome('retired');
    try {
      const imported = qlb(home, ['codex', 'import-active']);
      assert.notEqual(imported.status, 0);
      assert.match(imported.stderr, /phase=retired/);

      const keychain = new MockKeychain();
      const added = await codexAdd(home, login('native', 'runbook-retired-add'), [], keychain);
      assert.equal(added.code, 0, added.output.join('\n'));
      assert.deepEqual(added.output, ['added native:fixture-account']);
      assert.equal(latchState(home), 'set');
      // A replace records an identity-replaced relogin, which the probe's sweep records as a newer stop.
      const replaced = await codexAdd(home, login('native', 'runbook-retired-replace'), ['--replace', 'native:fixture-account'], keychain);
      assert.equal(replaced.code, 0, replaced.output.join('\n'));
      assert.match(replaced.output[0]!, /^replaced native:fixture-account/);

      const probe = qlb(home, ['codex', 'latch', 'clear']);
      assert.equal(probe.status, 0, probe.stderr);
      const newest = Number(/newest stop (\d+)/.exec(probe.stdout)?.[1]);
      assert.ok(newest > home.stopId, probe.stdout);
      const older = qlb(home, ['codex', 'latch', 'clear', '--through', String(home.stopId), '--reason', 'reviewed the wiped login']);
      assert.equal(older.status, 3);
      assert.match(older.stderr, new RegExp(`newer-stop: ${newest}`));
      const report = qlb(home, ['codex', 'stage', 'report']);
      assert.equal(report.status, 0, report.stderr);
      const doctor = qlb(home, ['doctor']);
      assert.ok(doctor.status === 0 || doctor.status === 1, doctor.stderr);
      assert.match(doctor.stdout, /codex:stop-latch/);

      const cleared = qlb(home, ['codex', 'latch', 'clear', '--through', String(newest), '--reason', 'reviewed the wiped login and the replace']);
      assert.equal(cleared.status, 0, cleared.stderr);
      assert.equal(latchState(home), 'clear');

      // The stages cannot restart in retired: the markers are admitted only in cutover.
      // (A dark build's start stops at flag-off before its phase check, so close shows the refusal.)
      const close = qlb(home, ['codex', 'stage', 'close']);
      assert.equal(close.status, 3);
      assert.match(close.stderr + close.stdout, /phase=retired/);
      for (const operation of ['codex-stage-start', 'codex-stage-close'] as const) {
        assert.equal(PHASE_RULES.retired.has(operation), false, operation);
        assert.equal(PHASE_RULES.cutover.has(operation), true, operation);
      }
      assert.equal(PHASE_RULES['cutting-over'].has('codex-import-active'), true);
      assert.equal(PHASE_RULES['cutting-over'].has('codex-latch-clear'), true);
    } finally {
      rmSync(home.root, { recursive: true, force: true });
    }
  });

  it('cutover: importing the live login over an existing slot succeeds while latched', async () => {
    const home = latchedHome('cutover');
    try {
      const keychain = new MockKeychain();
      const live = login('native', 'runbook-existing');
      const seed = openStore(home.dbPath);
      try {
        importActiveCodexSlot(live, { store: seed, keychain, now: () => NOW - 100 });
      } finally {
        seed.close();
      }
      const output: string[] = [];
      const code = await runCodexImportActiveCommand([], addContext(home, output), {
        keychain,
        readAuth: async () => ({ status: 'ok', doc: live }),
        writeAuth: async () => 1,
        withAuthLock: async (_options, fn) => fn({ assertNotCompromised: () => undefined }),
      });
      assert.equal(code, 0, output.join('\n'));
      assert.equal(latchState(home), 'set');
    } finally {
      rmSync(home.root, { recursive: true, force: true });
    }
  });

  it('one time: --initialize clears initialize-required on a home with Codex switch history, then reports not-required', () => {
    const home = latchedHome('cutover');
    try {
      const seed = openStore(home.dbPath);
      try {
        seed.recordSwitch({ ts: NOW - 50_000, provider: PROVIDER, fromAccount: 'a:account', toAccount: 'b:account', trigger: 'manual', outcome: 'ok', publishedAt: NOW - 50_000 });
        // As before this feature: the stage tables do not exist yet.
        (seed as unknown as { db: DatabaseSync }).db.exec('DROP TABLE codex_stage_events; DROP TABLE codex_watch_verdicts;');
      } finally {
        seed.close();
      }
      assert.equal(latchState(home), 'unreadable');
      const init = qlb(home, ['codex', 'latch', 'clear', '--initialize', '--reason', 'first install of the stop latch']);
      assert.equal(init.status, 0, init.stderr);
      assert.match(init.stdout, /^codex stage log initialized \(event \d+\)$/m);
      assert.equal(latchState(home), 'clear');
      const again = qlb(home, ['codex', 'latch', 'clear', '--initialize', '--reason', 'again']);
      assert.equal(again.status, 3);
      assert.match(again.stderr, /not-required/);
    } finally {
      rmSync(home.root, { recursive: true, force: true });
    }
  });

  it('cutover: qlb codex add succeeds while latched', async () => {
    const home = latchedHome('cutover');
    try {
      const added = await codexAdd(home, login('second', 'runbook-cutover-add'));
      assert.equal(added.code, 0, added.output.join('\n'));
      assert.match(added.output[0]!, /^added second:fixture-account/);
      assert.equal(latchState(home), 'set');
    } finally {
      rmSync(home.root, { recursive: true, force: true });
    }
  });

  it('a successor adoption completes while latched, with no refresh request', async () => {
    const home = latchedHome('cutover');
    const store = openStore(home.dbPath);
    try {
      const keychain = new MockKeychain();
      const initial = login('native', 'runbook-adopt-a', NOW + 60_000);
      const plan = importActiveCodexSlot(initial, { store, keychain, now: () => NOW - 1 });
      const slots = new CodexSlots({ keychain, stashDir: join(home.root, 'unclaimed'), now: () => NOW });
      const successor = login('native', 'runbook-adopt-successor');
      await slots.stashUnclaimedDurably('runbook-stash', successor, codexFingerprint(initial), plan.slotId);
      let posts = 0;
      const result = await consumeCodexSlot({
        accountId: plan.slotId, snapshot: initial, trigger: 'scheduled', force: false, slots, store, holders: async () => [], now: () => NOW,
        transport: async () => { posts += 1; throw new Error('a latched consume must not send a refresh request'); },
      });
      assert.equal(result.status, 'fresh');
      assert.equal(posts, 0);
      assert.deepEqual(slots.readSlot(plan.slotId, { fresh: true }).document, successor);
      assert.equal(readCodexLatch(store).state, 'set');
    } finally {
      store.close();
      rmSync(home.root, { recursive: true, force: true });
    }
  });

  it('while latched, the report leaves the database byte-identical, and doctor adds only its health_log row', () => {
    const home = latchedHome('cutover');
    try {
      const before = readFileSync(home.dbPath);
      const report = qlb(home, ['codex', 'stage', 'report', '--json']);
      assert.equal(report.status, 0, report.stderr);
      assert.ok(readFileSync(home.dbPath).equals(before), 'the report changed the database');
      assert.equal(existsSync(`${home.dbPath}-wal`) && readFileSync(`${home.dbPath}-wal`).length > 0, false, 'the report left a WAL');

      const tables = ['codex_stage_events', 'codex_watch_verdicts', 'switch_log', 'relogin_events', 'health_log'];
      const counts = () => Object.fromEntries(tables.map((table) => [table, count(home, `SELECT COUNT(*) AS n FROM ${table}`)]));
      const ahead = counts();
      const doctor = qlb(home, ['doctor']);
      assert.ok(doctor.status === 0 || doctor.status === 1, doctor.stderr);
      assert.deepEqual(counts(), { ...ahead, health_log: ahead.health_log! + 1 });
    } finally {
      rmSync(home.root, { recursive: true, force: true });
    }
  });
});
