import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import usageProbeCommand, { runUsageProbe } from '../src/commands/usage-probe';
import { MockKeychain, QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { probeKimiCodingUsage } from '../src/usage/kimi-coding';

const PI_TOKEN = 'pi-auth-fixture-access-token';
const QLB_TOKEN = 'qlb-managed-item-fixture-token';

function piAuthFile(entry: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'qlb-probe-')), 'auth.json');
  writeFileSync(path, JSON.stringify({ 'kimi-coding': entry, xai: { type: 'oauth', access: 'other', refresh: 'r', expires: 1 } }));
  return path;
}

function recordingFetch(sent: string[]) {
  return async (_url: string, init?: RequestInit) => {
    sent.push(String((init?.headers as Record<string, string>).Authorization));
    return new Response('{"usage":1,"limits":2}', { status: 200 });
  };
}

function managedKimiProbe(keychain: MockKeychain, fetchFn: ReturnType<typeof recordingFetch>) {
  return (options = {}) => probeKimiCodingUsage({ ...options, keychain, fetchFn });
}

describe('usage probe command', () => {
  it('is a multi-word executing registry command', async () => {
    assert.equal(usageProbeCommand.name, 'usage probe');
    assert.equal(usageProbeCommand.run, undefined);
    assert.equal(typeof usageProbeCommand.execute, 'function');

    const errors: string[] = [];
    const code = await usageProbeCommand.execute!(
      ['kimi-coding'],
      {
        stdout: () => {},
        stderr: (line: string) => errors.push(line),
        config: { piAuthJsonPath: join(tmpdir(), 'qlb-probe-unused', 'auth.json') },
      } as never,
    );

    assert.equal(code, 1);
    assert.deepEqual(errors, ['qlb usage probe: expected openai-codex|kimi-coding --json [--source pi-auth (kimi-coding only)]']);
  });

  it('uses the configured Pi auth path when executing --source pi-auth', async () => {
    const authJsonPath = piAuthFile({ type: 'oauth', access: PI_TOKEN, refresh: 'pi-refresh', expires: Date.now() + 3_600_000 });
    const sent: string[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const fetchMock = mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(String((init?.headers as Record<string, string>).Authorization));
      return new Response('{"usage":1,"limits":2}', { status: 200 });
    });
    try {
      const code = await usageProbeCommand.execute!(
        ['kimi-coding', '--json', '--source', 'pi-auth'],
        {
          stdout: (line: string) => output.push(line),
          stderr: (line: string) => errors.push(line),
          config: { piAuthJsonPath: authJsonPath },
        } as never,
      );
      assert.equal(code, 0);
      assert.deepEqual(sent, [`Bearer ${PI_TOKEN}`]);
      assert.deepEqual(output, ['{"status":200,"source":"kimi-api","credentialSource":"pi-auth","keys":["usage","limits"]}']);
      assert.deepEqual(errors, []);
      assert.equal([...output, ...errors].join('\n').includes(PI_TOKEN), false);
      assert.equal([...output, ...errors].join('\n').includes(QLB_TOKEN), false);
    } finally { fetchMock.mock.restore(); }
  });

  it('prints status, source, and top-level keys only', async () => {
    const output: string[] = [];
    const secret = 'eyJhbGciOiJub25lIn0.fixture-payload.fixture-signature';
    const code = await runUsageProbe(['openai-codex', '--json'], {
      probe: async () => ({
        status: 200,
        source: 'wham',
        keys: ['primary'],
        windows: [{ bucket: 'primary', usedPct: 12 }],
        ignoredBody: secret,
      }),
      write: (line) => output.push(line),
      error: (line) => output.push(`ERR:${line}`),
    });

    assert.equal(code, 0);
    assert.deepEqual(output, ['{"status":200,"source":"wham","keys":["primary"]}']);
    assert.equal(output.join('\n').includes(secret), false);
  });

  it('rejects unsupported providers and non-JSON invocation without probing', async () => {
    let probes = 0;
    const errors: string[] = [];
    const deps = {
      probe: async () => {
        probes += 1;
        return { status: 200, source: 'wham' as const, keys: [] };
      },
      write: (_line: string) => {},
      error: (line: string) => errors.push(line),
    };

    assert.equal(await runUsageProbe(['other', '--json'], deps), 1);
    assert.equal(await runUsageProbe(['openai-codex'], deps), 1);
    assert.equal(probes, 0);
    assert.equal(errors.length, 2);
  });

  it('--source pi-auth reads the configured Pi credential while the default reads QLB\'s managed credential', async () => {
    const authJsonPath = piAuthFile({ type: 'oauth', access: PI_TOKEN, refresh: 'pi-refresh', expires: Date.now() + 3_600_000 });
    const sent: string[] = [];
    const fetchFn = recordingFetch(sent);
    const keychain = new MockKeychain();
    keychain.setSync(
      qlbKeychainService('kimi-coding', 'default'),
      QLB_KEYCHAIN_ACCOUNT,
      JSON.stringify({ access: QLB_TOKEN }),
    );
    const output: string[] = [];
    const deps = {
      piAuthJsonPath: authJsonPath,
      kimiProbe: managedKimiProbe(keychain, fetchFn),
      write: (line: string) => output.push(line),
      error: (line: string) => output.push(`ERR:${line}`),
    };

    const pi = await runUsageProbe(['kimi-coding', '--json', '--source', 'pi-auth'], deps);
    const qlb = await runUsageProbe(['kimi-coding', '--json'], deps);

    assert.deepEqual(sent, [`Bearer ${PI_TOKEN}`, `Bearer ${QLB_TOKEN}`]);
    assert.deepEqual([pi, qlb], [0, 0]);
    assert.deepEqual(output, [
      '{"status":200,"source":"kimi-api","credentialSource":"pi-auth","keys":["usage","limits"]}',
      '{"status":200,"source":"kimi-api","keys":["usage","limits"]}',
    ]);
    assert.equal(output.join('\n').includes(PI_TOKEN), false);
    assert.equal(output.join('\n').includes(QLB_TOKEN), false);
  });

  it('--source pi-auth refuses the QLB placeholder through the CLI without a request', async () => {
    const sent: string[] = [];
    const fetchFn = recordingFetch(sent);
    const placeholder = piAuthFile({ type: 'oauth', access: 'qlb-managed', refresh: '', expires: Date.now() + 1e12 });
    const output: string[] = [];
    const keychain = new MockKeychain();
    keychain.setSync(
      qlbKeychainService('kimi-coding', 'default'),
      QLB_KEYCHAIN_ACCOUNT,
      JSON.stringify({ access: QLB_TOKEN }),
    );
    const code = await runUsageProbe(['kimi-coding', '--json', '--source', 'pi-auth'], {
      piAuthJsonPath: placeholder,
      kimiProbe: managedKimiProbe(keychain, fetchFn),
      write: (line: string) => output.push(line),
    });

    assert.equal(code, 1);
    assert.deepEqual(output, ['{"status":null,"source":"unknown","credentialSource":"pi-auth","keys":[]}']);
    assert.equal(sent.length, 0);
  });

  it('--source pi-auth refuses a missing entry or unreadable file without a request', async () => {
    const sent: string[] = [];
    const fetchFn = recordingFetch(sent);
    const missing = piAuthFile(undefined);
    const unreadable = join(mkdtempSync(join(tmpdir(), 'qlb-probe-')), 'auth.json');
    writeFileSync(unreadable, '{not json');
    const keychain = new MockKeychain();
    keychain.setSync(
      qlbKeychainService('kimi-coding', 'default'),
      QLB_KEYCHAIN_ACCOUNT,
      JSON.stringify({ access: QLB_TOKEN }),
    );

    for (const authJsonPath of [undefined, missing, unreadable, join(tmpdir(), 'qlb-probe-absent', 'auth.json')]) {
      const result = await probeKimiCodingUsage({ credentialSource: 'pi-auth', authJsonPath, keychain, fetchFn });
      assert.deepEqual(result, { status: null, source: 'unknown', keys: [] });
    }
    assert.equal(sent.length, 0);
  });

  it('prints credentialSource for --source pi-auth and exits 1 on no status', async () => {
    const output: string[] = [];
    const deps = { write: (line: string) => output.push(line), error: (line: string) => output.push(`ERR:${line}`) };
    const sources: unknown[] = [];

    const ok = await runUsageProbe(['kimi-coding', '--json', '--source', 'pi-auth'], {
      ...deps,
      kimiProbe: async (options) => { sources.push(options?.credentialSource); return { status: 200, source: 'kimi-api', keys: ['usage'] }; },
    });
    const refused = await runUsageProbe(['kimi-coding', '--json', '--source', 'pi-auth'], {
      ...deps,
      kimiProbe: async () => ({ status: null, source: 'unknown', keys: [] }),
    });
    const defaulted = await runUsageProbe(['kimi-coding', '--json'], {
      ...deps,
      kimiProbe: async (options) => { sources.push(options?.credentialSource); return { status: 200, source: 'kimi-api', keys: [] }; },
    });

    assert.deepEqual([ok, refused, defaulted], [0, 1, 0]);
    assert.deepEqual(sources, ['pi-auth', undefined]);
    assert.deepEqual(output, [
      '{"status":200,"source":"kimi-api","credentialSource":"pi-auth","keys":["usage"]}',
      '{"status":null,"source":"unknown","credentialSource":"pi-auth","keys":[]}',
      '{"status":200,"source":"kimi-api","keys":[]}',
    ]);
  });

  it('accepts --source pi-auth only for kimi-coding', async () => {
    let probes = 0;
    const errors: string[] = [];
    const deps = {
      probe: async () => { probes += 1; return { status: 200, source: 'wham' as const, keys: [] }; },
      kimiProbe: async () => { probes += 1; return { status: 200, source: 'kimi-api' as const, keys: [] }; },
      write: (_line: string) => {},
      error: (line: string) => errors.push(line),
    };

    assert.equal(await runUsageProbe(['openai-codex', '--json', '--source', 'pi-auth'], deps), 1);
    assert.equal(await runUsageProbe(['kimi-coding', '--json', '--source', 'other'], deps), 1);
    assert.equal(await runUsageProbe(['kimi-coding', '--json', '--source'], deps), 1);
    assert.equal(probes, 0);
    assert.equal(errors.length, 3);
  });
});
