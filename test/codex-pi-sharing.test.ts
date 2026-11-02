import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { describe, it } from 'node:test';

import { runCodexPiSharingCommand } from '../src/commands/codex-pi-sharing';
import type { CommandContext } from '../src/registry';
import { openStore, openStoreConnection } from '../src/store';

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

type Identity = { userId: string; accountId: string };
const FIXTURE_IDENTITY: Identity = { userId: 'fixture-user', accountId: 'fixture-account' };

function fingerprint(refresh: string): string {
  return `sha256:${createHash('sha256').update(refresh, 'utf8').digest('hex')}`;
}

function jwt(identity: Identity): string {
  const payload = Buffer.from(JSON.stringify({ [OPENAI_AUTH_CLAIM]: {
    chatgpt_user_id: identity.userId,
    chatgpt_account_id: identity.accountId,
  } })).toString('base64url');
  return `fixture.${payload}.signature`;
}

function document(refresh: string, identity: Identity = FIXTURE_IDENTITY): Record<string, unknown> {
  return {
    tokens: {
      id_token: jwt(identity),
      access_token: 'fixture-access-token',
      refresh_token: refresh,
    },
  };
}

function piDocument(refresh: string, identity: Identity = FIXTURE_IDENTITY, accountId?: string): Record<string, unknown> {
  return {
    'openai-codex': {
      access: jwt(identity),
      refresh,
      expires: 1,
      ...(accountId === undefined ? {} : { accountId }),
    },
  };
}

function snapshot(path: string, prefix = ''): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  if (!existsSync(path)) return files;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const relative = prefix ? join(prefix, entry.name) : entry.name;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      for (const [name, contents] of snapshot(child, relative)) files.set(name, contents);
    } else if (!relative.endsWith('-shm') && !relative.endsWith('-wal')) {
      files.set(relative, readFileSync(child));
    }
  }
  return files;
}

interface Fixture {
  root: string;
  home: string;
  qlbHome: string;
  piPath: string;
  codexPath: string;
  dbPath: string;
  output: string[];
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'qlb-codex-pi-sharing-'));
  const home = join(root, 'home');
  const qlbHome = join(root, 'qlb');
  const piPath = join(home, '.pi', 'agent', 'auth.json');
  const codexPath = join(home, '.codex', 'auth.json');
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(qlbHome);
  return { root, home, qlbHome, piPath, codexPath, dbPath: join(qlbHome, 'qlb.db'), output: [] };
}

function context(f: Fixture): CommandContext {
  return {
    stdout: (line) => f.output.push(line),
    stderr: (line) => f.output.push(`ERR:${line}`),
    env: { QLB_TEST_MODE: '1', QLB_HOME: f.qlbHome, HOME: f.home },
    config: { piAuthJsonPath: f.piPath, codexAuthJsonPath: f.codexPath, dbPath: f.dbPath } as CommandContext['config'],
    loadConfig: () => { throw new Error('not used'); },
    home: f.home,
    registerSecret: () => undefined,
    deliverSecret: () => undefined,
    knownSecrets: () => [],
  };
}

function close(f: Fixture): void {
  rmSync(f.root, { recursive: true, force: true });
}

function seedLineage(f: Fixture, from: string, to: string, dead = false): void {
  const store = openStore(f.dbPath);
  store.close();
  const db = openStoreConnection(f.dbPath);
  try {
    db.prepare(`INSERT INTO codex_slots
      (account_id, chatgpt_user_id, chatgpt_account_id, fingerprint, prev_fingerprint, dead, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      `${FIXTURE_IDENTITY.userId}:${FIXTURE_IDENTITY.accountId}`,
      FIXTURE_IDENTITY.userId,
      FIXTURE_IDENTITY.accountId,
      to,
      from,
      dead ? 1 : 0,
      1,
    );
  } finally {
    db.close();
  }
}

function seedEmptyDatabase(f: Fixture): void {
  const store = openStore(f.dbPath);
  store.close();
}

describe('qlb codex pi-sharing', () => {
  it('equal lineage is shared', async () => {
    const f = fixture();
    const piRefresh = 'pi-refresh-equal-lineage';
    const liveRefresh = 'live-refresh-equal-lineage';
    try {
      writeFileSync(f.piPath, JSON.stringify(piDocument(piRefresh)));
      writeFileSync(f.codexPath, JSON.stringify(document(liveRefresh)));
      seedLineage(f, fingerprint(piRefresh), fingerprint(liveRefresh));

      assert.equal(await runCodexPiSharingCommand(['--json'], context(f)), 0);
      assert.deepEqual(JSON.parse(f.output[0]!), {
        status: 'shared',
        piFingerprint: fingerprint(piRefresh).slice(0, 19),
        codexFingerprint: fingerprint(liveRefresh).slice(0, 19),
      });
    } finally {
      close(f);
    }
  });

  it('committed lineage still in the WAL is shared', async () => {
    const f = fixture();
    const piRefresh = 'pi-refresh-wal-lineage';
    const liveRefresh = 'live-refresh-wal-lineage';
    let holder: ReturnType<typeof openStoreConnection> | undefined;
    try {
      writeFileSync(f.piPath, JSON.stringify(piDocument(piRefresh)));
      writeFileSync(f.codexPath, JSON.stringify(document(liveRefresh)));
      seedEmptyDatabase(f);
      holder = openStoreConnection(f.dbPath);
      const writer = openStoreConnection(f.dbPath);
      try {
        writer.prepare(`INSERT INTO codex_slots
          (account_id, chatgpt_user_id, chatgpt_account_id, fingerprint, prev_fingerprint, added_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(
          `${FIXTURE_IDENTITY.userId}:${FIXTURE_IDENTITY.accountId}`,
          FIXTURE_IDENTITY.userId,
          FIXTURE_IDENTITY.accountId,
          fingerprint(liveRefresh),
          fingerprint(piRefresh),
          1,
        );
      } finally {
        writer.close();
      }
      assert.equal(existsSync(`${f.dbPath}-wal`), true);

      assert.equal(await runCodexPiSharingCommand(['--json'], context(f)), 0);
      assert.equal(JSON.parse(f.output[0]!).status, 'shared');
    } finally {
      holder?.close();
      close(f);
    }
  });

  it('same account without a lineage link cannot-tell', async () => {
    const f = fixture();
    try {
      writeFileSync(f.piPath, JSON.stringify(piDocument('pi-refresh-cannot-tell')));
      writeFileSync(f.codexPath, JSON.stringify(document('live-refresh-cannot-tell')));
      seedEmptyDatabase(f);

      assert.equal(await runCodexPiSharingCommand([], context(f)), 0);
      assert.match(f.output[0]!, /^cannot-tell pi=sha256:[a-f0-9]{12} codex=sha256:[a-f0-9]{12}$/);
    } finally {
      close(f);
    }
  });

  it('different lineage is separate', async () => {
    const f = fixture();
    try {
      writeFileSync(f.piPath, JSON.stringify(piDocument('pi-refresh-separate', { userId: 'pi-user', accountId: 'pi-account' })));
      writeFileSync(f.codexPath, JSON.stringify(document('live-refresh-separate', { userId: 'live-user', accountId: 'live-account' })));
      seedEmptyDatabase(f);

      assert.equal(await runCodexPiSharingCommand([], context(f)), 0);
      assert.match(f.output[0]!, /^separate pi=sha256:[a-f0-9]{12} codex=sha256:[a-f0-9]{12}$/);
    } finally {
      close(f);
    }
  });

  it('a Pi stored account ID matching live identity cannot-tell despite a differing JWT claim', async () => {
    const f = fixture();
    try {
      writeFileSync(f.piPath, JSON.stringify(piDocument(
        'pi-refresh-stored-account',
        { userId: FIXTURE_IDENTITY.userId, accountId: 'pi-jwt-account' },
        FIXTURE_IDENTITY.accountId,
      )));
      writeFileSync(f.codexPath, JSON.stringify(document('live-refresh-stored-account')));
      seedEmptyDatabase(f);

      assert.equal(await runCodexPiSharingCommand([], context(f)), 0);
      assert.match(f.output[0]!, /^cannot-tell pi=sha256:[a-f0-9]{12} codex=sha256:[a-f0-9]{12}$/);
      assert.doesNotMatch(f.output.join('\n'), /separate/);
    } finally {
      close(f);
    }
  });

  it('a dead-slot lineage is shared', async () => {
    const f = fixture();
    const piRefresh = 'pi-refresh-dead-slot';
    const liveRefresh = 'live-refresh-dead-slot';
    try {
      writeFileSync(f.piPath, JSON.stringify(piDocument(piRefresh)));
      writeFileSync(f.codexPath, JSON.stringify(document(liveRefresh)));
      seedLineage(f, fingerprint(piRefresh), fingerprint(liveRefresh), true);

      assert.equal(await runCodexPiSharingCommand(['--json'], context(f)), 0);
      assert.equal(JSON.parse(f.output[0]!).status, 'shared');
    } finally {
      close(f);
    }
  });

  it('no Pi entry reports no-pi-entry', async () => {
    const f = fixture();
    try {
      writeFileSync(f.piPath, JSON.stringify({ xai: { access: 'fixture' } }));

      assert.equal(await runCodexPiSharingCommand([], context(f)), 0);
      assert.deepEqual(f.output, ['no-pi-entry']);
    } finally {
      close(f);
    }
  });

  it('an unreadable file exits 1', async () => {
    const f = fixture();
    try {
      mkdirSync(f.piPath);

      assert.equal(await runCodexPiSharingCommand([], context(f)), 1);
      assert.deepEqual(f.output, ['ERR:qlb codex pi-sharing: input unavailable']);
      assert.doesNotMatch(f.output.join('\n'), /separate/);
    } finally {
      close(f);
    }
  });

  it('a dangling Pi auth symlink exits 1', async () => {
    const f = fixture();
    try {
      symlinkSync(join(f.root, 'missing-pi-auth.json'), f.piPath);

      assert.equal(await runCodexPiSharingCommand([], context(f)), 1);
      assert.deepEqual(f.output, ['ERR:qlb codex pi-sharing: input unavailable']);
    } finally {
      close(f);
    }
  });

  it('a dangling Pi auth parent-directory symlink exits 1', async () => {
    const f = fixture();
    try {
      const agentDir = join(f.home, '.pi', 'agent');
      rmSync(agentDir, { recursive: true, force: true });
      symlinkSync(join(f.root, 'missing-pi-agent'), agentDir);

      assert.equal(await runCodexPiSharingCommand([], context(f)), 1);
      assert.deepEqual(f.output, ['ERR:qlb codex pi-sharing: input unavailable']);
    } finally {
      close(f);
    }
  });

  it('a missing database exits 1', async () => {
    const f = fixture();
    try {
      writeFileSync(f.piPath, JSON.stringify(piDocument('pi-refresh-missing-db')));
      writeFileSync(f.codexPath, JSON.stringify(document('live-refresh-missing-db')));

      assert.equal(await runCodexPiSharingCommand([], context(f)), 1);
      assert.deepEqual(f.output, ['ERR:qlb codex pi-sharing: input unavailable']);
      assert.doesNotMatch(f.output.join('\n'), /separate/);
    } finally {
      close(f);
    }
  });

  it('no file changes under QLB_HOME', async () => {
    const f = fixture();
    const piRefresh = 'pi-refresh-never-output';
    const liveRefresh = 'live-refresh-never-output';
    try {
      writeFileSync(f.piPath, JSON.stringify(piDocument(piRefresh)));
      writeFileSync(f.codexPath, JSON.stringify(document(liveRefresh)));
      seedLineage(f, fingerprint(piRefresh), fingerprint(liveRefresh));
      const before = snapshot(f.qlbHome);

      assert.equal(await runCodexPiSharingCommand(['--json'], context(f)), 0);

      assert.deepEqual(snapshot(f.qlbHome), before);
    } finally {
      close(f);
    }
  });

  it('no credential text in output', async () => {
    const f = fixture();
    const piRefresh = 'pi-refresh-never-output';
    const liveRefresh = 'live-refresh-never-output';
    const piAccess = jwt(FIXTURE_IDENTITY);
    const live = document(liveRefresh) as { tokens: { id_token: string; access_token: string } };
    try {
      writeFileSync(f.piPath, JSON.stringify({ 'openai-codex': { access: piAccess, refresh: piRefresh, expires: 1 } }));
      writeFileSync(f.codexPath, JSON.stringify(live));
      seedLineage(f, fingerprint(piRefresh), fingerprint(liveRefresh));

      assert.equal(await runCodexPiSharingCommand(['--json'], context(f)), 0);

      const output = f.output.join('\n');
      for (const credential of [piRefresh, liveRefresh, piAccess, live.tokens.access_token, live.tokens.id_token]) {
        assert.doesNotMatch(output, new RegExp(credential));
      }
    } finally {
      close(f);
    }
  });
});
