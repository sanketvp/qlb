import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { runCodexPiSharingCommand } from '../src/commands/codex-pi-sharing';
import type { CommandContext } from '../src/registry';
import { openStore } from '../src/store';

function fingerprint(refresh: string): string {
  return `sha256:${createHash('sha256').update(refresh, 'utf8').digest('hex')}`;
}

function document(refresh: string): Record<string, unknown> {
  return {
    tokens: {
      id_token: 'fixture-id-token',
      access_token: 'fixture-access-token',
      refresh_token: refresh,
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
    } else {
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

function seedLineage(f: Fixture, from: string, to: string): void {
  const store = openStore(f.dbPath);
  store.close();
  const db = new DatabaseSync(f.dbPath);
  try {
    db.prepare(`INSERT INTO codex_slots
      (account_id, chatgpt_user_id, chatgpt_account_id, fingerprint, prev_fingerprint, added_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('fixture-user:fixture-account', 'fixture-user', 'fixture-account', to, from, 1);
  } finally {
    db.close();
  }
}

describe('qlb codex pi-sharing', () => {
  it('equal lineage is shared', async () => {
    const f = fixture();
    const piRefresh = 'pi-refresh-equal-lineage';
    const liveRefresh = 'live-refresh-equal-lineage';
    try {
      writeFileSync(f.piPath, JSON.stringify({ 'openai-codex': { access: 'fixture-access', refresh: piRefresh, expires: 1 } }));
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

  it('different lineage is separate', async () => {
    const f = fixture();
    const piRefresh = 'pi-refresh-separate';
    const liveRefresh = 'live-refresh-separate';
    try {
      writeFileSync(f.piPath, JSON.stringify({ 'openai-codex': { access: 'fixture-access', refresh: piRefresh, expires: 1 } }));
      writeFileSync(f.codexPath, JSON.stringify(document(liveRefresh)));

      assert.equal(await runCodexPiSharingCommand([], context(f)), 0);
      assert.match(f.output[0]!, /^separate pi=sha256:[a-f0-9]{12} codex=sha256:[a-f0-9]{12}$/);
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

  it('does not change QLB_HOME or emit credential text', async () => {
    const f = fixture();
    const piRefresh = 'pi-refresh-never-output';
    const liveRefresh = 'live-refresh-never-output';
    try {
      writeFileSync(f.piPath, JSON.stringify({ 'openai-codex': { access: 'pi-access-never-output', refresh: piRefresh, expires: 1 } }));
      writeFileSync(f.codexPath, JSON.stringify(document(liveRefresh)));
      seedLineage(f, fingerprint(piRefresh), fingerprint(liveRefresh));
      const before = snapshot(f.qlbHome);

      assert.equal(await runCodexPiSharingCommand(['--json'], context(f)), 0);

      assert.deepEqual(snapshot(f.qlbHome), before);
      const output = f.output.join('\n');
      for (const credential of [piRefresh, liveRefresh, 'pi-access-never-output', 'fixture-access-token', 'fixture-id-token']) {
        assert.doesNotMatch(output, new RegExp(credential));
      }
    } finally {
      close(f);
    }
  });
});
