import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classify,
  inventoryPool,
  type PoolInventoryEntry,
  type PoolInventoryStore,
  type SourceLineage,
} from '../src/pool-inventory';
import { runPiPoolInventoryCommand } from '../src/commands/pi-pool-inventory';
import type { CommandContext } from '../src/registry';
import { openStore } from '../src/store';

const NOW = 1_700_000_000_000;
const FP_A = `sha256:${'a'.repeat(64)}`;
const FP_B = `sha256:${'b'.repeat(64)}`;
const FP_C = `sha256:${'c'.repeat(64)}`;

const entries: PoolInventoryEntry[] = [
  { target: 'pool-a', lineageFp: FP_A, expiresAt: NOW + 86_400_000 },
  { target: 'pool-b', lineageFp: FP_B, expiresAt: null },
];

const sources: SourceLineage[] = [
  { slotAccountId: 'slot-a', lineageFp: FP_A },
  { slotAccountId: 'slot-c', lineageFp: FP_C },
];

function context(output: string[]): CommandContext {
  return {
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(`ERR:${line}`),
    env: { QLB_TEST_MODE: '1', QLB_HOME: '/tmp/qlb-pool-inventory' },
    config: {
      dbPath: '/tmp/qlb-pool-inventory/qlb.db',
      anthropicPoolPath: '/tmp/qlb-pool-inventory/anthropic-pool.json',
      cswapSequencePath: '/tmp/qlb-pool-inventory/sequence.json',
    } as CommandContext['config'],
    loadConfig: () => { throw new Error('not used'); },
    home: '/tmp/qlb-pool-inventory',
    registerSecret: () => {},
    deliverSecret: () => {},
    knownSecrets: () => [],
  };
}

describe('anthropic-pool inventory (P11, AC52)', () => {
  it('classifies shared source lineages and reports only safe expiry horizons', () => {
    const result = classify(entries, sources, NOW);

    assert.deepEqual(result.entries, [
      { target: 'pool-a', lineageShared: true, expiresInMs: 86_400_000 },
      { target: 'pool-b', lineageShared: false, expiresInMs: null },
    ]);
    assert.deepEqual(result.targets, [{
      provider: 'anthropic', target: 'pool-a', slotAccountId: 'slot-a', lineageFp: FP_A, recordedAt: NOW,
    }]);
    const output = JSON.stringify(result.entries);
    assert.doesNotMatch(output, /sha256|credential|refresh|access/i);
  });

  it('refuses ambiguous pool or source identities instead of recording an arbitrary export target', () => {
    assert.throws(() => classify([
      entries[0],
      { ...entries[0], target: 'pool-other' },
    ], sources, NOW), /ambiguous pool lineage/);
    assert.throws(() => classify(entries, [
      sources[0],
      { slotAccountId: 'slot-other', lineageFp: sources[0].lineageFp },
    ], NOW), /ambiguous source lineage/);
  });

  it('replaces only anthropic export targets after classification', () => {
    const store = openStore(':memory:');
    try {
      store.replacePiExportTargets('xai', [{
        provider: 'xai', target: 'unrelated', slotAccountId: 'default', lineageFp: FP_C, recordedAt: NOW,
      }]);
      const result = inventoryPool({ entries, lineages: sources, store, now: () => NOW });
      assert.deepEqual(store.listPiExportTargets('anthropic').map((row) => ({ ...row })), result.targets);
      assert.equal(store.listPiExportTargets('xai').length, 1);
    } finally {
      store.close();
    }
  });

  it('supports cswap and imported-slot sources through the command without printing a credential value', () => {
    const output: string[] = [];
    const store: PoolInventoryStore = { replacePiExportTargets: () => {} };
    const deps = {
      openStore: () => ({ ...store, close: () => {}, listAnthropicSlotLineages: () => [] }),
      loadEntries: () => entries,
      loadCswapLineages: () => sources,
      loadSlotLineages: () => [{ slotAccountId: 'slot-b', lineageFp: FP_B }],
      now: () => NOW,
    };

    assert.equal(runPiPoolInventoryCommand(['--against', 'cswap', '--json'], context(output), deps), 0);
    const cswapOutput = output.pop() ?? '';
    assert.deepEqual(JSON.parse(cswapOutput), {
      against: 'cswap',
      entries: [
        { target: 'pool-a', lineageShared: true, expiresInMs: 86_400_000 },
        { target: 'pool-b', lineageShared: false, expiresInMs: null },
      ],
    });

    assert.equal(runPiPoolInventoryCommand(['--against', 'slots', '--json'], context(output), deps), 0);
    const slotsOutput = output.pop() ?? '';
    assert.deepEqual(JSON.parse(slotsOutput), {
      against: 'slots',
      entries: [
        { target: 'pool-a', lineageShared: false, expiresInMs: 86_400_000 },
        { target: 'pool-b', lineageShared: true, expiresInMs: null },
      ],
    });

    const rendered = `${cswapOutput}\n${slotsOutput}\n${output.join('\n')}`;
    assert.doesNotMatch(rendered, /sha256:|sk-ant-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+/i);
    assert.equal(runPiPoolInventoryCommand(['--against', 'unknown'], context(output), deps), 2);
    assert.equal(runPiPoolInventoryCommand(['--against', 'cswap', '--against', 'slots'], context(output), deps), 2);
  });
});
