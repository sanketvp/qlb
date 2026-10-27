import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { evaluateRetirementGates, type CswapRetireDependencies } from '../src/cswap-retire';
import piRollback, { executePiRollback } from '../src/commands/pi-rollback';
import { beginCutover, beginRetirementFence, phase } from '../src/lifecycle';
import { openStore } from '../src/store';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 20 * DAY_MS;
const PROVIDERS = ['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter'];

type Fixture = ReturnType<typeof fixture>;

function fixture(): {
  root: string;
  store: ReturnType<typeof openStore>;
  deps: CswapRetireDependencies;
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

  const deps: CswapRetireDependencies = {
    now: () => NOW,
    backupsDir: join(root, 'retirement-backups'),
    journalDir: join(root, 'journal'),
    doctor: async () => ({ overall: 'PASS', autoAgent: 'PASS' }),
    reportReceiptPasses: () => true,
    hasFourInjectedDrillRows: () => true,
    hasUnadoptedStash: () => false,
    claudeSlotsPass: () => true,
    slots: () => [{ accountId: 'slot-a', source: 'cswap-import', sourceFingerprint: 'source-a', currentFingerprint: 'current-a' }],
    cswapItems: () => [{ id: 'cswap-a', fingerprint: 'source-a' }],
    readSlotFingerprint: async () => 'current-a',
    effects: {
      archiveCswap: () => {}, deleteCswapItems: () => {}, uninstallCswap: () => {},
      removeCswapLaunchArtifacts: () => {}, deletePiBaselines: () => {}, archiveExpiredStash: () => {},
    },
  };
  return { root, store, deps, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
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
});
