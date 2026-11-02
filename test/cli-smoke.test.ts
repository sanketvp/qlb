import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { openStore } from '../src/store';

const cliPath = join(__dirname, '..', 'src', 'cli.js');

function isolatedEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'qlb-smoke-'));
  mkdirSync(join(root, 'migrate'), { recursive: true });
  return {
    ...process.env,
    QLB_TEST_MODE: '1',
    QLB_HOME: root,
    HOME: root,
    QLB_PLUGINS_DIR: join(root, 'plugins'),
    QLB_DB_PATH: join(root, 'qlb.db'),
    QLB_ANTHROPIC_POOL_PATH: join(root, 'missing-anthropic.json'),
    QLB_PI_AUTH_JSON_PATH: join(root, 'missing-pi-auth.json'),
    QLB_CODEX_AUTH_JSON_PATH: join(root, 'missing-codex-auth.json'),
    QLB_KIMI_CREDENTIALS_FILE: join(root, 'missing-kimi.md'),
    QLB_OPENROUTER_KEYCHAIN_SERVICE: 'qlb-test-missing-openrouter',
    QLB_CONFIG_PATH: join(root, 'config.json'),
    QLB_PROXY_INFO_PATH: join(root, 'proxy.json'),
    QLB_CLAUDE_CODE_CREDENTIALS_PATH: join(root, 'cc-creds'),
    QLB_CSWAP_SEQUENCE_PATH: join(root, 'missing-sequence.json'),
    QLB_CSWAP_USAGE_PATH: join(root, 'missing-usage.json'),
  };
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = isolatedEnv(),
  cwd?: string,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      env,
      cwd,
      timeout: 60_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
    };
  }
}

function parseJson(stdout: string): unknown {
  return JSON.parse(stdout);
}

type MigrateFixture = {
  env: NodeJS.ProcessEnv;
  root: string;
  safe: string;
  live: string;
};

function migrateFixture(): MigrateFixture {
  const env = isolatedEnv();
  const root = String(env.HOME);
  const safe = join(root, 'safe');
  const live = join(root, 'live-agent');
  mkdirSync(safe, { recursive: true });
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, 'auth.json'), '{}\n');
  env.QLB_PI_AUTH_JSON_PATH = join(live, 'auth.json');
  return { env, root, safe, live };
}

function expectUnsafeMigrate(
  result: { status: number; stderr: string },
  detail: RegExp,
): void {
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /unsafe-migrate-path/);
  assert.match(result.stderr, detail);
}

function assertNoMigrateStore(root: string): void {
  assert.equal(existsSync(join(root, 'qlb.db')), false);
  assert.equal(existsSync(join(root, 'backups')), false);
}

describe('CLI smoke — documented commands', () => {
  it('status, status --json, status --dashboard, status --flat exit 0', () => {
    const env = isolatedEnv();
    const human = runCli(['status'], env);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /override=/);

    const json = runCli(['status', '--json'], env);
    assert.equal(json.status, 0, json.stderr);
    const body = parseJson(json.stdout) as {
      fetchedAt: number;
      accounts: Array<{
        accountId: string;
        provider: string;
        label: string;
        buckets: unknown;
        ownership: string;
        override: unknown;
        health: string;
        healthGlyph: string;
      }>;
    };
    assert.equal(typeof body.fetchedAt, 'number');
    assert.ok(Array.isArray(body.accounts));
    assert.ok(body.accounts.length > 0);
    for (const account of body.accounts) {
      assert.equal(typeof account.accountId, 'string');
      assert.equal(typeof account.provider, 'string');
      assert.equal(typeof account.label, 'string');
      assert.equal(typeof account.buckets, 'object');
      assert.equal(typeof account.ownership, 'string');
      assert.ok(account.override === null || typeof account.override === 'object');
      assert.ok(['ok', 'warn', 'fail'].includes(account.health));
      assert.ok(['✓', '⚠', '✗'].includes(account.healthGlyph));
    }

    const dashboard = runCli(['status', '--dashboard'], env);
    assert.equal(dashboard.status, 0, dashboard.stderr);
    assert.match(dashboard.stdout, /override=/);

    const flat = runCli(['status', '--flat'], env);
    assert.equal(flat.status, 0, flat.stderr);
    assert.match(flat.stdout, /provider/);
    assert.match(flat.stdout, /account/);
    assert.match(flat.stdout, /bucket/);
  });

  it('why and why --json exit 0, and --json parses as JSON', () => {
    const env = isolatedEnv();
    const human = runCli(['why'], env);
    assert.equal(human.status, 0, human.stderr);

    const json = runCli(['why', '--json'], env);
    assert.equal(json.status, 0, json.stderr);
    const body = parseJson(json.stdout) as {
      accountId: string | null;
      strategy: string;
      score: number | null;
      losers: unknown;
    };
    assert.equal(typeof body.strategy, 'string');
    assert.ok(body.accountId === null || typeof body.accountId === 'string');
    assert.ok(body.score === null || typeof body.score === 'number');
    assert.ok(Array.isArray(body.losers));
  });

  it('resolve --model --json returns valid JSON (0 or EXHAUSTED 1)', () => {
    const result = runCli(['resolve', '--model', 'claude-sonnet-5', '--json']);
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    const body = parseJson(result.stdout) as { error?: string; requestedModel?: string };
    if (result.status === 1) {
      assert.equal(body.error, 'EXHAUSTED');
    } else {
      assert.equal(typeof body.requestedModel, 'string');
    }
  });

  it('doctor --json exits 0 or 1 with valid JSON', () => {
    const result = runCli(['doctor', '--json']);
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    const body = parseJson(result.stdout) as { command: string; overall: string };
    assert.equal(body.command, 'doctor');
    assert.ok(['PASS', 'WARN', 'FAIL'].includes(body.overall));
  });

  it('init --json exits 0 with valid JSON', () => {
    const result = runCli(['init', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const body = parseJson(result.stdout) as { command: string; configPath: string };
    assert.equal(body.command, 'init');
    assert.equal(typeof body.configPath, 'string');
  });

  it('migrate status --json for each of 5 providers exits 0', () => {
    const providers = ['anthropic', 'xai', 'kimi-coding', 'openai-codex', 'openrouter'];
    for (const provider of providers) {
      const env = isolatedEnv();
      const target = join(env.QLB_DB_PATH!, '..', 'migrate');
      const result = runCli(
        [
          'migrate',
          'status',
          '--provider',
          provider,
          '--target-dir',
          target,
          '--db',
          env.QLB_DB_PATH!,
          '--json',
        ],
        env,
      );
      assert.equal(result.status, 0, `${provider}: ${result.stderr}`);
      const body = parseJson(result.stdout) as { state: string };
      assert.equal(typeof body.state, 'string');
    }
  });

  it('migrate status --provider xai --target-dir reports owner: present from the map', () => {
    const env = isolatedEnv();
    const target = join(env.QLB_HOME!, 'migrate');
    writeFileSync(join(target, 'qlb-owner.json'), JSON.stringify({ providers: { xai: { mode: 'qlb', since: 1 } } }) + '\n');

    const result = runCli([
      'migrate', 'status', '--provider', 'xai', '--target-dir', target, '--db', env.QLB_DB_PATH!,
    ], env);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /owner:\s+present/);
  });

  it('plain-text migrate status prints the hand-back record fields with null shown as not fenced', () => {
    const env = isolatedEnv();
    const store = openStore(env.QLB_DB_PATH!);
    try {
      store.upsertMigration('pi-xai', 'NATIVE', JSON.stringify({
        handback: {
          phase: 'cleanup-pending',
          keychainDisposition: 'keep',
          piFingerprint: null,
          decision: null,
          fencedGeneration: null,
          rolledBackAt: 123,
        },
      }));
    } finally {
      store.close();
    }

    const result = runCli([
      'migrate',
      'status',
      '--provider',
      'xai',
      '--target-dir',
      join(env.QLB_HOME!, 'migrate'),
      '--db',
      env.QLB_DB_PATH!,
    ], env);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /hand-back phase: cleanup-pending/);
    assert.match(result.stdout, /hand-back keychain disposition: keep/);
    assert.match(result.stdout, /hand-back pi fingerprint: null/);
    assert.match(result.stdout, /hand-back decision: not fenced/);
    assert.match(result.stdout, /hand-back fenced generation: not fenced/);
    assert.match(result.stdout, /hand-back rolled back at: 123/);
    assert.ok(
      result.stdout.indexOf('hand-back phase:')
        < result.stdout.indexOf('hand-back keychain disposition:')
        && result.stdout.indexOf('hand-back keychain disposition:')
          < result.stdout.indexOf('hand-back pi fingerprint:')
        && result.stdout.indexOf('hand-back pi fingerprint:')
          < result.stdout.indexOf('hand-back decision:')
        && result.stdout.indexOf('hand-back decision:')
          < result.stdout.indexOf('hand-back fenced generation:')
        && result.stdout.indexOf('hand-back fenced generation:')
          < result.stdout.indexOf('hand-back rolled back at:'),
      'hand-back fields print in record order',
    );
  });

  it('override list --json exits 0 with an empty list', () => {
    const env = isolatedEnv();
    const result = runCli(['override', 'list', '--json', '--db', env.QLB_DB_PATH!], env);
    assert.equal(result.status, 0, result.stderr);
    const body = parseJson(result.stdout) as { overrides: unknown[] };
    assert.ok(Array.isArray(body.overrides));
    assert.equal(body.overrides.length, 0);
  });

  it('policy list --json exits 0', () => {
    const env = isolatedEnv();
    const result = runCli(['policy', 'list', '--json', '--db', env.QLB_DB_PATH!], env);
    assert.equal(result.status, 0, result.stderr);
    const body = parseJson(result.stdout) as { policies: unknown[] };
    assert.ok(Array.isArray(body.policies));
  });

  it('retire native status --json is a known non-zero refusal when nothing is eligible', () => {
    const env = isolatedEnv();
    for (const harness of ['claude-code', 'codex-cli']) {
      const result = runCli(
        ['retire', 'native', 'status', '--harness', harness, '--json', '--db', env.QLB_DB_PATH!],
        env,
      );
      assert.equal(result.status, 1, `${harness}: ${result.stderr}\n${result.stdout}`);
      const body = parseJson(result.stdout) as { eligible: boolean; harness: string };
      assert.equal(body.eligible, false);
      assert.equal(body.harness, harness);
    }
  });

  it('setup pi|claude-code|codex-cli|generic --json exits 0 with the documented shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-setup-smoke-'));
    const env = isolatedEnv();
    const harnesses = ['pi', 'claude-code', 'codex-cli', 'generic'] as const;
    for (const harness of harnesses) {
      const result = runCli(['setup', harness, '--json'], env);
      assert.equal(result.status, 0, `${harness}: ${result.stderr}`);
      const body = parseJson(result.stdout) as {
        harness: string;
        instructions: string;
        snippetWritten?: string;
      };
      assert.equal(body.harness, harness);
      assert.equal(typeof body.instructions, 'string');
      assert.ok(body.instructions.length > 0);
      if (harness === 'pi') {
        assert.equal(body.snippetWritten, 'scripts/hooks/pi-advisory.sh');
      } else {
        assert.equal(body.snippetWritten, undefined);
      }
    }
    // The live CLI writes the hook into this repo; keep it sourceable.
    const hook = join(root, '..');
    void hook;
    assert.ok(existsSync(join(__dirname, '..', '..', 'scripts', 'hooks', 'pi-advisory.sh')));
  });

  it('install.sh is executable and encodes the documented steps', () => {
    const script = join(__dirname, '..', '..', 'scripts', 'install.sh');
    assert.ok(existsSync(script));
    const mode = statSync(script).mode;
    assert.ok((mode & 0o111) !== 0, 'install.sh should be executable');
    const text = readFileSync(script, 'utf8');
    assert.match(text, /NODE_MAJOR/);
    assert.match(text, /npm ci/);
    assert.match(text, /npm run build/);
    assert.match(text, /npm link/);
    assert.match(text, /qlb init/);
  });

  it('consume-cli-idle', () => {
    const env = isolatedEnv();
    const zero = runCli(['proxy', '--idle-ms', '0'], env);
    assert.equal(zero.status, 1);
    assert.match(zero.stderr, /must be a positive number/);
    const help = runCli(['proxy', '--no-idle', '--help'], env);
    assert.doesNotMatch(help.stderr + help.stdout, /unknown argument/);
  });

  it('consume enable still refuses on a v1 Anthropic owner document', () => {
    const env = isolatedEnv();
    const ownerFile = join(dirname(String(env.QLB_PI_AUTH_JSON_PATH)), 'qlb-owner.json');
    writeFileSync(ownerFile, JSON.stringify({ owner: 'qlb', accounts: [{ provider: 'anthropic' }] }));
    const result = runCli(['consume', 'enable', '--provider', 'anthropic', '--json'], env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DUAL_OWNERSHIP_REFUSED/);
  });

  it('consume enable still refuses on a v2 Anthropic owner entry', () => {
    const env = isolatedEnv();
    const ownerFile = join(dirname(String(env.QLB_PI_AUTH_JSON_PATH)), 'qlb-owner.json');
    writeFileSync(ownerFile, JSON.stringify({ providers: { anthropic: { mode: 'qlb' } } }));
    const result = runCli(['consume', 'enable', '--provider', 'anthropic', '--json'], env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DUAL_OWNERSHIP_REFUSED/);
  });

  it('consume enable refuses while the Pi pool journal owns Anthropic', () => {
    const journaled = isolatedEnv();
    const store = openStore(String(journaled.QLB_DB_PATH));
    store.upsertMigration('pi-pool', 'QLB_OWNED', '{}');
    store.close();
    const byJournal = runCli(['consume', 'enable', '--provider', 'anthropic', '--json'], journaled);
    assert.equal(byJournal.status, 1);
    assert.match(byJournal.stderr, /DUAL_OWNERSHIP_REFUSED/);
    const after = runCli(['consume', 'status', '--provider', 'anthropic', '--json'], journaled);
    assert.equal(JSON.parse(after.stdout).state, 'NATIVE');
  });

  it('consume enable ignores a shared owner map when it has no Anthropic entry', () => {
    const env = isolatedEnv();
    const ownerFile = join(dirname(String(env.QLB_PI_AUTH_JSON_PATH)), 'qlb-owner.json');
    writeFileSync(ownerFile, JSON.stringify({ providers: { xai: { mode: 'qlb' } } }));
    const result = runCli(['consume', 'enable', '--provider', 'anthropic', '--json'], env);
    assert.equal(result.status, 0, result.stderr);
  });

  it('consume enable writes the marker before the journal; a marker failure leaves NATIVE', () => {
    const env = isolatedEnv();
    const marker = join(dirname(String(env.QLB_DB_PATH)), 'consume-anthropic.json');
    mkdirSync(marker); // a directory where the marker file must go -> write fails
    const failed = runCli(['consume', 'enable', '--provider', 'anthropic', '--json'], env);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /cannot write/);
    const status = runCli(['consume', 'status', '--provider', 'anthropic', '--json'], env);
    assert.equal(JSON.parse(status.stdout).state, 'NATIVE');
  });

  it('doctor flags a CONSUMED journal without its marker, and a stray marker', () => {
    const env = isolatedEnv();
    const marker = join(dirname(String(env.QLB_DB_PATH)), 'consume-anthropic.json');
    assert.equal(runCli(['consume', 'enable', '--provider', 'anthropic', '--json'], env).status, 0);
    const ok = JSON.parse(runCli(['doctor', '--json'], env).stdout) as { checks: Array<{ name: string; level: string }> };
    assert.equal(ok.checks.find((c) => c.name === 'consume:marker')?.level, 'PASS');
    unlinkSync(marker);
    const missing = JSON.parse(runCli(['doctor', '--json'], env).stdout) as { checks: Array<{ name: string; level: string }> };
    assert.equal(missing.checks.find((c) => c.name === 'consume:marker')?.level, 'FAIL');
    assert.equal(runCli(['consume', 'disable', '--provider', 'anthropic', '--json'], env).status, 0);
    writeFileSync(marker, '{"state":"CONSUMED"}\n');
    const stray = JSON.parse(runCli(['doctor', '--json'], env).stdout) as { checks: Array<{ name: string; level: string }> };
    assert.equal(stray.checks.find((c) => c.name === 'consume:marker')?.level, 'WARN');
  });

  it('consume enable refuses a one-off database Pi cannot discover', () => {
    const env = isolatedEnv();
    const other = join(mkdtempSync(join(tmpdir(), 'qlb-smoke-otherdb-')), 'qlb.db');
    for (const args of [['--db', other], ['--db-path', other]]) {
      const r = runCli(['consume', 'enable', '--provider', 'anthropic', ...args, '--json'], env);
      assert.equal(r.status, 1, `${args[0]}: ${r.stdout}`);
      assert.match(r.stderr, /not the database Pi uses/);
    }
    // A relative QLB_DB_PATH is cwd-dependent: refused even though it matches here.
    const relDir = `qlb-smoke-relative-${process.pid}`;
    try {
      const rel = runCli(['consume', 'enable', '--provider', 'anthropic', '--json'], { ...env, QLB_DB_PATH: `${relDir}/qlb.db` });
      assert.equal(rel.status, 1, rel.stdout);
      assert.match(rel.stderr, /is relative/);
      assert.equal(existsSync(relDir), false, 'a refused target must not be created');
    } finally {
      rmSync(relDir, { recursive: true, force: true });
    }
    // The environment-backed absolute database (what Pi sees) still works.
    assert.equal(runCli(['consume', 'enable', '--provider', 'anthropic', '--json'], env).status, 0);
  });

  it('consume disable fails loudly when the marker cannot be removed', () => {
    const env = isolatedEnv();
    assert.equal(runCli(['consume', 'enable', '--provider', 'anthropic', '--json'], env).status, 0);
    const marker = join(dirname(String(env.QLB_DB_PATH)), 'consume-anthropic.json');
    unlinkSync(marker);
    mkdirSync(marker); // unlink() cannot remove a directory
    writeFileSync(join(marker, 'keep'), 'x');
    const disabled = runCli(['consume', 'disable', '--provider', 'anthropic', '--json'], env);
    assert.equal(disabled.status, 1);
    assert.ok(disabled.stderr.includes(marker), disabled.stderr);
    const status = runCli(['consume', 'status', '--provider', 'anthropic', '--json'], env);
    assert.equal(JSON.parse(status.stdout).state, 'NATIVE');
  });

  it('refuses Anthropic rollback when pool and owner are temporary but auth.json is the real cutover path', () => {
    const env = isolatedEnv();
    const liveAgent = join(String(env.HOME), '.pi', 'agent');
    mkdirSync(liveAgent, { recursive: true });
    env.QLB_PI_AUTH_JSON_PATH = join(liveAgent, 'auth.json');
    const migrateDir = mkdtempSync(join(tmpdir(), 'qlb-smoke-real-auth-'));
    const result = runCli([
      'migrate', 'rollback', '--provider', 'anthropic',
      '--pool-file', join(migrateDir, 'pool.json'),
      '--owner-file', join(migrateDir, 'qlb-owner.json'),
      '--json',
    ], env);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /REAL Pi credential cutover/);
  });

  it('refuses an Anthropic rollback whose symlinked auth.json targets the real Pi agent dir', () => {
    const env = isolatedEnv();
    const liveAgent = join(String(env.HOME), '.pi', 'agent');
    mkdirSync(liveAgent, { recursive: true });
    writeFileSync(join(liveAgent, 'auth.json'), '{}\n');
    const migrateDir = mkdtempSync(join(tmpdir(), 'qlb-smoke-real-auth-symlink-'));
    const linkedAuth = join(migrateDir, 'linked-auth.json');
    symlinkSync(join(liveAgent, 'auth.json'), linkedAuth);

    const result = runCli([
      'migrate', 'rollback', '--provider', 'anthropic',
      '--pool-file', join(migrateDir, 'pool.json'),
      '--owner-file', join(migrateDir, 'qlb-owner.json'),
      '--auth-json', linkedAuth,
      '--json',
    ], env);

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /REAL Pi credential cutover/);
  });

  it('forward anthropic migration refuses while cswap consume is enabled; status and rollback do not', () => {
    const env = isolatedEnv();
    const protectedDir = join(String(env.HOME), 'protected-agent');
    mkdirSync(protectedDir, { recursive: true });
    writeFileSync(join(protectedDir, 'auth.json'), '{}\n');
    env.QLB_PI_AUTH_JSON_PATH = join(protectedDir, 'auth.json');
    const enabled = runCli(['consume', 'enable', '--provider', 'anthropic', '--json'], env);
    assert.equal(enabled.status, 0, enabled.stderr);
    // Default paths: the ownership refusal must win over the real-cutover path refusal.
    for (const sub of ['stage', 'rehearse', 'commit', 'resume']) {
      const refused = runCli(['migrate', sub, '--provider', 'anthropic', '--json'], env);
      assert.equal(refused.status, 1, `${sub}: ${refused.stdout}`);
      assert.match(refused.stderr, /DUAL_OWNERSHIP_REFUSED/);
    }
    // Outside the isolated Pi agent dir, so the real-cutover refusal does not fire.
    const migrateDir = mkdtempSync(join(tmpdir(), 'qlb-smoke-migrate-'));
    const paths = [
      '--pool-file', join(migrateDir, 'pool.json'),
      '--owner-file', join(migrateDir, 'qlb-owner.json'),
      '--auth-json', join(migrateDir, 'auth.json'),
    ];
    const status = runCli(['migrate', 'status', '--provider', 'anthropic', ...paths, '--json'], env);
    assert.equal(status.status, 0, status.stderr);
    const rollback = runCli(['migrate', 'rollback', '--provider', 'anthropic', ...paths, '--json'], env);
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.doesNotMatch(rollback.stderr, /DUAL_OWNERSHIP_REFUSED/);
  });

  it('1 migrate refuses a symlinked auth-json into the protected Pi directory', () => {
    const { env, safe, live } = migrateFixture();
    const linkedAuth = join(safe, 'auth-link.json');
    symlinkSync(join(live, 'auth.json'), linkedAuth);

    const result = runCli([
      'migrate', 'rollback', '--provider', 'anthropic',
      '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'),
      '--auth-json', linkedAuth,
    ], env);

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /REAL Pi credential cutover/);
  });

  it('2 migrate refuses link slash dotdot before normalization', () => {
    const { env, safe, live } = migrateFixture();
    mkdirSync(join(live, 'sub'));
    const link = join(safe, 'link');
    symlinkSync(join(live, 'sub'), link);

    expectUnsafeMigrate(runCli([
      'migrate', 'rollback', '--provider', 'anthropic',
      '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'),
      '--auth-json', 'link/../auth.json',
    ], env, safe), /dot segments/);
  });

  it('3 migrate refuses a dangling auth-json symlink into the protected Pi directory', () => {
    const { env, safe, live } = migrateFixture();
    const linkedAuth = join(safe, 'auth-link.json');
    symlinkSync(join(live, 'new.json'), linkedAuth);

    const result = runCli([
      'migrate', 'rollback', '--provider', 'anthropic',
      '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'),
      '--auth-json', linkedAuth,
    ], env);

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /REAL Pi credential cutover/);
    assert.equal(existsSync(join(live, 'new.json')), false);
  });

  it('4 migrate refuses missing slash dotdot slash link', () => {
    const { env, safe, live } = migrateFixture();
    const link = join(safe, 'link');
    symlinkSync(live, link);

    expectUnsafeMigrate(runCli([
      'migrate', 'rollback', '--provider', 'anthropic',
      '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'),
      '--auth-json', 'missing/../link/auth.json',
    ], env, safe), /dot segments/);
    assert.equal(existsSync(join(safe, 'missing')), false);
  });

  it('5 migrate refuses owner-file link2 slash dotdot slash link before deriving owner map', () => {
    const { env, safe, live } = migrateFixture();
    const elsewhere = join(safe, 'elsewhere');
    mkdirSync(join(elsewhere, 'sub'), { recursive: true });
    symlinkSync(join(elsewhere, 'sub'), join(safe, 'link2'));
    symlinkSync(live, join(safe, 'link'));
    const ownerFile = 'link2/../link/owner.json';

    expectUnsafeMigrate(runCli([
      'migrate', 'rollback', '--provider', 'anthropic',
      '--pool-file', join(safe, 'pool.json'), '--owner-file', ownerFile,
      '--auth-json', join(safe, 'auth.json'),
    ], env, safe), /dot segments/);
    assert.equal(existsSync(join(live, 'qlb-owner.json')), false);
  });

  it('6 migrate refuses existing-file slash dotdot without relocating the target', () => {
    const { env, safe } = migrateFixture();
    writeFileSync(join(safe, 'file'), 'not a directory\n');
    writeFileSync(join(safe, 'victim'), 'unchanged\n');

    expectUnsafeMigrate(runCli([
      'migrate', 'rollback', '--provider', 'anthropic',
      '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'),
      '--auth-json', 'file/../victim',
    ], env, safe), /dot segments/);
    assert.equal(readFileSync(join(safe, 'victim'), 'utf8'), 'unchanged\n');
  });

  it('7 migrate refuses a non-directory intermediate component', () => {
    const { env, safe } = migrateFixture();
    writeFileSync(join(safe, 'file'), 'not a directory\n');

    expectUnsafeMigrate(runCli([
      'migrate', 'rollback', '--provider', 'anthropic',
      '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'),
      '--auth-json', `${join(safe, 'file')}/child`,
    ], env), /ENOTDIR/);
  });

  it('8 migrate validates target-dir before joining default filenames', () => {
    const { env, safe, live } = migrateFixture();
    const link = join(safe, 'link');
    symlinkSync(live, link);
    const targetDir = `${safe}/missing/../link`;
    const defaults = ['migrate', 'rollback', '--provider', 'anthropic', '--target-dir', targetDir];
    expectUnsafeMigrate(runCli(defaults, env), /dot segments/);
    expectUnsafeMigrate(runCli([
      ...defaults,
      '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'),
      '--auth-json', join(safe, 'auth.json'),
    ], env), /dot segments/);
  });

  it('9 migrate validates the raw Pi auth environment override before config normalization', () => {
    const relative = migrateFixture();
    symlinkSync(relative.live, join(relative.safe, 'link'));
    const args = [
      'migrate', 'rollback', '--provider', 'anthropic',
      '--pool-file', join(relative.safe, 'pool.json'), '--owner-file', join(relative.safe, 'owner.json'),
      '--auth-json', join(relative.safe, 'auth.json'),
    ];
    relative.env.QLB_PI_AUTH_JSON_PATH = 'link/../auth.json';
    expectUnsafeMigrate(runCli(args, relative.env, relative.safe), /dot segments/);
    assertNoMigrateStore(relative.root);

    const absolute = migrateFixture();
    symlinkSync(absolute.live, join(absolute.safe, 'link'));
    absolute.env.QLB_PI_AUTH_JSON_PATH = `${join(absolute.safe, 'link')}/../auth.json`;
    expectUnsafeMigrate(runCli([
      'migrate', 'rollback', '--provider', 'anthropic',
      '--pool-file', join(absolute.safe, 'pool.json'), '--owner-file', join(absolute.safe, 'owner.json'),
      '--auth-json', join(absolute.safe, 'auth.json'),
    ], absolute.env), /dot segments/);
    assertNoMigrateStore(absolute.root);
  });

  it('migrate validates the raw Pi auth flag that wins over a safe environment value', () => {
    const { env, root, safe, live } = migrateFixture();
    symlinkSync(live, join(safe, 'link'));
    const raw = 'link/../auth.json';
    env.QLB_PI_AUTH_JSON_PATH = join(live, 'auth.json');

    expectUnsafeMigrate(runCli([
      '--pi-auth-json-path', raw,
      'migrate', 'rollback', '--provider', 'anthropic',
      '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'),
      '--auth-json', join(safe, 'auth.json'),
    ], env, safe), /dot segments/);
    assertNoMigrateStore(root);
  });

  it('migrate validates the raw Pi auth config-file value before config normalization', () => {
    const { env, root, safe, live } = migrateFixture();
    symlinkSync(live, join(safe, 'link'));
    delete env.QLB_PI_AUTH_JSON_PATH;
    writeFileSync(env.QLB_CONFIG_PATH!, JSON.stringify({
      piAuthJsonPath: '~/safe/link/../auth.json',
    }));

    expectUnsafeMigrate(runCli([
      'migrate', 'rollback', '--provider', 'anthropic',
      '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'),
      '--auth-json', join(safe, 'auth.json'),
    ], env), /dot segments/);
    assertNoMigrateStore(root);
  });

  it('migrate validates a default Pi auth path built from a home spelling with dot segments', () => {
    const env = isolatedEnv();
    const root = String(env.HOME);
    const home = join(root, 'home');
    mkdirSync(home);
    env.QLB_HOME = `${home}/../home`;
    delete env.QLB_PI_AUTH_JSON_PATH;

    expectUnsafeMigrate(runCli([
      'migrate', 'rollback', '--provider', 'openrouter', '--owner-file', join(root, 'owner.json'),
    ], env), /dot segments/);
    assertNoMigrateStore(root);
  });

  it('10 migrate rejects dot segments in every guarded flag', () => {
    const { env, safe } = migrateFixture();
    const flags = ['--pool-file', '--owner-file', '--auth-json'] as const;
    for (const flag of flags) {
      const result = runCli([
        'migrate', 'rollback', '--provider', 'anthropic',
        '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'),
        '--auth-json', join(safe, 'auth.json'),
        flag, './x',
      ], env, safe);
      expectUnsafeMigrate(result, /dot segments/);
    }
  });

  it('30 confirm-real-cutover allows only structurally valid protected targets', () => {
    const { env, safe, live } = migrateFixture();
    const base = [
      'migrate', 'rollback', '--provider', 'anthropic',
      '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'),
      '--auth-json', join(live, 'auth.json'),
    ];
    const unconfirmed = runCli(base, env);
    assert.equal(unconfirmed.status, 2, unconfirmed.stderr);
    assert.match(unconfirmed.stderr, /REAL Pi credential cutover/);

    const valid = runCli([...base, '--confirm-real-cutover'], env);
    assert.equal(valid.status, 0, valid.stderr);

    expectUnsafeMigrate(runCli([
      'migrate', 'rollback', '--provider', 'anthropic', '--confirm-real-cutover',
      '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'),
      '--auth-json', './auth.json',
    ], env, safe), /dot segments/);
  });

  it('migrate refuses structural path errors before creating a store or backup', () => {
    const cases: Array<{ name: string; setup: (fixture: MigrateFixture) => string[]; detail: RegExp }> = [
      {
        name: 'missing protected directory',
        setup: ({ env, root, safe }) => {
          env.QLB_PI_AUTH_JSON_PATH = join(root, 'missing', 'auth.json');
          return ['migrate', 'rollback', '--provider', 'anthropic', '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'), '--auth-json', join(safe, 'auth.json')];
        },
        detail: /protected Pi directory is missing/,
      },
      {
        name: 'non-directory protected path component',
        setup: ({ env, safe }) => {
          writeFileSync(join(safe, 'file'), 'not a directory\n');
          env.QLB_PI_AUTH_JSON_PATH = join(safe, 'file', 'auth.json');
          return ['migrate', 'rollback', '--provider', 'anthropic', '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'), '--auth-json', join(safe, 'auth.json')];
        },
        detail: /ENOTDIR/,
      },
      {
        name: 'symlinked owner entry leaf',
        setup: ({ safe }) => {
          writeFileSync(join(safe, 'owner-target.json'), '{}\n');
          symlinkSync('owner-target.json', join(safe, 'owner.json'));
          return ['migrate', 'rollback', '--provider', 'anthropic', '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'), '--auth-json', join(safe, 'auth.json')];
        },
        detail: /symlinked entry path/,
      },
      {
        name: 'unsafe symlink target',
        setup: ({ safe, live }) => {
          symlinkSync('../live-agent', join(safe, 'link'));
          return ['migrate', 'rollback', '--provider', 'anthropic', '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'), '--auth-json', join(safe, 'link', 'auth.json')];
        },
        detail: /symlink target contains dot segments/,
      },
    ];
    for (const testCase of cases) {
      const fixture = migrateFixture();
      expectUnsafeMigrate(runCli(testCase.setup(fixture), fixture.env), testCase.detail);
      assertNoMigrateStore(fixture.root);
    }
  });

  it('migrate ignores structurally unsafe paths the selected provider never touches', () => {
    const { env, safe } = migrateFixture();
    writeFileSync(join(safe, 'pool-target.json'), '{}\n');
    symlinkSync('pool-target.json', join(safe, 'pool.json'));

    const result = runCli([
      'migrate', 'rollback', '--provider', 'xai',
      '--pool-file', join(safe, 'pool.json'), '--owner-file', join(safe, 'owner.json'),
      '--auth-json', join(safe, 'auth.json'),
    ], env);
    assert.equal(result.status, 0, result.stderr);
  });

  it('install.ps1 encodes the documented Windows installer steps', () => {
    const script = join(__dirname, '..', '..', 'scripts', 'install.ps1');
    assert.ok(existsSync(script));
    const text = readFileSync(script, 'utf8');
    assert.match(text, /Node\.js >= 22/);
    assert.match(text, /npm ci/);
    assert.match(text, /npm run build/);
    assert.match(text, /npm link/);
    assert.match(text, /qlb init/);
  });
});
