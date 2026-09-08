import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const cliPath = join(__dirname, '..', 'src', 'cli.js');

function isolatedEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'qlb-smoke-'));
  mkdirSync(join(root, 'migrate'), { recursive: true });
  return {
    ...process.env,
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
  };
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = isolatedEnv(),
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      env,
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

  it('policy list --json exits 0', () => {
    const env = isolatedEnv();
    const result = runCli(['policy', 'list', '--json', '--db', env.QLB_DB_PATH!], env);
    assert.equal(result.status, 0, result.stderr);
    const body = parseJson(result.stdout) as { policies: unknown[] };
    assert.ok(Array.isArray(body.policies));
  });

  it('retire status --json is a known non-zero refusal when nothing is eligible', () => {
    const env = isolatedEnv();
    for (const harness of ['claude-code', 'codex-cli']) {
      const result = runCli(
        ['retire', 'status', '--harness', harness, '--json', '--db', env.QLB_DB_PATH!],
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
