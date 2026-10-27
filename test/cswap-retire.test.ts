import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { credentialFingerprint } from '../src/anthropic-oauth';
import { runRetireCswapCommand, productionDependencies, s64DoctorVerdict } from '../src/commands/retire-cswap';
import { evaluateRetirementGates, retireCswap, type CswapRetireDependencies, type CswapRetireItem } from '../src/cswap-retire';
import piRollback, { executePiRollback } from '../src/commands/pi-rollback';
import { defaultConfig } from '../src/config';
import { qlbHomeDir } from '../src/home';
import { listUnclaimedKeychainServices, platformKeychain } from '../src/keychain';
import { assertAdmitted, beginCutover, beginRetirementFence, phase } from '../src/lifecycle';
import { defaultPiMigratePaths } from '../src/pi-migrate';
import { openStore } from '../src/store';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 20 * DAY_MS;
const PROVIDERS = ['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter'];

type Fixture = ReturnType<typeof fixture>;

function fixture(): {
  root: string;
  store: ReturnType<typeof openStore>;
  deps: CswapRetireDependencies;
  calls: string[];
  deleteCalls: CswapRetireItem[][];
  setCswapItems(items: CswapRetireItem[]): void;
  getCswapItems(): CswapRetireItem[];
  beforeDeleteCswapItems(action: () => void): void;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'qlb-cswap-retire-'));
  const store = openStore(join(root, 'qlb.db'));
  beginCutover(store, 1);
  const row = phase(store);
  const db = new DatabaseSync(store.dbPath);
  try {
    db.prepare("UPDATE lifecycle SET state = 'cutover', cutover_at = ?, window_end = ?, drill_done_at = ? WHERE id = ?")
      .run(1, NOW - 1, NOW - 2, row.id);
    const receipt = db.prepare("INSERT INTO health_log (ts, phase, overall, failing_json, dead_slots_json) VALUES (?, 'report', 'PASS', '[]', '[]')").run(NOW - 1);
    store.setConfig('report.receiptHealthLogId', String(receipt.lastInsertRowid));
  } finally { db.close(); }
  store.setConfig('report.receiptAt', String(NOW - 1));
  store.setConfig('codex.l13VerifiedAt', '1');
  for (const provider of PROVIDERS) {
    store.setConfig(`pi.${provider}.state`, 'migrated');
    store.setConfig(`pi.${provider}.lastServedAt`, String(NOW - 1));
  }
  store.recordLineage({ provider: 'anthropic', accountId: 'slot-a', fromFp: 'source-a', toFp: 'current-a', cause: 'post', by: 'qlb' });

  const calls: string[] = [];
  const deleteCalls: CswapRetireItem[][] = [];
  let currentCswapItems: CswapRetireItem[] = [{ id: 'cswap-a', fingerprint: 'source-a' }];
  let beforeDelete: (() => void) | undefined;
  const deps: CswapRetireDependencies = {
    now: () => NOW,
    stateDir: root,
    backupsDir: join(root, 'retirement-backups'),
    journalDir: join(root, 'journal'),
    doctor: async () => ({ overall: 'PASS', autoAgent: 'PASS' }),
    reportReceiptPasses: () => true,
    hasFourInjectedDrillRows: () => true,
    hasUnadoptedStash: () => false,
    claudeSlotsPass: () => true,
    slots: () => [{ accountId: 'slot-a', source: 'cswap-import', sourceFingerprint: 'source-a', currentFingerprint: 'current-a' }],
    cswapItems: () => currentCswapItems,
    readSlotFingerprint: async () => 'current-a',
    effects: {
      drainCswap: () => { calls.push('drain-cswap'); return { ok: true }; },
      archiveCswap: (path) => { calls.push(`archive:${path}`); },
      // The future production adapter must provide this compare-and-delete
      // behavior: missing captured items are already deleted, but a captured
      // id with a different current fingerprint refuses the effect.
      deleteCswapItems: (items) => {
        beforeDelete?.();
        const captured = new Map(items.map((item) => [item.id, item.fingerprint]));
        if (currentCswapItems.some((item) => {
          const expected = captured.get(item.id);
          return expected !== undefined && expected !== item.fingerprint;
        })) throw new Error('captured C-swap item fingerprint changed');
        currentCswapItems = currentCswapItems.filter((item) => captured.get(item.id) !== item.fingerprint);
        deleteCalls.push(items);
        calls.push('delete-cswap-items');
      },
      uninstallCswap: () => { calls.push('uninstall-cswap'); },
      removeCswapLaunchArtifacts: () => { calls.push('remove-launch-artifacts'); },
      deletePiBaselines: () => { calls.push('delete-pi-baselines'); },
      archiveExpiredStash: (path) => { calls.push(`archive-stash:${path}`); },
    },
  };
  return {
    root,
    store,
    deps,
    calls,
    deleteCalls,
    setCswapItems: (items) => { currentCswapItems = items; },
    getCswapItems: () => currentCswapItems,
    beforeDeleteCswapItems: (action) => { beforeDelete = action; },
    cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

async function refusal(name: string, mutate: (f: Fixture) => void, expected: string): Promise<void> {
  const f = fixture();
  try {
    mutate(f);
    const result = await evaluateRetirementGates(f.store, f.deps);
    assert.deepEqual(result, { ok: false, code: expected }, name);
    assert.equal(phase(f.store).note, null, `${name} must not install a fence`);
    assert.equal(existsSync(f.deps.journalDir), false, `${name} must not create a journal directory`);
    assert.equal(existsSync(f.deps.backupsDir), false, `${name} must not create a backup directory`);
  } finally { f.cleanup(); }
}

describe('qlb retire cswap (AC22 retire)', () => {
  it('refuses each retirement bar and writes nothing', async () => {
    await refusal('lifecycle admission', (f) => {
      const db = new DatabaseSync(f.store.dbPath);
      try { db.prepare("UPDATE lifecycle SET state = 'pre-cutover'").run(); } finally { db.close(); }
    }, 'phase=pre-cutover');
    await refusal('receipt missing', (f) => f.store.setConfig('report.receiptAt', ''), 'report-receipt-missing');
    await refusal('report did not pass', (f) => { f.deps.reportReceiptPasses = () => false; }, 'report-not-pass');
    await refusal('doctor overall', (f) => { f.deps.doctor = async () => ({ overall: 'FAIL', autoAgent: 'PASS' }); }, 'doctor-not-pass');
    await refusal('auto agent', (f) => { f.deps.doctor = async () => ({ overall: 'PASS', autoAgent: 'FAIL' }); }, 'doctor-auto-agent-not-pass');
    await refusal('fresh Pi use', (f) => f.store.setConfig('pi.kimi-coding.lastServedAt', String(NOW - DAY_MS - 1)), 'pi-last-served-stale:kimi-coding');
    await refusal('health failure after receipt pass', (f) => {
      const db = new DatabaseSync(f.store.dbPath);
      try { db.prepare("INSERT INTO health_log (ts, phase, overall, failing_json, dead_slots_json) VALUES (?, 'doctor', 'FAIL', '[]', '[]')").run(NOW - 1); } finally { db.close(); }
    }, 'health-log-fail-after-pass');
    await refusal('window still active', (f) => {
      const db = new DatabaseSync(f.store.dbPath);
      try { db.prepare('UPDATE lifecycle SET window_end = ?').run(NOW + 1); } finally { db.close(); }
    }, 'window-not-ended');
    await refusal('rollback recorded', (f) => {
      const db = new DatabaseSync(f.store.dbPath);
      try { db.prepare('UPDATE lifecycle SET rollback_at = 1').run(); } finally { db.close(); }
    }, 'rollback-recorded');
    await refusal('Pi migration missing', (f) => f.store.setConfig('pi.kimi-coding.state', 'pending'), 'pi-state-invalid:kimi-coding');
    await refusal('drill missing', (f) => {
      const db = new DatabaseSync(f.store.dbPath);
      try { db.prepare('UPDATE lifecycle SET drill_done_at = NULL').run(); } finally { db.close(); }
    }, 'drill-not-recorded');
    await refusal('drill rows missing', (f) => { f.deps.hasFourInjectedDrillRows = () => false; }, 'drill-rows-missing');
    await refusal('l13 missing', (f) => f.store.setConfig('codex.l13VerifiedAt', ''), 'codex-l13-missing');
    await refusal('unadopted stash', (f) => { f.deps.hasUnadoptedStash = () => true; }, 'unadopted-stash');
    await refusal('unadopted stash unavailable', (f) => { f.deps.hasUnadoptedStash = () => { throw new Error('fixture read failure'); }; }, 'unadopted-stash-unavailable');
    await refusal('slot check failed', (f) => { f.deps.claudeSlotsPass = () => false; }, 'claude-slots-not-pass');
    await refusal('no Claude slots', (f) => { f.deps.slots = () => []; }, 'claude-slots-empty');
    await refusal('fresh credential read failed', (f) => { f.deps.readSlotFingerprint = async () => { throw new Error('fixture read failure'); }; }, 'slot-read-failed:slot-a');
    await refusal('fresh credential changed', (f) => { f.deps.readSlotFingerprint = async () => 'other'; }, 'slot-lineage-mismatch:slot-a');
    await refusal('unmapped C-swap item', (f) => { f.deps.cswapItems = () => [{ id: 'orphan-cswap', fingerprint: 'orphan' }]; }, 'cswap-item-unmapped:orphan-cswap');
    await refusal('unprovable source lineage', (f) => {
      f.deps.slots = () => [{ accountId: 'slot-a', source: 'cswap-import', sourceFingerprint: 'unrelated', currentFingerprint: 'current-a' }];
    }, 'slot-lineage-unprovable:slot-a');
    await refusal('receipt stale', (f) => f.store.setConfig('report.receiptAt', String(NOW - 10 * 60 * 1000 - 1)), 'report-receipt-stale');
  });

  it('pi rollback proceeds in pre-cutover and refuses only under retirement or cutover-begin fences', async () => {
    const f = fixture();
    try {
      const db = new DatabaseSync(f.store.dbPath);
      try { db.prepare("UPDATE lifecycle SET state = 'pre-cutover'").run(); } finally { db.close(); }
      const output: string[] = [];
      let rollbacks = 0;
      const context = {
        stdout: (message: string) => output.push(message), stderr: () => {},
        env: { QLB_TEST_MODE: '1', QLB_HOME: f.root }, home: f.root,
        config: { dbPath: f.store.dbPath }, loadConfig: () => ({ dbPath: f.store.dbPath }),
        registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
      } as never;
      assert.equal(await executePiRollback(['xai'], context, { rollback: () => {
        rollbacks++;
        return { provider: 'xai', state: 'migrated', resumed: false, wouldWrite: [] };
      } }), 0);
      assert.equal(rollbacks, 1);
      assert.deepEqual(output, ['xai: rolled back']);

      const errors: string[] = [];
      assert.equal(beginRetirementFence(f.store).ok, false, 'pre-cutover cannot have a fence');
      const fenced = fixture();
      try {
        assert.equal(beginRetirementFence(fenced.store).ok, true);
        const code = await piRollback.execute!(['xai'], {
          stdout: () => {}, stderr: (message: string) => errors.push(message),
          env: { QLB_TEST_MODE: '1', QLB_HOME: fenced.root }, home: fenced.root,
          config: { dbPath: fenced.store.dbPath }, loadConfig: () => ({ dbPath: fenced.store.dbPath }),
          registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
        } as never);
        assert.equal(code, 3);
        assert.match(errors.join('\n'), /retirement-in-progress/);
      } finally { fenced.cleanup(); }

      const cutoverBeginning = fixture();
      try {
        const beginningErrors: string[] = [];
        const db = new DatabaseSync(cutoverBeginning.store.dbPath);
        try { db.prepare('UPDATE lifecycle SET note = ?').run('cutover-begin-in-progress'); } finally { db.close(); }
        const code = await executePiRollback(['xai'], {
          stdout: () => {}, stderr: (message: string) => beginningErrors.push(message),
          env: { QLB_TEST_MODE: '1', QLB_HOME: cutoverBeginning.root }, home: cutoverBeginning.root,
          config: { dbPath: cutoverBeginning.store.dbPath }, loadConfig: () => ({ dbPath: cutoverBeginning.store.dbPath }),
          registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
        } as never, { rollback: () => assert.fail('rollback must not run during cutover begin') });
        assert.equal(code, 3);
        assert.match(beginningErrors.join('\n'), /cutover-begin-in-progress/);
      } finally { cutoverBeginning.cleanup(); }
    } finally { f.cleanup(); }
  });

  it('pi rollback rechecks retirement and cutover-begin fences installed after its outer check', async () => {
    const f = fixture();
    try {
      const errors: string[] = [];
      const context = {
        stdout: () => {}, stderr: (message: string) => errors.push(message),
        env: { QLB_TEST_MODE: '1', QLB_HOME: f.root }, home: f.root,
        config: { dbPath: f.store.dbPath }, loadConfig: () => ({ dbPath: f.store.dbPath }),
        registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
      } as never;
      const code = await executePiRollback(['xai'], context, {
        rollback: () => assert.fail('rollback must not run after a fence is installed'),
        beforeLock: () => assert.equal(beginRetirementFence(f.store).ok, true),
      });
      assert.equal(code, 3);
      assert.match(errors.join('\n'), /retirement-in-progress/);

      const cutoverBeginning = fixture();
      try {
        const beginningErrors: string[] = [];
        const beginningContext = {
          stdout: () => {}, stderr: (message: string) => beginningErrors.push(message),
          env: { QLB_TEST_MODE: '1', QLB_HOME: cutoverBeginning.root }, home: cutoverBeginning.root,
          config: { dbPath: cutoverBeginning.store.dbPath }, loadConfig: () => ({ dbPath: cutoverBeginning.store.dbPath }),
          registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
        } as never;
        const beginningCode = await executePiRollback(['xai'], beginningContext, {
          rollback: () => assert.fail('rollback must not run after cutover begin starts'),
          beforeLock: () => {
            const db = new DatabaseSync(cutoverBeginning.store.dbPath);
            try { db.prepare('UPDATE lifecycle SET note = ?').run('cutover-begin-in-progress'); } finally { db.close(); }
          },
        });
        assert.equal(beginningCode, 3);
        assert.match(beginningErrors.join('\n'), /cutover-begin-in-progress/);
      } finally { cutoverBeginning.cleanup(); }
    } finally { f.cleanup(); }
  });

  it('maps C-swap items only when the fresh QLB slot represents them', async () => {
    const f = fixture();
    try {
      f.store.recordLineage({ provider: 'anthropic', accountId: 'slot-a', fromFp: 'source-a', toFp: 'cswap-sibling', cause: 'post', by: 'cswap' });
      f.deps.cswapItems = () => [{ id: 'cswap-sibling', fingerprint: 'cswap-sibling' }];
      assert.deepEqual(await evaluateRetirementGates(f.store, f.deps), {
        ok: false,
        code: 'cswap-item-unmapped:cswap-sibling',
      });

      f.deps.cswapItems = () => [{ id: 'cswap-current', fingerprint: 'current-a' }];
      assert.equal((await evaluateRetirementGates(f.store, f.deps)).ok, true);

      f.deps.cswapItems = () => [{ id: 'cswap-ancestor', fingerprint: 'source-a' }];
      assert.equal((await evaluateRetirementGates(f.store, f.deps)).ok, true);
    } finally { f.cleanup(); }
  });

  it('allows qlb-add slots but never maps a C-swap item to one', async () => {
    const f = fixture();
    try {
      f.deps.slots = () => [{ accountId: 'slot-a', source: 'qlb-add', sourceFingerprint: null, currentFingerprint: 'current-a' }];
      f.deps.cswapItems = () => [];
      assert.equal((await evaluateRetirementGates(f.store, f.deps)).ok, true);
      f.deps.cswapItems = () => [{ id: 'cswap-a', fingerprint: 'current-a' }];
      assert.deepEqual(await evaluateRetirementGates(f.store, f.deps), { ok: false, code: 'cswap-item-unmapped:cswap-a' });
    } finally { f.cleanup(); }
  });

  it('returns a gate record with the captured slot and item fingerprints and the destructive clock', async () => {
    const f = fixture();
    try {
      const result = await evaluateRetirementGates(f.store, f.deps);
      assert.deepEqual(result, {
        ok: true,
        gates: {
          checkedAt: NOW,
          receiptAt: NOW - 1,
          slots: [{ accountId: 'slot-a', fingerprint: 'current-a' }],
          cswapItems: [{ id: 'cswap-a', fingerprint: 'source-a' }],
        },
      });
      assert.equal(phase(f.store).note, null);
      assert.equal(existsSync(f.deps.journalDir), false);
      assert.equal(existsSync(f.deps.backupsDir), false);
    } finally { f.cleanup(); }
  });

  it('a gate refusal on the first run leaves no journal and no fence', async () => {
    const f = fixture();
    try {
      const db = new DatabaseSync(f.store.dbPath);
      try { db.prepare('UPDATE lifecycle SET window_end = ?').run(NOW + 1); } finally { db.close(); }
      assert.deepEqual(await retireCswap(f.store, f.deps), { ok: false, code: 'window-not-ended' });
      assert.equal(existsSync(join(f.deps.journalDir, 'retire-cswap.json')), false);
      assert.equal(phase(f.store).note, null);
      assert.equal(assertAdmitted(f.store, 'undo-cswap').ok, true);
      assert.equal(assertAdmitted(f.store, 'pi-rollback').ok, true);
    } finally { f.cleanup(); }
  });

  it('drains C-swap before the archive and takes the final inventory after the drain', async () => {
    const f = fixture();
    try {
      const timeline: string[] = [];
      f.deps.cswapItems = () => {
        timeline.push('inventory');
        return f.getCswapItems();
      };
      f.deps.effects.drainCswap = () => { timeline.push('drain-cswap'); return { ok: true }; };
      f.deps.effects.archiveCswap = () => { timeline.push('archive'); };
      assert.equal((await retireCswap(f.store, f.deps)).ok, true);
      assert.deepEqual(timeline.slice(0, 3), ['inventory', 'drain-cswap', 'inventory']);
      assert.ok(timeline.indexOf('archive') > timeline.indexOf('inventory', 1));
    } finally { f.cleanup(); }
  });

  it('an item changed between the gate check and the drain refuses cswap-items-changed and keeps journal and fence', async () => {
    const f = fixture();
    try {
      f.deps.effects.drainCswap = () => {
        f.calls.push('drain-cswap');
        f.setCswapItems([{ id: 'cswap-a', fingerprint: 'rotated-fingerprint' }]);
        return { ok: true };
      };
      assert.deepEqual(await retireCswap(f.store, f.deps), { ok: false, code: 'cswap-items-changed' });
      assert.equal(f.calls.some((call) => call.startsWith('archive:')), false);
      assert.equal(existsSync(join(f.deps.journalDir, 'retire-cswap.json')), true);
      assert.equal(phase(f.store).note, 'retirement-in-progress');
    } finally { f.cleanup(); }
  });

  it('an item added after the drain is impossible (drain fake refuses writes)', async () => {
    const f = fixture();
    try {
      let acceptsWrites = true;
      const writeItem = () => {
        if (!acceptsWrites) return false;
        f.setCswapItems([...f.getCswapItems(), { id: 'new-item', fingerprint: 'new-fingerprint' }]);
        return true;
      };
      f.deps.effects.drainCswap = () => {
        acceptsWrites = false;
        f.calls.push('drain-cswap');
        return { ok: true };
      };
      f.deps.effects.archiveCswap = () => {
        assert.equal(writeItem(), false);
        assert.deepEqual(f.getCswapItems(), [{ id: 'cswap-a', fingerprint: 'source-a' }]);
        f.calls.push('archive');
      };
      assert.equal((await retireCswap(f.store, f.deps)).ok, true);
      assert.deepEqual(f.getCswapItems(), []);
    } finally { f.cleanup(); }
  });

  it('a resume after the drain checkpoint re-drains before the archive', async () => {
    const f = fixture();
    try {
      let drainCalls = 0;
      let crash = true;
      f.deps.effects.drainCswap = () => { drainCalls++; return { ok: true }; };
      f.deps.afterCheckpoint = (name) => {
        if (crash && name === 'drain-cswap') { crash = false; throw new Error('fixture crash'); }
      };
      await assert.rejects(retireCswap(f.store, f.deps), /fixture crash/);
      f.deps.effects.archiveCswap = () => {
        assert.equal(drainCalls, 2);
        f.calls.push('archive');
      };
      assert.equal((await retireCswap(f.store, f.deps)).ok, true);
    } finally { f.cleanup(); }
  });

  it('a C-swap that came back before resume is re-stopped and its new item refuses cswap-items-changed', async () => {
    const f = fixture();
    try {
      let drainCalls = 0;
      let acceptsWrites = true;
      let crash = true;
      const writeItem = () => {
        if (!acceptsWrites) return false;
        f.setCswapItems([...f.getCswapItems(), { id: 'new-item', fingerprint: 'new-fingerprint' }]);
        return true;
      };
      f.deps.effects.drainCswap = () => {
        drainCalls++;
        acceptsWrites = false;
        return { ok: true };
      };
      f.deps.afterCheckpoint = (name) => {
        if (crash && name === 'drain-cswap') { crash = false; throw new Error('fixture crash'); }
      };
      await assert.rejects(retireCswap(f.store, f.deps), /fixture crash/);
      acceptsWrites = true;
      assert.equal(writeItem(), true, 'the rebooted fake C-swap accepts its new item before resume');
      assert.deepEqual(await retireCswap(f.store, f.deps), { ok: false, code: 'cswap-items-changed' });
      assert.equal(drainCalls, 2);
      assert.equal(acceptsWrites, false, 'resume drain stops the restarted fake C-swap');
      assert.equal(f.calls.some((call) => call.startsWith('archive:')), false);
    } finally { f.cleanup(); }
  });

  it('journals each effect, fences unsafe admissions, and resumes exactly once after every checkpoint', async () => {
    const phases = ['drain-cswap', 'archive', 'delete-cswap-items', 'uninstall-cswap', 'remove-launch-artifacts', 'delete-pi-baselines', 'archive-stash', 'committed'] as const;
    for (const crashAt of phases) {
      const f = fixture();
      try {
        let crash = true;
        f.deps.afterCheckpoint = (name) => {
          if (crash && name === crashAt) { crash = false; throw new Error('fixture crash'); }
        };
        await assert.rejects(retireCswap(f.store, f.deps), /fixture crash/);
        const journal = JSON.parse(readFileSync(join(f.deps.journalDir, 'retire-cswap.json'), 'utf8')) as { phase: string };
        assert.equal(journal.phase, crashAt);
        assert.equal(assertAdmitted(f.store, 'undo-cswap').code, 'retirement-in-progress');
        assert.equal(assertAdmitted(f.store, 'pi-rollback').code, 'retirement-in-progress');
        assert.equal((await retireCswap(f.store, f.deps)).ok, true, crashAt);
        const reDrainPhases = ['drain-cswap', 'archive', 'delete-cswap-items', 'uninstall-cswap'];
        assert.equal(f.calls.filter((call) => call === 'drain-cswap').length, reDrainPhases.includes(crashAt) ? 2 : 1, crashAt);
        assert.equal(phase(f.store).state, 'retired');
        assert.equal(existsSync(join(f.deps.journalDir, 'retire-cswap.json')), false);
        for (const effect of ['delete-cswap-items', 'uninstall-cswap', 'remove-launch-artifacts', 'delete-pi-baselines']) {
          assert.equal(f.calls.filter((call) => call === effect).length, 1, `${crashAt}: ${effect}`);
        }
      } finally { f.cleanup(); }
    }
  });

  it('fsyncs the journal dir parent on every journal write', async () => {
    const f = fixture();
    try {
      const durableDirs: string[] = [];
      const durablePhases: string[] = [];
      f.deps.fsyncJournalDir = (dir) => {
        durableDirs.push(dir);
        const path = join(dir, 'retire-cswap.json');
        if (existsSync(path)) durablePhases.push((JSON.parse(readFileSync(path, 'utf8')) as { phase: string }).phase);
      };
      assert.equal((await retireCswap(f.store, f.deps)).ok, true);
      assert.deepEqual(durableDirs, Array(9).fill([f.deps.journalDir, f.root]).flat());
      assert.deepEqual(durablePhases, [
        'started', 'drain-cswap', 'archive', 'delete-cswap-items', 'uninstall-cswap',
        'remove-launch-artifacts', 'delete-pi-baselines', 'archive-stash', 'committed',
      ]);
    } finally { f.cleanup(); }
  });

  it('replays each idempotent effect once after a crash before its checkpoint', async () => {
    const phases = ['drain-cswap', 'archive', 'delete-cswap-items', 'uninstall-cswap', 'remove-launch-artifacts', 'delete-pi-baselines', 'archive-stash'] as const;
    for (const crashAt of phases) {
      const f = fixture();
      try {
        const completed = new Set<string>();
        const archived = new Map<string, string>();
        let currentItems: CswapRetireItem[] = [{ id: 'cswap-a', fingerprint: 'source-a' }];
        f.deps.cswapItems = () => currentItems;
        f.deps.effects = {
          drainCswap: () => { f.calls.push('drain-cswap'); return { ok: true }; },
          archiveCswap: (path) => { f.calls.push('archive'); archived.set(path, 'cswap'); },
          deleteCswapItems: (items) => {
            f.calls.push('delete-cswap-items');
            const captured = new Set(items.map((item) => `${item.id}\u0000${item.fingerprint}`));
            currentItems = currentItems.filter((item) => !captured.has(`${item.id}\u0000${item.fingerprint}`));
          },
          uninstallCswap: () => { f.calls.push('uninstall-cswap'); completed.add('uninstall-cswap'); },
          removeCswapLaunchArtifacts: () => { f.calls.push('remove-launch-artifacts'); completed.add('remove-launch-artifacts'); },
          deletePiBaselines: () => { f.calls.push('delete-pi-baselines'); completed.add('delete-pi-baselines'); },
          archiveExpiredStash: (path) => { f.calls.push('archive-stash'); archived.set(`${path}:stash`, 'stash'); },
        };
        let crash = true;
        f.deps.afterEffect = (name) => {
          if (crash && name === crashAt) { crash = false; throw new Error('effect checkpoint crash'); }
        };
        await assert.rejects(retireCswap(f.store, f.deps), /effect checkpoint crash/, crashAt);
        const beforeResume = f.calls.filter((call) => call === crashAt).length;
        assert.equal((await retireCswap(f.store, f.deps)).ok, true, crashAt);
        assert.equal(f.calls.filter((call) => call === crashAt).length, beforeResume + 1, `${crashAt} replayed once`);
        assert.equal(phase(f.store).state, 'retired');
        assert.equal(phase(f.store).note, null);
        assert.equal(existsSync(join(f.deps.journalDir, 'retire-cswap.json')), false);
        assert.equal(currentItems.length, 0);
        assert.equal(archived.size, 2);
        assert.equal(completed.size, 3, `${crashAt} completes every non-archive effect`);
      } finally { f.cleanup(); }
    }
  });

  it('refuses C-swap items that appear after archive and deletes only the captured items', async () => {
    const f = fixture();
    try {
      const captured = [{ id: 'cswap-a', fingerprint: 'source-a' }];
      f.deps.effects.archiveCswap = () => {
        f.calls.push('archive');
        f.deps.cswapItems = () => [...captured, { id: 'new-item', fingerprint: 'new-fingerprint' }];
      };
      assert.deepEqual(await retireCswap(f.store, f.deps), { ok: false, code: 'cswap-items-changed' });
      assert.deepEqual(f.deleteCalls, []);
      assert.equal(existsSync(join(f.deps.journalDir, 'retire-cswap.json')), true);
      assert.equal(phase(f.store).note, 'retirement-in-progress');
    } finally { f.cleanup(); }

    const capturedOnly = fixture();
    try {
      assert.equal((await retireCswap(capturedOnly.store, capturedOnly.deps)).ok, true);
      assert.deepEqual(capturedOnly.deleteCalls, [[{ id: 'cswap-a', fingerprint: 'source-a' }]]);
    } finally { capturedOnly.cleanup(); }
  });

  it('refuses new C-swap items after the delete checkpoint before later C-swap effects', async () => {
    const f = fixture();
    try {
      f.deps.afterCheckpoint = (name) => {
        if (name === 'delete-cswap-items') f.setCswapItems([{ id: 'new-item', fingerprint: 'new-fingerprint' }]);
      };
      assert.deepEqual(await retireCswap(f.store, f.deps), { ok: false, code: 'cswap-items-changed' });
      assert.equal(f.calls.includes('uninstall-cswap'), false);
      assert.equal(existsSync(join(f.deps.journalDir, 'retire-cswap.json')), true);
      assert.equal(phase(f.store).note, 'retirement-in-progress');
    } finally { f.cleanup(); }

    const resumed = fixture();
    try {
      let crash = true;
      resumed.deps.afterCheckpoint = (name) => {
        if (name === 'delete-cswap-items' && crash) {
          crash = false;
          resumed.setCswapItems([{ id: 'new-item', fingerprint: 'new-fingerprint' }]);
          throw new Error('fixture crash');
        }
      };
      await assert.rejects(retireCswap(resumed.store, resumed.deps), /fixture crash/);
      assert.deepEqual(await retireCswap(resumed.store, resumed.deps), { ok: false, code: 'cswap-items-changed' });
      assert.equal(resumed.calls.includes('uninstall-cswap'), false);
      assert.equal(existsSync(join(resumed.deps.journalDir, 'retire-cswap.json')), true);
      assert.equal(phase(resumed.store).note, 'retirement-in-progress');
    } finally { resumed.cleanup(); }
  });

  it('cswapItems returning [] after uninstall completes retirement', async () => {
    const f = fixture();
    try {
      let uninstalled = false;
      f.deps.effects.uninstallCswap = () => { uninstalled = true; f.calls.push('uninstall-cswap'); };
      f.deps.cswapItems = () => uninstalled ? [] : f.getCswapItems();
      assert.equal((await retireCswap(f.store, f.deps)).ok, true);
      assert.equal(f.calls.includes('remove-launch-artifacts'), true);
    } finally { f.cleanup(); }
  });

  it('a captured item reappearing after delete refuses cswap-items-changed', async () => {
    const f = fixture();
    try {
      f.deps.afterCheckpoint = (name) => {
        if (name === 'delete-cswap-items') f.setCswapItems([{ id: 'cswap-a', fingerprint: 'source-a' }]);
      };
      assert.deepEqual(await retireCswap(f.store, f.deps), { ok: false, code: 'cswap-items-changed' });
      assert.equal(f.calls.includes('uninstall-cswap'), false);
      assert.equal(existsSync(join(f.deps.journalDir, 'retire-cswap.json')), true);
      assert.equal(phase(f.store).note, 'retirement-in-progress');
    } finally { f.cleanup(); }
  });

  it('keeps the journal and fence when a captured item changes after the recheck', async () => {
    const f = fixture();
    try {
      f.beforeDeleteCswapItems(() => f.setCswapItems([{ id: 'cswap-a', fingerprint: 'rewritten-fingerprint' }]));
      assert.deepEqual(await retireCswap(f.store, f.deps), { ok: false, code: 'retirement-effect-failed:delete-cswap-items' });
      assert.deepEqual(f.getCswapItems(), [{ id: 'cswap-a', fingerprint: 'rewritten-fingerprint' }]);
      assert.equal(existsSync(join(f.deps.journalDir, 'retire-cswap.json')), true);
      assert.equal(phase(f.store).note, 'retirement-in-progress');
    } finally { f.cleanup(); }
  });

  it('resumes after a stale receipt without rerunning time-based gates', async () => {
    const f = fixture();
    try {
      let crash = true;
      f.deps.afterCheckpoint = (name) => {
        if (crash && name === 'archive') { crash = false; throw new Error('fixture crash'); }
      };
      await assert.rejects(retireCswap(f.store, f.deps), /fixture crash/);
      f.deps.now = () => NOW + 2 * DAY_MS;
      f.deps.doctor = async () => ({ overall: 'FAIL', autoAgent: 'FAIL' });
      f.store.setConfig('pi.anthropic.lastServedAt', String(NOW - DAY_MS - 1));
      assert.equal((await retireCswap(f.store, f.deps)).ok, true);
    } finally { f.cleanup(); }
  });

  it('resume accepts a lineage successor of the captured slot fingerprint', async () => {
    const f = fixture();
    try {
      let crash = true;
      f.deps.afterCheckpoint = (name) => {
        if (crash && name === 'archive') { crash = false; throw new Error('fixture crash'); }
      };
      await assert.rejects(retireCswap(f.store, f.deps), /fixture crash/);
      f.store.recordLineage({ provider: 'anthropic', accountId: 'slot-a', fromFp: 'current-a', toFp: 'rotated-a', cause: 'post', by: 'qlb' });
      f.deps.readSlotFingerprint = () => 'rotated-a';
      assert.equal((await retireCswap(f.store, f.deps)).ok, true);
    } finally { f.cleanup(); }
  });

  it('resume refuses an unrelated fingerprint with slot-lineage-mismatch', async () => {
    const f = fixture();
    try {
      let crash = true;
      f.deps.afterCheckpoint = (name) => {
        if (crash && name === 'archive') { crash = false; throw new Error('fixture crash'); }
      };
      await assert.rejects(retireCswap(f.store, f.deps), /fixture crash/);
      f.deps.readSlotFingerprint = () => 'unrelated';
      assert.deepEqual(await retireCswap(f.store, f.deps), { ok: false, code: 'slot-lineage-mismatch:slot-a' });
    } finally { f.cleanup(); }
  });

  it('accepts already-deleted journal items but refuses newly appearing C-swap items on resume', async () => {
    const f = fixture();
    try {
      let crash = true;
      f.deps.afterCheckpoint = (name) => {
        if (crash && name === 'archive') { crash = false; throw new Error('fixture crash'); }
      };
      await assert.rejects(retireCswap(f.store, f.deps), /fixture crash/);
      f.deps.cswapItems = () => [];
      assert.equal((await retireCswap(f.store, f.deps)).ok, true);
    } finally { f.cleanup(); }

    const changed = fixture();
    try {
      let crash = true;
      changed.deps.afterCheckpoint = (name) => {
        if (crash && name === 'archive') { crash = false; throw new Error('fixture crash'); }
      };
      await assert.rejects(retireCswap(changed.store, changed.deps), /fixture crash/);
      changed.deps.cswapItems = () => [{ id: 'new-item', fingerprint: 'new-fingerprint' }];
      assert.deepEqual(await retireCswap(changed.store, changed.deps), { ok: false, code: 'cswap-items-changed' });
    } finally { changed.cleanup(); }
  });

  it('finishes a crash after retired transition before the committed checkpoint', async () => {
    const f = fixture();
    try {
      let crash = true;
      f.deps.afterTransition = () => {
        if (crash) { crash = false; throw new Error('transition crash'); }
      };
      await assert.rejects(retireCswap(f.store, f.deps), /transition crash/);
      assert.equal(phase(f.store).state, 'retired');
      assert.equal((await retireCswap(f.store, f.deps)).ok, true);
      assert.equal(phase(f.store).note, null);
      assert.equal(existsSync(join(f.deps.journalDir, 'retire-cswap.json')), false);
    } finally { f.cleanup(); }
  });

  it('a journal without a fence is resumed and the fence is installed first', async () => {
    const f = fixture();
    try {
      let crash = true;
      f.deps.afterCheckpoint = (name) => {
        if (crash && name === 'archive') { crash = false; throw new Error('fixture crash'); }
      };
      await assert.rejects(retireCswap(f.store, f.deps), /fixture crash/);
      const db = new DatabaseSync(f.store.dbPath);
      try { db.prepare('UPDATE lifecycle SET note = NULL').run(); } finally { db.close(); }
      assert.equal(phase(f.store).note, null);
      f.deps.afterCheckpoint = undefined;
      f.deps.readSlotFingerprint = () => {
        assert.equal(phase(f.store).note, 'retirement-in-progress');
        return 'current-a';
      };
      assert.equal((await retireCswap(f.store, f.deps)).ok, true);
      assert.equal(phase(f.store).state, 'retired');
    } finally { f.cleanup(); }
  });

  it('an effect failure keeps the journal and the fence', async () => {
    const f = fixture();
    try {
      f.deps.effects.uninstallCswap = () => { throw new Error('fake effect failure'); };
      assert.deepEqual(await retireCswap(f.store, f.deps), { ok: false, code: 'retirement-effect-failed:uninstall-cswap' });
      assert.equal(existsSync(join(f.deps.journalDir, 'retire-cswap.json')), true);
      assert.equal(phase(f.store).note, 'retirement-in-progress');
    } finally { f.cleanup(); }
  });

  it('runs the injected production S57 drain in bootout, disable, plist-move, and cooperative-drain order', async () => {
    const f = fixture();
    try {
      const calls: string[] = [];
      const ctx = { stdout: () => {}, stderr: () => {}, env: { QLB_HOME: f.root, QLB_TEST_MODE: '1' }, home: f.root,
        config: { ...defaultConfig(f.root), dbPath: f.store.dbPath }, loadConfig: () => defaultConfig(f.root), registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [] };
      const deps = productionDependencies(f.store, ctx, {
        bootout: () => { calls.push('bootout'); return { ok: true }; },
        disable: () => { calls.push('disable'); return { ok: true }; },
        movePlist: () => { calls.push('move-plist'); return { ok: true }; },
        restorePlist: () => ({ ok: true }),
        drain: () => { calls.push('drain'); return { ok: true }; },
      });
      assert.deepEqual(await deps.effects.drainCswap(), { ok: true });
      assert.deepEqual(calls, ['bootout', 'disable', 'move-plist', 'drain']);
    } finally { f.cleanup(); }
  });

  it('prints the unprovable slot and exits 3 at the command boundary', async () => {
    const f = fixture();
    try {
      const stdout: string[] = []; const stderr: string[] = [];
      const code = await runRetireCswapCommand([], {
        stdout: (message: string) => stdout.push(message), stderr: (message: string) => stderr.push(message), env: { QLB_TEST_MODE: '1' }, home: f.root,
        config: { ...defaultConfig(f.root), dbPath: f.store.dbPath }, loadConfig: () => defaultConfig(f.root), registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [],
      }, { retire: async () => ({ ok: false, code: 'slot-lineage-unprovable:slot-a' }) });
      assert.equal(code, 3);
      assert.deepEqual(stdout, []);
      assert.match(stderr.join('\n'), /slot-lineage-unprovable:slot-a/);
    } finally { f.cleanup(); }
  });

  it('uses refresh-token fingerprints for real Claude credential blobs', async () => {
    const f = fixture();
    try {
      const matching = JSON.stringify({ claudeAiOauth: { accessToken: 'access-a', refreshToken: 'refresh-a' } });
      const different = JSON.stringify({ claudeAiOauth: { accessToken: 'access-b', refreshToken: 'refresh-b' } });
      const fp = credentialFingerprint(matching)!;
      f.deps.slots = () => [{ accountId: 'slot-a', source: 'cswap-import', sourceFingerprint: fp, currentFingerprint: fp }];
      f.deps.readSlotFingerprint = () => credentialFingerprint(matching)!;
      f.setCswapItems([{ id: 'cswap-a', fingerprint: credentialFingerprint(matching)! }]);
      assert.deepEqual(await retireCswap(f.store, f.deps), { ok: true, archivePath: join(f.deps.backupsDir, `cswap-retired-${NOW}.tar.gz`) }, 'same refresh token maps');
      const mismatch = fixture();
      try {
        mismatch.deps.slots = () => [{ accountId: 'slot-a', source: 'cswap-import', sourceFingerprint: fp, currentFingerprint: fp }];
        mismatch.deps.readSlotFingerprint = () => credentialFingerprint(different)!;
        assert.deepEqual(await retireCswap(mismatch.store, mismatch.deps), { ok: false, code: 'slot-lineage-mismatch:slot-a' });
      } finally { mismatch.cleanup(); }
    } finally { f.cleanup(); }
  });

  it('s64DoctorVerdict tolerates only the lifecycle:window WARN and fails on a provider WARN', () => {
    const report = {
      command: 'doctor' as const,
      overall: 'WARN' as const,
      checks: [{ name: 'lifecycle:window', level: 'WARN' as const, message: 'expected after window' }],
      providers: [],
    };
    assert.deepEqual(s64DoctorVerdict(report), { overall: 'PASS', autoAgent: 'FAIL' });
    assert.deepEqual(s64DoctorVerdict({ ...report, providers: [{ provider: 'xai', level: 'WARN', message: 'broken', source: 'fixture', envVar: 'FIXTURE', example: 'fixture' }] }), { overall: 'FAIL', autoAgent: 'FAIL' });
  });

  it('s64DoctorVerdict reports autoAgent FAIL when no auto:agent check exists and PASS when it is PASS', () => {
    const base = { command: 'doctor' as const, overall: 'PASS' as const, checks: [], providers: [] };
    assert.equal(s64DoctorVerdict(base).autoAgent, 'FAIL');
    assert.equal(s64DoctorVerdict({ ...base, checks: [{ name: 'auto:agent', level: 'PASS', message: 'ok' }] }).autoAgent, 'PASS');
  });

  it('listUnclaimedKeychainServices finds a stash behind a slot item', () => {
    platformKeychain.setSync('qlb:anthropic:slot-a', 'qlb', 'fixture-slot');
    platformKeychain.setSync('qlb:anthropic:unclaimed:123', 'qlb', 'fixture-stash');
    platformKeychain.setSync('qlb:xai:unclaimed:5', 'qlb', 'fixture-stash');
    const services = listUnclaimedKeychainServices();
    assert.ok(services.includes('qlb:anthropic:unclaimed:123'));
    assert.ok(services.includes('qlb:xai:unclaimed:5'));
    assert.equal(services.includes('qlb:anthropic:slot-a'), false);
  });

  it('hasUnadoptedStash fails closed when enumeration throws', async () => {
    const f = fixture();
    try {
      const ctx = { stdout: () => {}, stderr: () => {}, env: { QLB_HOME: f.root, QLB_TEST_MODE: '1' }, home: f.root,
        config: { ...defaultConfig(f.root), dbPath: f.store.dbPath }, loadConfig: () => defaultConfig(f.root), registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [] };
      const deps = productionDependencies(f.store, ctx, undefined, () => { throw new Error('enumeration failed'); });
      assert.throws(() => deps.hasUnadoptedStash(), /enumeration failed/);
    } finally { f.cleanup(); }
  });

  it('stash dir and pi-auth baseline dir follow QLB_HOME, not --db-path', () => {
    const f = fixture();
    const home = mkdtempSync(join(tmpdir(), 'qlb-retire-home-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'qlb-retire-db-'));
    try {
      const authPath = join(home, '.pi', 'agent', 'auth.json');
      const config = { ...defaultConfig(home), dbPath: join(elsewhere, 'custom.db'), piAuthJsonPath: authPath };
      const ctx = { stdout: () => {}, stderr: () => {}, env: { QLB_HOME: home, QLB_TEST_MODE: '1' }, home,
        config, loadConfig: () => config, registerSecret: () => {}, deliverSecret: () => {}, knownSecrets: () => [] };
      const deps = productionDependencies(f.store, ctx);
      assert.equal(deps.stateDir, join(home, '.qlb'));
      assert.equal(deps.journalDir, join(home, '.qlb', 'journal'));
      const baseline = defaultPiMigratePaths(qlbHomeDir(ctx.env), authPath).baselineDir;
      mkdirSync(baseline, { recursive: true });
      writeFileSync(join(baseline, 'fixture'), 'fixture');
      deps.effects.deletePiBaselines();
      assert.equal(existsSync(baseline), false);
      assert.equal(existsSync(join(elsewhere, 'backups', 'pi-auth')), false);
    } finally {
      f.cleanup();
      rmSync(home, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
