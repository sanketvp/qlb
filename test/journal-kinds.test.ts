import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  KNOWN_STATES,
  NATIVE_RETIREMENT_STORES,
  PI_TRANSFER_STORES,
  SUPPORTED_SCHEMA_VERSIONS,
} from '../src/journal-kinds';
import {
  decodeJournalEvidence,
  isStuckMigration,
} from '../src/migration-health';
import {
  migrationStoreNameFor,
  PI_POOL_STORE,
  SINGLE_GRANT_PROVIDERS,
  STATIC_KEY_PROVIDERS,
} from '../src/migration';
import { RETIRE_HARNESSES } from '../src/retire';
import { openStore } from '../src/store';

describe('journal-kinds drift (T-IMPORT-1)', () => {
  it('PI_TRANSFER_STORES matches writer store names as a set', () => {
    const fromWriters = new Set<string>([
      PI_POOL_STORE,
      ...[...SINGLE_GRANT_PROVIDERS, ...STATIC_KEY_PROVIDERS].map(migrationStoreNameFor),
    ]);
    assert.deepEqual(new Set(PI_TRANSFER_STORES), fromWriters);
  });

  it('NATIVE_RETIREMENT_STORES matches RETIRE_HARNESSES', () => {
    assert.deepEqual([...NATIVE_RETIREMENT_STORES], [...RETIRE_HARNESSES]);
  });

  it('SUPPORTED_SCHEMA_VERSIONS is empty and KNOWN_STATES are closed', () => {
    assert.deepEqual([...SUPPORTED_SCHEMA_VERSIONS], []);
    assert.deepEqual([...KNOWN_STATES], ['NATIVE', 'MIRRORED', 'VALIDATED', 'QLB_OWNED', 'RETIRED']);
  });
});

describe('decodeJournalEvidence', () => {
  it('T-TYPE: absent schemaVersion is legacy trusted; cycleId ignored', () => {
    const ev = decodeJournalEvidence({
      store: 'pi-pool',
      state: 'QLB_OWNED',
      detail_json: JSON.stringify({ qlbAccountIds: ['a'], cycleId: 'x' }),
    });
    assert.equal(ev.trusted, true);
    if (ev.trusted) assert.ok(ev.participants.has('a'));
  });

  it('T-TYPE: unsupported schemaVersion / kind_mismatch / unknown store/state', () => {
    assert.equal(decodeJournalEvidence({
      store: 'pi-pool', state: 'QLB_OWNED', detail_json: JSON.stringify({ qlbAccountIds: ['a'], schemaVersion: 99 }),
    }).trusted, false);
    assert.equal(decodeJournalEvidence({
      store: 'pi-pool', state: 'QLB_OWNED', detail_json: JSON.stringify({ qlbAccountIds: ['a'], schemaVersion: '1' }),
    }).trusted, false);
    assert.equal(decodeJournalEvidence({
      store: 'pi-pool', state: 'QLB_OWNED', detail_json: JSON.stringify({ qlbAccountIds: ['a'], kind: 'native-retirement' }),
    }).trusted, false);
    assert.equal(decodeJournalEvidence({
      store: 'foo', state: 'QLB_OWNED', detail_json: '{"qlbAccountIds":["a"]}',
    }).trusted, false);
    assert.equal(decodeJournalEvidence({
      store: 'pi-pool', state: 'WEIRD', detail_json: '{"qlbAccountIds":["a"]}',
    }).trusted, false);
  });

  it('T-NATIVE: empty metadata trusted and never protects', () => {
    for (const raw of [undefined, null, '', '{}']) {
      const ev = decodeJournalEvidence({ store: 'pi-pool', state: 'NATIVE', detail_json: raw });
      assert.equal(ev.trusted, true, `expected trusted for ${String(raw)}`);
      assert.equal(isStuckMigration({ store: 'pi-pool', state: 'NATIVE', detail_json: raw }), false);
    }
  });

  it('T-NATIVE: malformed / not_object / unsupported version untrusted', () => {
    const malformed = decodeJournalEvidence({ store: 'pi-pool', state: 'NATIVE', detail_json: 'not-json' });
    assert.equal(malformed.trusted, false);
    if (!malformed.trusted) assert.equal(malformed.reason, 'malformed_json');
    const arr = decodeJournalEvidence({ store: 'pi-pool', state: 'NATIVE', detail_json: '[]' });
    assert.equal(arr.trusted, false);
    if (!arr.trusted) assert.equal(arr.reason, 'not_object');
    const jsonNull = decodeJournalEvidence({ store: 'pi-pool', state: 'NATIVE', detail_json: 'null' });
    assert.equal(jsonNull.trusted, false);
    if (!jsonNull.trusted) assert.equal(jsonNull.reason, 'not_object');
    const ver = decodeJournalEvidence({
      store: 'pi-pool',
      state: 'NATIVE',
      detail_json: JSON.stringify({ schemaVersion: 99 }),
    });
    assert.equal(ver.trusted, false);
    if (!ver.trusted) assert.equal(ver.reason, 'unsupported_version');
  });

  it('empty / mismatched / conflicting Pi inventories are untrusted', () => {
    const cases: Array<[string, string]> = [
      [JSON.stringify({ qlbAccountIds: [] }), 'empty_inventory'],
      [JSON.stringify({ accounts: [] }), 'empty_inventory'],
      [JSON.stringify({ qlbAccountIds: ['a'], accounts: [{ id: 'b' }] }), 'inventory_mismatch'],
      [JSON.stringify({ qlbAccountIds: [''] }), 'bad_id'],
      [JSON.stringify({ accounts: [{}] }), 'bad_id'],
      [JSON.stringify({
        accounts: [{ id: 'a', provider: 'xai' }, { id: 'a', provider: 'anthropic' }],
      }), 'provider_conflict'],
      ['not-json', 'malformed_json'],
      ['[]', 'not_object'],
      [null as unknown as string, 'missing_detail'],
    ];
    for (const [detail, reason] of cases) {
      const ev = decodeJournalEvidence({ store: 'pi-pool', state: 'QLB_OWNED', detail_json: detail });
      assert.equal(ev.trusted, false, `expected untrusted for ${String(detail)}`);
      if (!ev.trusted) assert.equal(ev.reason, reason, String(detail));
    }
  });

  it('equal redundant inventories and duplicate same-provider entries are trusted', () => {
    const ev = decodeJournalEvidence({
      store: 'pi-pool',
      state: 'QLB_OWNED',
      detail_json: JSON.stringify({
        qlbAccountIds: ['a', 'b'],
        accounts: [{ id: 'b' }, { id: 'a' }],
      }),
    });
    assert.equal(ev.trusted, true);
    const dup = decodeJournalEvidence({
      store: 'pi-pool',
      state: 'QLB_OWNED',
      detail_json: JSON.stringify({
        qlbAccountIds: ['a', 'a'],
        accounts: [{ id: 'a', provider: 'anthropic' }, { id: 'a', provider: 'anthropic' }],
      }),
    });
    assert.equal(dup.trusted, true);
  });

  it('native-retirement RETIRED valid shape is trusted; MIRRORED is not allowed', () => {
    const fp = createHash('sha256').update('x').digest('hex');
    const ev = decodeJournalEvidence({
      store: 'claude-code',
      state: 'RETIRED',
      detail_json: JSON.stringify({
        retiredAt: 1,
        retiredPath: '/tmp/cc',
        backupPath: '/tmp/cc.pre-qlb',
        sidecarPath: '/tmp/cc.sidecar',
        fingerprint: fp,
      }),
    });
    assert.equal(ev.trusted, true);
    const mirrored = decodeJournalEvidence({
      store: 'claude-code',
      state: 'MIRRORED',
      detail_json: '{}',
    });
    assert.equal(mirrored.trusted, false);
    if (!mirrored.trusted) assert.equal(mirrored.reason, 'state_not_allowed_for_kind');
  });
});

describe('T-IMPORT-2 entry-order', () => {
  it('store/migration/retire/cli produce identical decoder output', () => {
    const root = join(__dirname, '..', '..');
    const support = join(root, 'test', 'support', 'entry-order.cjs');
    const guard = join(root, 'test', 'support', 'guard.cjs');
    const entries: Array<string[]> = [
      [join(root, 'dist', 'store.js')],
      [join(root, 'dist', 'migration.js')],
      [join(root, 'dist', 'retire.js')],
      [join(root, 'dist', 'cli.js'), '--help'],
    ];
    const outputs: string[] = [];
    for (const args of entries) {
      const result = spawnSync(process.execPath, ['--require', guard, support, ...args], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const line = result.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
      assert.ok(line, `no JSON from ${args[0]}: ${result.stdout}`);
      const parsed = JSON.parse(line) as { decoded: unknown; PI_TRANSFER_STORES: unknown };
      outputs.push(JSON.stringify({ decoded: parsed.decoded, PI_TRANSFER_STORES: parsed.PI_TRANSFER_STORES }));
    }
    assert.equal(outputs[1], outputs[0]);
    assert.equal(outputs[2], outputs[0]);
    assert.equal(outputs[3], outputs[0]);
  });
});

describe('T-FS-0 no filesystem in prune decoder', () => {
  it('migration-health, accounts-prune, journal-kinds do not import fs', () => {
    const root = join(__dirname, '..', '..', 'src');
    for (const file of ['migration-health.ts', 'accounts-prune.ts', 'journal-kinds.ts']) {
      const text = readFileSync(join(root, file), 'utf8');
      assert.equal(/statSync|lstatSync|existsSync|node:fs|from '\.\/migration'|from '\.\/retire'|from '\.\/store'|from '\.\/refresh-lease'/.test(text), false, file);
      assert.doesNotMatch(text, /rolledBackFrom/);
    }
  });
});

describe('T-RECOVER marker encoding', () => {
  it('absent marker allows orphan prune; any present string refuses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-recover-'));
    const store = openStore(join(dir, 'qlb.db'));
    store.upsertAccount('orphan', 'anthropic', 'o');
    assert.equal(store.getConfig('migrations.recovery_pending'), null);
    const { pruneAccount, PruneRefusedError } = require('../src/accounts-prune') as typeof import('../src/accounts-prune');
    pruneAccount(store, { accountId: 'orphan', confirm: true });
    store.upsertAccount('other', 'anthropic', 'x');
    for (const value of ['1', '', '0', 'false', 'garbage']) {
      store.setConfig('migrations.recovery_pending', value);
      assert.notEqual(store.getConfig('migrations.recovery_pending'), null);
      assert.throws(
        () => pruneAccount(store, { accountId: 'other', confirm: true }),
        (err: unknown) => err instanceof PruneRefusedError && /recovery_pending/.test((err as Error).message),
      );
      assert.ok(store.getAccount('other'));
    }
    store.close();
  });
});
