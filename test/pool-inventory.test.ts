import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classify,
  inventoryPool,
  readPoolInventoryEntries,
  slotInventoryLineages,
  PoolInventoryError,
  type PoolInventoryEntry,
  type PoolInventoryStore,
  type SourceLineage,
} from '../src/pool-inventory';
import { runPiPoolInventoryCommand } from '../src/commands/pi-pool-inventory';
import { beginCutover } from '../src/lifecycle';
import type { CommandContext } from '../src/registry';
import { DatabaseSync } from 'node:sqlite';
import { openStore, type PiExportTargetInput, type PiExportTargetRow } from '../src/store';

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

  it('rejects two independent source lineages that name one slot', () => {
    assert.throws(() => classify(entries, [
      { slotAccountId: 'slot-a', lineageFp: FP_A },
      { slotAccountId: 'slot-a', lineageFp: FP_B },
    ], NOW), (error: unknown) => error instanceof PoolInventoryError && error.code === 'duplicate-slot-account-id');
  });

  it('collapses a current successor and LKG predecessor from one slot chain into one shared target', () => {
    const result = classify([
      { target: 'pool-a', lineageFp: FP_B, expiresAt: NOW + 1 },
      { target: 'pool-a', lineageFp: FP_A, expiresAt: null },
    ], [
      { slotAccountId: 'slot-a', lineageFp: FP_A, lineageChain: true },
      { slotAccountId: 'slot-a', lineageFp: FP_B, lineageChain: true },
    ], NOW);
    assert.deepEqual(result.targets, [{
      provider: 'anthropic', target: 'pool-a', slotAccountId: 'slot-a', lineageFp: FP_B, recordedAt: NOW,
    }]);
  });

  it('refuses when one slot chain maps to multiple pool targets', () => {
    assert.throws(() => classify([
      { target: 'pool-a', lineageFp: FP_A, expiresAt: null },
      { target: 'pool-b', lineageFp: FP_B, expiresAt: null },
    ], [
      { slotAccountId: 'slot-a', lineageFp: FP_A, lineageChain: true },
      { slotAccountId: 'slot-a', lineageFp: FP_B, lineageChain: true },
    ], NOW), (error: unknown) => error instanceof PoolInventoryError && error.code === 'slot-maps-to-multiple-targets');
  });

  it('replaces only anthropic export targets after classification', () => {
    const store = openStore(':memory:');
    try {
      store.replacePiExportTargets('xai', [{
        provider: 'xai', target: 'unrelated', slotAccountId: 'default', lineageFp: FP_C, recordedAt: NOW,
      }]);
      const result = inventoryPool({ entries, lineages: sources, store, now: () => NOW });
      assert.deepEqual(store.listPiExportTargets('anthropic').map((row) => ({ ...row })), result.targets.map((target) => ({ ...target, recordedBy: 'pool-inventory' })));
      assert.equal(store.listPiExportTargets('xai').length, 1);
    } finally {
      store.close();
    }
  });

  it('allows exactly one of two concurrent --record runs and preserves its rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-pool-inventory-'));
    const dbPath = join(dir, 'qlb.db');
    const poolPath = join(dir, 'anthropic-pool.json');
    const refresh = 'fixture-refresh';
    const fingerprint = `sha256:${createHash('sha256').update(refresh, 'utf8').digest('hex')}`;
    writeFileSync(poolPath, JSON.stringify({ accounts: [{
      id: 'pool-a', credentials: { access: 'fixture-access', refresh, expires: NOW + 1 },
    }] }));
    const setup = openStore(dbPath);
    try {
      beginCutover(setup, NOW);
      (setup as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db.prepare(
        "INSERT INTO claude_slots (account_id, config_json, fingerprint, dead, added_at) VALUES (?, '{}', ?, 0, ?)",
      ).run('slot-a', fingerprint, NOW);
    } finally {
      setup.close();
    }
    const env = {
      HOME: dir,
      PATH: process.env.PATH ?? '',
      QLB_TEST_MODE: '1',
      QLB_HOME: dir,
      QLB_DB_PATH: dbPath,
      QLB_ANTHROPIC_POOL_PATH: poolPath,
    };
    const run = () => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['dist/cli.js', 'pi', 'pool-inventory', '--against', 'slots', '--record'], {
        cwd: process.cwd(), env, stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('close', resolve);
    });
    const statuses = await Promise.all([run(), run()]);
    assert.deepEqual(statuses.sort(), [0, 3]);
    const check = openStore(dbPath);
    try {
      assert.deepEqual(check.listPiExportTargets('anthropic').map((row) => ({ ...row })), [{
        provider: 'anthropic', target: 'pool-a', slotAccountId: 'slot-a', lineageFp: fingerprint,
        recordedAt: check.listPiExportTargets('anthropic')[0]!.recordedAt, recordedBy: 'pool-inventory',
      }]);
    } finally {
      check.close();
    }
  });

  it('classifies and records within one immediate transaction that blocks an external slot archive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-pool-inventory-'));
    const dbPath = join(dir, 'qlb.db');
    const setup = openStore(dbPath);
    try {
      beginCutover(setup, NOW);
      (setup as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db.prepare(
        "INSERT INTO claude_slots (account_id, config_json, fingerprint, dead, added_at) VALUES (?, '{}', ?, 0, ?)",
      ).run('slot-a', FP_A, NOW);
    } finally {
      setup.close();
    }

    const output: string[] = [];
    const commandContext = context(output);
    commandContext.config = { ...commandContext.config, dbPath };
    assert.equal(runPiPoolInventoryCommand(['--against', 'slots', '--record'], commandContext, {
      openStore,
      loadEntries: () => [entries[0]!],
      loadCswapLineages: () => [],
      loadSlotLineages: (store) => {
        const lineages = slotInventoryLineages(store);
        const writer = new DatabaseSync(dbPath);
        try {
          writer.exec('PRAGMA busy_timeout = 0');
          assert.throws(
            () => writer.prepare('UPDATE claude_slots SET archived_at = ? WHERE account_id = ?').run(NOW, 'slot-a'),
            /SQLITE_BUSY|database is locked/i,
          );
        } finally {
          writer.close();
        }
        return lineages;
      },
      admitRecord: () => ({ ok: true }),
      now: () => NOW,
    }), 0);

    const check = openStore(dbPath);
    try {
      assert.deepEqual(check.listAnthropicSlotLineageChains(), [{ accountId: 'slot-a', lineages: [FP_A] }]);
      assert.deepEqual(check.listPiExportTargets('anthropic').map((row) => ({ ...row })), [{
        provider: 'anthropic', target: 'pool-a', slotAccountId: 'slot-a', lineageFp: FP_A, recordedAt: NOW, recordedBy: 'pool-inventory',
      }]);
    } finally {
      check.close();
    }
  });

  it('uses a slot change committed immediately before the recording transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-pool-inventory-'));
    const dbPath = join(dir, 'qlb.db');
    const store = openStore(dbPath);
    try {
      beginCutover(store, NOW);
      (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db.prepare(
        "INSERT INTO claude_slots (account_id, config_json, fingerprint, dead, added_at) VALUES (?, '{}', ?, 0, ?)",
      ).run('slot-a', FP_A, NOW);

      const recordingStore = Object.create(store) as typeof store;
      recordingStore.close = () => {};
      recordingStore.recordPiExportTargetsIfEmptyClassified = <T extends { targets: PiExportTargetInput[] }>(
        provider: string,
        classifyInTransaction: () => T,
        admit: (db: DatabaseSync) => { ok: boolean; code?: string },
      ) => {
        const writer = new DatabaseSync(dbPath);
        try {
          writer.prepare('UPDATE claude_slots SET fingerprint = ? WHERE account_id = ?').run(FP_B, 'slot-a');
        } finally {
          writer.close();
        }
        return store.recordPiExportTargetsIfEmptyClassified(provider, classifyInTransaction, admit);
      };
      const output: string[] = [];
      const commandContext = context(output);
      commandContext.config = { ...commandContext.config, dbPath };
      assert.equal(runPiPoolInventoryCommand(['--against', 'slots', '--record'], commandContext, {
        openStore: () => recordingStore,
        loadEntries: () => [{ target: 'pool-b', lineageFp: FP_B, expiresAt: null }],
        loadCswapLineages: () => [],
        loadSlotLineages: (opened) => slotInventoryLineages(opened),
        admitRecord: () => ({ ok: true }),
        now: () => NOW,
      }), 0);
      assert.deepEqual(store.listPiExportTargets('anthropic').map((row) => ({ ...row })), [{
        provider: 'anthropic', target: 'pool-b', slotAccountId: 'slot-a', lineageFp: FP_B, recordedAt: NOW, recordedBy: 'pool-inventory',
      }]);
    } finally {
      store.close();
    }
  });

  it('rolls back and refuses a conflicting in-transaction slot classification', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-pool-inventory-'));
    const dbPath = join(dir, 'qlb.db');
    const setup = openStore(dbPath);
    try {
      (setup as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db.prepare(
        "INSERT INTO claude_slots (account_id, config_json, fingerprint, dead, added_at) VALUES (?, '{}', ?, 0, ?)",
      ).run('slot-a', FP_A, NOW);
      (setup as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db.prepare(
        "INSERT INTO claude_slots (account_id, config_json, fingerprint, dead, added_at) VALUES (?, '{}', ?, 0, ?)",
      ).run('slot-b', FP_A, NOW);
    } finally {
      setup.close();
    }

    const output: string[] = [];
    const commandContext = context(output);
    commandContext.config = { ...commandContext.config, dbPath };
    assert.equal(runPiPoolInventoryCommand(['--against', 'slots', '--record'], commandContext, {
      openStore,
      loadEntries: () => [entries[0]!],
      loadCswapLineages: () => [],
      loadSlotLineages: (store) => slotInventoryLineages(store),
      admitRecord: () => ({ ok: true }),
      now: () => NOW,
    }), 3);
    assert.equal(output.at(-1), 'ERR:qlb pi pool-inventory: refused: ambiguous-source-lineage');
    const check = openStore(dbPath);
    try {
      assert.deepEqual(check.listPiExportTargets('anthropic'), []);
    } finally {
      check.close();
    }
  });

  it('invents no partial pool view and includes all strict .lkg lineages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-pool-inventory-'));
    const poolPath = join(dir, 'anthropic-pool.json');
    const lkgPath = join(dir, 'anthropic-pool.lkg.json');
    writeFileSync(poolPath, JSON.stringify({ accounts: [{
      id: 'pool-a', credentials: { access: 'access-a', refresh: 'refresh-a', expires: NOW + 1 },
    }] }));
    writeFileSync(lkgPath, JSON.stringify({ accounts: {
      'pool-a': {
        credential: { type: 'oauth', access: 'access-b', refresh: 'refresh-b', expires: NOW + 1 },
        expectedPredecessor: 'refresh-c', poolGeneration: 1, txId: 'tx', acceptedAt: NOW, source: 'refresher',
        conflict: { kind: 'concurrent_acceptance', status: 'unresolved', preferredTxId: 'tx', candidates: [{
          credential: { type: 'oauth', access: 'access-d', refresh: 'refresh-d', expires: NOW + 1 },
          expectedPredecessor: 'refresh-e', poolGeneration: 1, txId: 'tx-2', acceptedAt: NOW, source: 'refresher',
        }] },
      },
      'legacy-pool': { refresh: 'refresh-f' },
    } }));

    const loaded = readPoolInventoryEntries(poolPath);
    assert.equal(loaded.filter((entry) => entry.target === 'pool-a').length, 5);
    assert.equal(loaded.find((entry) => entry.target === 'legacy-pool') !== undefined, true);
    assert.throws(() => readPoolInventoryEntries(poolPath, () => JSON.stringify({ accounts: [{
      id: 'pool-a', credentials: { refresh: 'refresh-a' },
    }] })), (error: unknown) => error instanceof PoolInventoryError && error.code === 'pool-account-invalid');
  });

  it('treats malformed .lkg input as unavailable rather than omitting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-pool-inventory-'));
    const poolPath = join(dir, 'anthropic-pool.json');
    writeFileSync(poolPath, JSON.stringify({ accounts: [{
      id: 'pool-a', credentials: { access: 'access-a', refresh: 'refresh-a' },
    }] }));
    writeFileSync(join(dir, 'anthropic-pool.lkg.json'), '{');
    assert.throws(() => readPoolInventoryEntries(poolPath), (error: unknown) => error instanceof PoolInventoryError && error.code === 'pool-lkg-invalid');
  });

  it('expands every active slot lineage chain and omits inactive source forms', () => {
    assert.deepEqual(slotInventoryLineages({ listAnthropicSlotLineageChains: () => [{
      accountId: 'slot-a', lineages: [FP_A, FP_B],
    }, {
      accountId: 'slot-ignored', lineages: [`sha256-full:${'d'.repeat(64)}`],
    }] }), [
      { slotAccountId: 'slot-a', lineageFp: FP_A, lineageChain: true },
      { slotAccountId: 'slot-a', lineageFp: FP_B, lineageChain: true },
    ]);
  });

  it('keeps cswap and report-only slots inventory read-only, and records slots only once when admitted', () => {
    const output: string[] = [];
    const replacements: unknown[] = [];
    const store = {
      replacePiExportTargets: (_provider: string, targets: unknown[]) => replacements.push(targets),
      recordPiExportTargetsIfEmpty: (_provider: string, targets: unknown[]) => {
        replacements.push(targets);
        return { ok: true };
      },
      recordPiExportTargetsIfEmptyClassified: <T extends { targets: unknown[] }>(_provider: string, classifyInTransaction: () => T) => {
        const result = classifyInTransaction();
        replacements.push(result.targets);
        return { ok: true as const, result };
      },
      listPiExportTargets: () => [], close: () => {},
      listAnthropicSlotLineages: () => [],
      listAnthropicSlotLineageChains: () => [],
    };
    const deps = {
      openStore: () => store,
      loadEntries: () => entries,
      loadCswapLineages: () => sources,
      loadSlotLineages: () => [{ slotAccountId: 'slot-b', lineageFp: FP_B }],
      admitRecord: () => ({ ok: true }),
      now: () => NOW,
    };
    assert.equal(runPiPoolInventoryCommand(['--against', 'cswap'], context(output), { ...deps, openStore: () => { throw new Error('must not open'); } }), 0);
    assert.equal(runPiPoolInventoryCommand(['--against', 'slots'], context(output), deps), 0);
    assert.equal(replacements.length, 0);
    assert.equal(runPiPoolInventoryCommand(['--against', 'slots', '--record'], context(output), deps), 0);
    assert.equal(replacements.length, 1);
    const existing = { ...deps, openStore: () => ({
      ...store,
      recordPiExportTargetsIfEmpty: () => ({ ok: false, code: 'pi-export-targets-exist' }),
      recordPiExportTargetsIfEmptyClassified: () => ({ ok: false as const, code: 'pi-export-targets-exist' }),
    }) };
    assert.equal(runPiPoolInventoryCommand(['--against', 'slots', '--record'], context(output), existing), 3);
    assert.equal(output.at(-1), 'ERR:qlb pi pool-inventory: refused: pi-export-targets-exist');
    assert.equal(replacements.length, 1);
  });

  it('supports cswap and imported-slot sources through the command without printing a credential value', () => {
    const output: string[] = [];
    const store: PoolInventoryStore = { replacePiExportTargets: () => {} };
    const deps = {
      openStore: () => ({
        ...store,
        recordPiExportTargetsIfEmpty: () => ({ ok: true }),
        recordPiExportTargetsIfEmptyClassified: <T extends { targets: unknown[] }>(_provider: string, classifyInTransaction: () => T) => ({ ok: true as const, result: classifyInTransaction() }),
        close: () => {}, listPiExportTargets: () => [],
        listAnthropicSlotLineageChains: () => [],
      }),
      loadEntries: () => entries,
      loadCswapLineages: () => sources,
      loadSlotLineages: () => [{ slotAccountId: 'slot-b', lineageFp: FP_B }],
      admitRecord: () => ({ ok: true }),
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
