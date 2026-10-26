import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import usageProbeCommand, { runUsageProbe } from '../src/commands/usage-probe';

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
    assert.deepEqual(errors, ['qlb usage probe: expected openai-codex|kimi-coding --json']);
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
});
