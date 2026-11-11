import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MockKeychain } from '../src/keychain';
import { beginCutover } from '../src/lifecycle';
import { Migration, PI_POOL_STORE, type MigrationConfig } from '../src/migration';
import { runPiGate } from '../src/pi-gate';
import { openStore, type Store } from '../src/store';
import { seedActiveSlots } from './support/adoption-slots';

const NOW = 1_700_000_000_000;
const SLOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN = 'access-token-a';

function plant(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(path, 'index.js'), 'extension\n', { mode: 0o600 });
}

interface Live {
  dir: string;
  poolPath: string;
  ownerPath: string;
  src: string;
  dst: string;
  store: Store;
  mig: Migration;
  close: () => void;
}

function openLive(config: MigrationConfig = {}): Live {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-r1b-h4-'));
  const poolPath = join(dir, 'anthropic-pool.json');
  const ownerPath = join(dir, 'qlb-owner.json');
  writeFileSync(poolPath, `${JSON.stringify({
    accounts: [{
      id: 'row-a',
      accountUuid: SLOT,
      credentials: { type: 'oauth', access: TOKEN, refresh: 'refresh-token-a', expires: NOW + 3 * 60 * 60 * 1000 },
    }],
  })}\n`, { mode: 0o600 });
  const store = openStore(join(dir, 'qlb.db'));
  seedActiveSlots(store, [{ accountId: SLOT }], SLOT);
  const mig = new Migration(store, new MockKeychain(), poolPath, ownerPath, undefined, {
    authJsonPath: join(dir, 'auth.json'),
    now: () => NOW,
    initialActiveAlias: 'member-0001',
    anthropicPoolTransport: {
      async getProfile() {
        return { status: 200, body: { account: { uuid: SLOT } } };
      },
      async getUsage() {
        return { status: 200, body: { five_hour: { utilization: 1 }, seven_day: { utilization: 2 } } };
      },
    },
    ...config,
  });
  return {
    dir, poolPath, ownerPath,
    src: join(dir, 'extensions', 'anthropic-pool'),
    dst: join(dir, 'extensions-disabled-by-qlb', 'anthropic-pool'),
    store, mig,
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function rehearse(live: Live): Promise<void> {
  live.mig.stage();
  await live.mig.rehearse(async () => { throw new Error('hook'); });
}

function extensionField(live: Live): unknown {
  const detail = JSON.parse(live.store.getMigration(PI_POOL_STORE)?.detail_json ?? '{}') as {
    anthropicPoolExtension?: unknown;
  };
  return detail.anthropicPoolExtension;
}

describe('H4 anthropic-pool extension', () => {
  it('F1 renames the live extension and journals disabled', async () => {
    const live = openLive();
    plant(live.src);
    try {
      await rehearse(live);
      assert.equal(live.mig.commit().state, 'QLB_OWNED');
      assert.equal(existsSync(live.src), false);
      assert.equal(existsSync(join(live.dst, 'index.js')), true);
      assert.equal(extensionField(live), 'disabled');
    } finally {
      live.close();
    }
  });

  it('F2 journals disabled when only the destination exists', async () => {
    const live = openLive();
    plant(live.dst);
    const before = live.dst;
    try {
      await rehearse(live);
      live.mig.commit();
      assert.equal(existsSync(live.src), false);
      assert.equal(existsSync(before), true);
      assert.equal(extensionField(live), 'disabled');
    } finally {
      live.close();
    }
  });

  it('F3 refuses before the owner write when both directories exist', async () => {
    const live = openLive();
    plant(live.src);
    plant(live.dst);
    try {
      await rehearse(live);
      assert.throws(() => live.mig.commit(), (error: unknown) => (
        error instanceof Error && error.message === 'anthropic-pool-dir-ambiguous'
      ));
      assert.equal(existsSync(live.ownerPath), false);
      assert.equal(existsSync(live.src), true);
      assert.equal(existsSync(live.dst), true);
    } finally {
      live.close();
    }
  });

  it('F4 journals absent and the gate prerequisite passes', async () => {
    const live = openLive();
    try {
      await rehearse(live);
      live.mig.commit();
      assert.equal(extensionField(live), 'absent');
      beginCutover(live.store);
      const stderr: string[] = [];
      const code = await runPiGate('anthropic', {
        dbPath: live.store.dbPath,
        env: { QLB_PI_TOKEN_CALL: '1' },
        piAgentDir: live.dir,
        guard: () => true,
        admitted: () => ({ ok: true }),
        cswapProcesses: () => [],
        deliver: () => undefined,
        stderr: (line) => stderr.push(line),
        provider: { read: async () => ({ token: 'served', accountId: SLOT, source: 'fixture' }) },
      });
      assert.deepEqual(stderr, []);
      assert.equal(code, 0);
    } finally {
      live.close();
    }
  });

  it('F5 resume after the owner entry performs the rename', async () => {
    const live = openLive({
      afterWrite: (point) => {
        if (point === 'placeholder') throw new Error('crash-before-rename');
      },
    });
    plant(live.src);
    try {
      await rehearse(live);
      assert.throws(() => live.mig.commit(), /crash-before-rename/);
      assert.equal(existsSync(live.src), true);
      const resumed = new Migration(live.store, new MockKeychain(), live.poolPath, live.ownerPath, undefined, {
        authJsonPath: join(live.dir, 'auth.json'),
        now: () => NOW,
      });
      assert.equal(resumed.resume().state, 'QLB_OWNED');
      assert.equal(existsSync(live.src), false);
      assert.equal(existsSync(join(live.dst, 'index.js')), true);
      assert.equal(extensionField(live), 'disabled');
    } finally {
      live.close();
    }
  });

  it('F6 resume after the rename journals disabled without another move', async () => {
    const live = openLive({
      afterWrite: (point) => {
        if (point === 'placeholder') throw new Error('crash-before-rename');
      },
    });
    plant(live.src);
    try {
      await rehearse(live);
      assert.throws(() => live.mig.commit(), /crash-before-rename/);
      mkdirSync(join(live.dir, 'extensions-disabled-by-qlb'), { recursive: true });
      const { renameSync } = await import('node:fs');
      renameSync(live.src, live.dst);
      const resumed = new Migration(live.store, new MockKeychain(), live.poolPath, live.ownerPath, undefined, {
        authJsonPath: join(live.dir, 'auth.json'),
        now: () => NOW,
      });
      resumed.resume();
      assert.equal(existsSync(live.dst), true);
      assert.equal(existsSync(live.src), false);
      assert.equal(extensionField(live), 'disabled');
    } finally {
      live.close();
    }
  });

  it('F3 at resume leaves the owner and reports the refusal', async () => {
    const live = openLive({
      afterWrite: (point) => {
        if (point === 'placeholder') throw new Error('crash-before-rename');
      },
    });
    plant(live.src);
    try {
      await rehearse(live);
      assert.throws(() => live.mig.commit(), /crash-before-rename/);
      plant(live.dst);
      const resumed = new Migration(live.store, new MockKeychain(), live.poolPath, live.ownerPath, undefined, {
        authJsonPath: join(live.dir, 'auth.json'),
        now: () => NOW,
      });
      assert.equal(resumed.status().resumeAction, 'anthropic-pool-dir-ambiguous');
      assert.throws(() => resumed.resume(), (error: unknown) => (
        error instanceof Error && error.message === 'anthropic-pool-dir-ambiguous'
      ));
      assert.equal(existsSync(live.ownerPath), true);
    } finally {
      live.close();
    }
  });

  it('B1 restores the extension before removing the owner', async () => {
    const live = openLive();
    plant(live.src);
    try {
      await rehearse(live);
      live.mig.commit();
      assert.equal(live.mig.rollback().state, 'VALIDATED');
      assert.equal(existsSync(join(live.src, 'index.js')), true);
      assert.equal(existsSync(live.dst), false);
      assert.equal(existsSync(live.ownerPath), false);
      assert.equal(extensionField(live), 'restored');
    } finally {
      live.close();
    }
  });

  it('B2 journals restored when the extension is already back and continues', async () => {
    const live = openLive();
    plant(live.src);
    try {
      await rehearse(live);
      live.mig.commit();
      mkdirSync(join(live.dir, 'extensions'), { recursive: true });
      renameSync(live.dst, live.src);
      assert.equal(live.mig.rollback().state, 'VALIDATED');
      assert.equal(existsSync(join(live.src, 'index.js')), true);
      assert.equal(existsSync(live.ownerPath), false);
      assert.equal(extensionField(live), 'restored');
    } finally {
      live.close();
    }
  });

  it('B5 re-running rollback continues after the native file is restored', async () => {
    const live = openLive();
    plant(live.src);
    try {
      await rehearse(live);
      live.mig.commit();
      const retired = `${live.poolPath}.pre-qlb`;
      renameSync(retired, live.poolPath);
      const detail = JSON.parse(live.store.getMigration(PI_POOL_STORE)?.detail_json ?? '{}') as Record<string, unknown>;
      detail.intent = 'rollback';
      live.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', JSON.stringify(detail));
      assert.equal(live.mig.resume().state, 'VALIDATED');
      assert.equal(existsSync(join(live.src, 'index.js')), true);
      assert.equal(existsSync(live.dst), false);
    } finally {
      live.close();
    }
  });

  it('B6 the gate refuses anthropic-pool-present until rollback is re-run', async () => {
    const live = openLive();
    plant(live.src);
    try {
      await rehearse(live);
      live.mig.commit();
      mkdirSync(join(live.dir, 'extensions'), { recursive: true });
      renameSync(live.dst, live.src);
      const retired = `${live.poolPath}.pre-qlb`;
      if (existsSync(retired)) renameSync(retired, live.poolPath);
      const detail = JSON.parse(live.store.getMigration(PI_POOL_STORE)?.detail_json ?? '{}') as Record<string, unknown>;
      detail.intent = 'rollback';
      live.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', JSON.stringify(detail));
      beginCutover(live.store);
      const stderr: string[] = [];
      const code = await runPiGate('anthropic', {
        dbPath: live.store.dbPath,
        env: { QLB_PI_TOKEN_CALL: '1' },
        piAgentDir: live.dir,
        guard: () => true,
        admitted: () => ({ ok: true }),
        cswapProcesses: () => [],
        deliver: () => undefined,
        stderr: (line) => stderr.push(line),
        provider: { read: async () => ({ token: 'served', accountId: SLOT, source: 'fixture' }) },
      });
      assert.equal(code, 1);
      assert.deepEqual(stderr, ['anthropic-pool-present']);
      assert.equal(live.mig.resume().state, 'VALIDATED');
      assert.equal(existsSync(live.ownerPath), false);
    } finally {
      live.close();
    }
  });

  it('B3 refuses when both directories exist and keeps the owner', async () => {
    const live = openLive();
    plant(live.src);
    try {
      await rehearse(live);
      live.mig.commit();
      plant(live.src);
      assert.throws(() => live.mig.rollback(), (error: unknown) => (
        error instanceof Error && error.message === 'anthropic-pool-dir-ambiguous'
      ));
      assert.equal(existsSync(live.ownerPath), true);
      assert.equal(live.mig.status().resumeAction, 'anthropic-pool-dir-ambiguous');
    } finally {
      live.close();
    }
  });

  it('B4 refuses a missing extension that was disabled and keeps the owner', async () => {
    const live = openLive();
    plant(live.src);
    try {
      await rehearse(live);
      live.mig.commit();
      rmSync(live.dst, { recursive: true, force: true });
      assert.throws(() => live.mig.rollback(), (error: unknown) => (
        error instanceof Error && error.message === 'anthropic-pool-dir-missing'
      ));
      assert.equal(existsSync(live.ownerPath), true);
      assert.equal(live.mig.status().resumeAction, 'anthropic-pool-dir-missing');
    } finally {
      live.close();
    }
  });

  it('B4-prime continues when both directories are absent and the journal says absent', async () => {
    const live = openLive();
    try {
      await rehearse(live);
      live.mig.commit();
      assert.equal(extensionField(live), 'absent');
      assert.equal(live.mig.rollback().state, 'VALIDATED');
      assert.equal(existsSync(live.ownerPath), false);
    } finally {
      live.close();
    }
  });

  it('B7 second rollback does not rename the restored extension', async () => {
    const live = openLive();
    plant(live.src);
    try {
      await rehearse(live);
      live.mig.commit();
      live.mig.rollback();
      assert.equal(existsSync(join(live.src, 'index.js')), true);
      live.mig.rollback();
      assert.equal(live.mig.status().state, 'NATIVE');
      assert.equal(existsSync(join(live.src, 'index.js')), true);
      assert.equal(existsSync(live.dst), false);
    } finally {
      live.close();
    }
  });

  it('first owned gate read passes prerequisites after F1', async () => {
    const live = openLive();
    plant(live.src);
    try {
      await rehearse(live);
      live.mig.commit();
      beginCutover(live.store);
      const stderr: string[] = [];
      const code = await runPiGate('anthropic', {
        dbPath: live.store.dbPath,
        env: { QLB_PI_TOKEN_CALL: '1' },
        piAgentDir: live.dir,
        guard: () => true,
        admitted: () => ({ ok: true }),
        cswapProcesses: () => [],
        deliver: () => undefined,
        stderr: (line) => stderr.push(line),
        provider: { read: async () => ({ token: 'served', accountId: SLOT, source: 'fixture' }) },
      });
      assert.equal(code, 0);
      assert.deepEqual(stderr, []);
    } finally {
      live.close();
    }
  });
});
