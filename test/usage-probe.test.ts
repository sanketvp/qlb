import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import usageProbeCommand, { runUsageProbe } from '../src/commands/usage-probe';
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

describe('usage probe command', () => {
  it('is a multi-word executing registry command', async () => {
    assert.equal(usageProbeCommand.name, 'usage probe');
    assert.equal(usageProbeCommand.run, undefined);
    assert.equal(typeof usageProbeCommand.execute, 'function');

    const errors: string[] = [];
    const code = await usageProbeCommand.execute!(
      ['kimi-coding'],
      { stdout: () => {}, stderr: (line: string) => errors.push(line) } as never,
    );

    assert.equal(code, 1);
    assert.deepEqual(errors, ['qlb usage probe: expected openai-codex|kimi-coding --json [--source pi-auth (kimi-coding only)]']);
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

  it('--source pi-auth sends Pi\'s kimi-coding access token, and the default sends QLB\'s', async () => {
    const authJsonPath = piAuthFile({ type: 'oauth', access: PI_TOKEN, refresh: 'pi-refresh', expires: Date.now() + 3_600_000 });
    const sent: string[] = [];
    const fetchFn = recordingFetch(sent);

    const pi = await probeKimiCodingUsage({ credentialSource: 'pi-auth', authJsonPath, fetchFn, qlbAccess: () => QLB_TOKEN });
    const qlb = await probeKimiCodingUsage({ authJsonPath, fetchFn, qlbAccess: () => QLB_TOKEN });

    assert.deepEqual(sent, [`Bearer ${PI_TOKEN}`, `Bearer ${QLB_TOKEN}`]);
    assert.deepEqual(pi, { status: 200, source: 'kimi-api', keys: ['usage', 'limits'] });
    assert.deepEqual(qlb, { status: 200, source: 'kimi-api', keys: ['usage', 'limits'] });
  });

  it('--source pi-auth refuses the QLB placeholder, a missing entry and an unreadable file without a request', async () => {
    const sent: string[] = [];
    const fetchFn = recordingFetch(sent);
    const placeholder = piAuthFile({ type: 'oauth', access: 'qlb-managed', refresh: '', expires: Date.now() + 1e12 });
    const missing = piAuthFile(undefined);
    const unreadable = join(mkdtempSync(join(tmpdir(), 'qlb-probe-')), 'auth.json');
    writeFileSync(unreadable, '{not json');

    for (const authJsonPath of [placeholder, missing, unreadable, join(tmpdir(), 'qlb-probe-absent', 'auth.json')]) {
      const result = await probeKimiCodingUsage({ credentialSource: 'pi-auth', authJsonPath, fetchFn });
      assert.deepEqual(result, { status: null, source: 'unknown', keys: [] });
    }
    assert.equal(sent.length, 0);
  });

  it('prints credentialSource for --source pi-auth, exits 1 on no status, and never prints a token', async () => {
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
    assert.equal(output.join('\n').includes(PI_TOKEN), false);
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
