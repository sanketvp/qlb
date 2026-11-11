import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { formatAnthropicPreflight, openPreflightDatabase, runAnthropicPreflight } from '../src/anthropic-preflight';
import type { ClaudePaths } from '../src/cc-paths';
import { CSWAP_ANTHROPIC_STORE, CONSUME_STATE } from '../src/cswap-consume';
import { parseArgs } from '../src/app';
import { MockKeychain, type KeychainBackend } from '../src/keychain';
import { PI_POOL_STORE } from '../src/migration';
import { SCHEMA_VERSION } from '../src/schema-version';
import { openStore, type Store } from '../src/store';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const FRESH_EXPIRES = NOW + 3 * HOUR;
const TOKEN = 'claude-code-access-token';
const ACCOUNT = 'preflight-user';
const SERVICE = 'Claude Code-credentials';
const UUID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UUID_B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const EMAIL = 'user@example.com';
const CANARY_TOKEN = 'sk-ant-oat01-R1B-LEAK-CANARY-7f3a9c1e';
const CANARY_EXPIRY = 4102444800123;

function pool(accounts: unknown[]): string {
  return `${JSON.stringify({ accounts })}\n`;
}

function oauth(expires: number) {
  return { type: 'oauth', access: 'pool-access-token', refresh: 'pool-refresh-token', expires };
}

function uuidMember(accountUuid: string, expires = FRESH_EXPIRES) {
  return { accountUuid, credentials: oauth(expires) };
}

function emailMember(email: string, expires = FRESH_EXPIRES) {
  return { email, credentials: oauth(expires) };
}

function claudeBlob(token: string, expiresAt?: number | string): string {
  const oauthBlob: Record<string, unknown> = { accessToken: token, refreshToken: `${token}-refresh` };
  if (expiresAt !== undefined) oauthBlob.expiresAt = expiresAt;
  return JSON.stringify({ claudeAiOauth: oauthBlob });
}

interface Fixture {
  dir: string;
  dbPath: string;
  poolPath: string;
  ownerPath: string;
  store: Store;
  backend: MockKeychain;
  paths: ClaudePaths;
}

function insertSlot(
  dbPath: string,
  slot: { accountId: string; email?: string | null; dead?: boolean; archivedAt?: number | null },
): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(`INSERT INTO claude_slots (account_id, email, config_json, dead, added_at, archived_at)
    VALUES (?, ?, '{}', ?, ?, ?)`).run(
    slot.accountId,
    slot.email ?? null,
    slot.dead ? 1 : 0,
    NOW,
    slot.archivedAt ?? null,
  );
  db.close();
}

function withFixture(run: (ctx: Fixture) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-r1b-preflight-'));
    const dbPath = join(dir, 'qlb.db');
    const poolPath = join(dir, 'anthropic-pool.json');
    const ownerPath = join(dir, 'qlb-owner.json');
    const store = openStore(dbPath);
    const backend = new MockKeychain();
    const paths: ClaudePaths = {
      configHome: dir,
      credentialsPath: join(dir, '.credentials.json'),
      globalConfigPath: join(dir, '.claude.json'),
      keychainService: SERVICE,
    };
    try {
      await run({ dir, dbPath, poolPath, ownerPath, store, backend, paths });
    } finally {
      try { store.close(); } catch { /* the read-only proof closes the writer first */ }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function preflight(
  ctx: Fixture,
  raw: string,
  options: { now?: number; blob?: string; backend?: KeychainBackend } = {},
) {
  writeFileSync(ctx.poolPath, raw, { mode: 0o600 });
  if (options.blob !== undefined) ctx.backend.setSync(SERVICE, ACCOUNT, options.blob);
  return runAnthropicPreflight({
    dbPath: ctx.dbPath,
    poolFile: ctx.poolPath,
    backend: options.backend ?? ctx.backend,
    now: options.now ?? NOW,
    account: ACCOUNT,
    paths: ctx.paths,
  });
}

function freshBlob(expiresAt = FRESH_EXPIRES): string {
  return claudeBlob(TOKEN, expiresAt);
}

describe('anthropic preflight receipt', () => {
  it('preflight go: every member matched, fresh, initial candidate active, claude token fresh', withFixture(async (ctx) => {
    insertSlot(ctx.dbPath, { accountId: UUID_A });
    insertSlot(ctx.dbPath, { accountId: UUID_B });
    ctx.store.setActiveLogin('anthropic', UUID_B, 'auto', NOW);
    const receipt = await preflight(ctx, pool([uuidMember(UUID_A), uuidMember(UUID_B)]), { blob: freshBlob() });
    assert.deepEqual(receipt, {
      schemaVersion: 1,
      phase: 'preflight',
      disposition: 'go',
      claudeCodeActiveToken: 'fresh',
      count: 2,
      aliases: ['member-0001', 'member-0002'],
      members: [
        { alias: 'member-0001', identityKind: 'accountUuid', slot: 'matched', expiry: 'fresh', active: false },
        { alias: 'member-0002', identityKind: 'accountUuid', slot: 'matched', expiry: 'fresh', active: true },
      ],
    });
    ctx.store.setActiveLogin('anthropic', 'not-a-member', 'auto', NOW);
    const inactive = await preflight(ctx, pool([uuidMember(UUID_A), uuidMember(UUID_B)]));
    assert.equal(inactive.disposition, 'no-go');
    assert.equal(inactive.code, undefined);
    assert.equal(inactive.members?.some((member) => member.active), false);
  }));

  it('preflight no-go: one expired member blocks the whole pool', withFixture(async (ctx) => {
    insertSlot(ctx.dbPath, { accountId: UUID_A });
    insertSlot(ctx.dbPath, { accountId: UUID_B });
    ctx.store.setActiveLogin('anthropic', UUID_A, 'auto', NOW);
    const expired = await preflight(
      ctx,
      pool([uuidMember(UUID_A), uuidMember(UUID_B, NOW - 1_000)]),
      { blob: freshBlob() },
    );
    assert.equal(expired.disposition, 'no-go');
    assert.equal(expired.code, undefined);
    assert.equal(expired.members?.[0]?.expiry, 'fresh');
    assert.equal(expired.members?.[1]?.expiry, 'expired');
    const under = await preflight(ctx, pool([uuidMember(UUID_A), uuidMember(UUID_B, NOW + HOUR)]));
    assert.equal(under.disposition, 'no-go');
    assert.equal(under.members?.[1]?.expiry, 'under-2h');
    const none = await preflight(ctx, pool([uuidMember(UUID_A, 0)]));
    assert.equal(none.disposition, 'no-go');
    assert.equal(none.members?.[0]?.expiry, 'none');
  }));

  it('preflight no-go: member with no slot (adoption-slot-missing)', withFixture(async (ctx) => {
    insertSlot(ctx.dbPath, { accountId: UUID_A });
    ctx.store.setActiveLogin('anthropic', UUID_A, 'auto', NOW);
    const receipt = await preflight(
      ctx,
      pool([uuidMember(UUID_A), uuidMember(UUID_B)]),
      { blob: freshBlob() },
    );
    assert.equal(receipt.disposition, 'no-go');
    assert.equal(receipt.code, 'adoption-slot-missing');
    assert.equal(receipt.members?.[1]?.slot, 'missing');
    assert.equal(receipt.members?.[0]?.slot, 'matched');
  }));

  it('preflight no-go: two members map to one slot (adoption-ambiguous, many-to-one)', withFixture(async (ctx) => {
    insertSlot(ctx.dbPath, { accountId: UUID_A, email: EMAIL });
    ctx.store.setActiveLogin('anthropic', UUID_A, 'auto', NOW);
    const receipt = await preflight(
      ctx,
      pool([uuidMember(UUID_A), emailMember(EMAIL)]),
      { blob: freshBlob() },
    );
    assert.equal(receipt.disposition, 'no-go');
    assert.equal(receipt.code, 'adoption-ambiguous');
    assert.deepEqual(receipt.members?.map((member) => member.slot), ['ambiguous', 'ambiguous']);
    assert.equal(receipt.members?.some((member) => member.active), false);
  }));

  it('preflight no-go: one email member matches two slots with the same email (adoption-ambiguous, one-to-many)', withFixture(async (ctx) => {
    insertSlot(ctx.dbPath, { accountId: UUID_A, email: EMAIL });
    insertSlot(ctx.dbPath, { accountId: UUID_B, email: EMAIL });
    ctx.store.setActiveLogin('anthropic', UUID_A, 'auto', NOW);
    const receipt = await preflight(ctx, pool([emailMember(EMAIL)]), { blob: freshBlob() });
    assert.equal(receipt.disposition, 'no-go');
    assert.equal(receipt.code, 'adoption-ambiguous');
    assert.equal(receipt.members?.[0]?.slot, 'ambiguous');
  }));

  it('preflight no-go: email member matches one live and one archived slot (adoption-ambiguous)', withFixture(async (ctx) => {
    insertSlot(ctx.dbPath, { accountId: UUID_A, email: EMAIL });
    insertSlot(ctx.dbPath, { accountId: UUID_B, email: EMAIL, archivedAt: NOW });
    ctx.store.setActiveLogin('anthropic', UUID_A, 'auto', NOW);
    const receipt = await preflight(ctx, pool([emailMember(EMAIL)]), { blob: freshBlob() });
    assert.equal(receipt.disposition, 'no-go');
    assert.equal(receipt.code, 'adoption-ambiguous');
    assert.equal(receipt.members?.[0]?.slot, 'ambiguous');
  }));

  it('preflight: email match is exact — case or whitespace variant is missing, not matched', withFixture(async (ctx) => {
    insertSlot(ctx.dbPath, { accountId: UUID_A, email: 'User@Example.com' });
    ctx.store.setActiveLogin('anthropic', UUID_A, 'auto', NOW);
    const wrongCase = await preflight(ctx, pool([emailMember('user@example.com')]), { blob: freshBlob() });
    assert.equal(wrongCase.code, 'adoption-slot-missing');
    assert.equal(wrongCase.members?.[0]?.slot, 'missing');
    const padded = await preflight(ctx, pool([emailMember('User@Example.com ')]));
    assert.equal(padded.members?.[0]?.slot, 'missing');
    const exact = await preflight(ctx, pool([emailMember('User@Example.com')]));
    assert.equal(exact.members?.[0]?.slot, 'matched');
    assert.equal(exact.disposition, 'go');
  }));

  it('preflight no-go: single match on a dead or archived slot (adoption-slot-unusable)', withFixture(async (ctx) => {
    insertSlot(ctx.dbPath, { accountId: UUID_A, dead: true });
    ctx.store.setActiveLogin('anthropic', UUID_A, 'auto', NOW);
    const dead = await preflight(ctx, pool([uuidMember(UUID_A)]), { blob: freshBlob() });
    assert.equal(dead.disposition, 'no-go');
    assert.equal(dead.code, 'adoption-slot-unusable');
    assert.equal(dead.members?.[0]?.slot, 'dead-or-archived');
    const db = new DatabaseSync(ctx.dbPath);
    db.prepare('UPDATE claude_slots SET dead = 0, archived_at = ? WHERE account_id = ?').run(NOW, UUID_A);
    db.close();
    const archived = await preflight(ctx, pool([uuidMember(UUID_A)]));
    assert.equal(archived.code, 'adoption-slot-unusable');
    assert.equal(archived.members?.[0]?.slot, 'dead-or-archived');
  }));

  it('preflight: claudeCodeActiveToken classes fresh, expiring, expired (inside 5-min buffer), expiry-unknown, unreadable', withFixture(async (ctx) => {
    insertSlot(ctx.dbPath, { accountId: UUID_A });
    ctx.store.setActiveLogin('anthropic', UUID_A, 'auto', NOW);
    const raw = pool([uuidMember(UUID_A)]);
    const fresh = await preflight(ctx, raw, { blob: claudeBlob(TOKEN, NOW + 90 * 60 * 1000) });
    assert.equal(fresh.claudeCodeActiveToken, 'fresh');
    const expiring = await preflight(ctx, raw, { blob: claudeBlob(TOKEN, NOW + 30 * 60 * 1000) });
    assert.equal(expiring.claudeCodeActiveToken, 'expiring');
    assert.equal(expiring.disposition, 'no-go');
    const expired = await preflight(ctx, raw, { blob: claudeBlob(TOKEN, NOW + 4 * 60 * 1000) });
    assert.equal(expired.claudeCodeActiveToken, 'expired');
    const unknown = await preflight(ctx, raw, { blob: claudeBlob(TOKEN) });
    assert.equal(unknown.claudeCodeActiveToken, 'expiry-unknown');
    const malformed = await preflight(ctx, raw, { blob: '{not-json' });
    assert.equal(malformed.claudeCodeActiveToken, 'unreadable');
    const throwing = await preflight(ctx, raw, { backend: throwingBackend(new Error('keychain-down')) });
    assert.equal(throwing.claudeCodeActiveToken, 'unreadable');
    assert.equal(throwing.disposition, 'no-go');
  }));

  it('preflight never leaks the Claude Code credential', withFixture(async (ctx) => {
    insertSlot(ctx.dbPath, { accountId: UUID_A });
    ctx.store.setActiveLogin('anthropic', UUID_A, 'auto', NOW);
    const iso = new Date(CANARY_EXPIRY).toISOString();
    const isoSeconds = iso.replace(/\.\d{3}Z$/, 'Z');
    const full = claudeBlob(CANARY_TOKEN, CANARY_EXPIRY);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')); };
    const captured: string[] = [];
    try {
      const runs: Array<{ now: number; blob?: string; backend?: KeychainBackend; token: string }> = [
        { now: CANARY_EXPIRY - 3 * HOUR, blob: full, token: 'fresh' },
        { now: CANARY_EXPIRY - 30 * 60 * 1000, blob: full, token: 'expiring' },
        { now: CANARY_EXPIRY - 4 * 60 * 1000, blob: full, token: 'expired' },
        {
          now: CANARY_EXPIRY - 3 * HOUR,
          blob: JSON.stringify({ claudeAiOauth: { accessToken: CANARY_TOKEN }, expiresAt: CANARY_EXPIRY }),
          token: 'expiry-unknown',
        },
        { now: NOW, blob: CANARY_TOKEN, token: 'unreadable' },
        { now: NOW, blob: '{', token: 'unreadable' },
        {
          now: NOW,
          backend: throwingBackend(new Error(`${CANARY_TOKEN} ${CANARY_EXPIRY} ${iso}`)),
          token: 'unreadable',
        },
      ];
      for (const run of runs) {
        let thrown = '';
        try {
          const receipt = await preflight(ctx, pool([uuidMember(UUID_A, CANARY_EXPIRY)]), {
            now: run.now,
            blob: run.blob,
            backend: run.backend,
          });
          assert.equal(receipt.claudeCodeActiveToken, run.token);
          captured.push(JSON.stringify(receipt), formatAnthropicPreflight(receipt, true), formatAnthropicPreflight(receipt, false));
        } catch (error) {
          thrown = dumpError(error);
          captured.push(thrown);
        }
      }
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    const text = [...captured, ...stdout, ...stderr].join('\n');
    assert.equal(text.includes(CANARY_TOKEN), false);
    assert.equal(text.includes(String(CANARY_EXPIRY)), false);
    assert.equal(text.includes(iso), false);
    assert.equal(text.includes(isoSeconds), false);
  }));

  it('preflight at QLB_OWNED: pool not-native, claude token still classified', withFixture(async (ctx) => {
    ctx.store.upsertMigration(PI_POOL_STORE, 'QLB_OWNED', '{}');
    writeFileSync(`${ctx.poolPath}.pre-qlb`, pool([uuidMember(UUID_A)]), { mode: 0o600 });
    ctx.backend.setSync(SERVICE, ACCOUNT, freshBlob());
    const receipt = await runAnthropicPreflight({
      dbPath: ctx.dbPath,
      poolFile: ctx.poolPath,
      backend: ctx.backend,
      now: NOW,
      account: ACCOUNT,
      paths: ctx.paths,
    });
    assert.deepEqual(receipt, {
      schemaVersion: 1,
      phase: 'preflight',
      disposition: 'go',
      pool: 'not-native',
      claudeCodeActiveToken: 'fresh',
    });
    assert.equal(existsSync(ctx.poolPath), false);
    assert.equal(existsSync(`${ctx.poolPath}.pre-qlb`), true);
  }));

  it('preflight writes nothing: journal, Keychain set spy (zero sets), staging and owner files unchanged; DB opened readOnly', withFixture(async (ctx) => {
    insertSlot(ctx.dbPath, { accountId: UUID_A });
    ctx.store.setActiveLogin('anthropic', UUID_A, 'auto', NOW);
    writeFileSync(ctx.poolPath, pool([uuidMember(UUID_A)]), { mode: 0o600 });
    writeFileSync(ctx.ownerPath, '{"owner":"untouched"}\n', { mode: 0o600 });
    writeFileSync(`${ctx.ownerPath}.staging`, '{"staging":"untouched"}\n', { mode: 0o600 });
    ctx.store.upsertMigration(PI_POOL_STORE, 'MIRRORED', '{"kept":true}');
    ctx.backend.setSync(SERVICE, ACCOUNT, freshBlob());
    const sets = { count: 0 };
    const setSync = ctx.backend.setSync.bind(ctx.backend);
    const set = ctx.backend.set.bind(ctx.backend);
    ctx.backend.setSync = (service, account, value) => {
      sets.count += 1;
      setSync(service, account, value);
    };
    ctx.backend.set = async (service, account, value) => {
      sets.count += 1;
      await set(service, account, value);
    };
    const journal = ctx.store.getMigration(PI_POOL_STORE)?.detail_json;
    const poolBytes = readFileSync(ctx.poolPath);
    const ownerBytes = readFileSync(ctx.ownerPath);
    const stagingBytes = readFileSync(`${ctx.ownerPath}.staging`);
    const receipt = await runAnthropicPreflight({
      dbPath: ctx.dbPath,
      poolFile: ctx.poolPath,
      backend: ctx.backend,
      now: NOW,
      account: ACCOUNT,
      paths: ctx.paths,
    });
    assert.equal(receipt.disposition, 'go');
    assert.equal(sets.count, 0);
    assert.equal(ctx.store.getMigration(PI_POOL_STORE)?.detail_json, journal);
    assert.deepEqual(readFileSync(ctx.poolPath), poolBytes);
    assert.deepEqual(readFileSync(ctx.ownerPath), ownerBytes);
    assert.deepEqual(readFileSync(`${ctx.ownerPath}.staging`), stagingBytes);
    const readOnly = openPreflightDatabase(ctx.dbPath);
    assert.throws(() => readOnly.prepare("INSERT INTO config (key, value) VALUES ('preflight', 'write')").run());
    readOnly.close();
    ctx.store.close();
    const checkpoint = new DatabaseSync(ctx.dbPath);
    checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    checkpoint.exec('PRAGMA journal_mode = DELETE');
    checkpoint.close();
    chmodSync(ctx.dbPath, 0o444);
    try {
      const again = await runAnthropicPreflight({
        dbPath: ctx.dbPath,
        poolFile: ctx.poolPath,
        backend: ctx.backend,
        now: NOW,
        account: ACCOUNT,
        paths: ctx.paths,
      });
      assert.equal(again.disposition, 'go');
    } finally {
      chmodSync(ctx.dbPath, 0o644);
    }
  }));

  it('preflight works while consume is CONSUMED', withFixture(async (ctx) => {
    insertSlot(ctx.dbPath, { accountId: UUID_A });
    ctx.store.setActiveLogin('anthropic', UUID_A, 'auto', NOW);
    ctx.store.upsertMigration(CSWAP_ANTHROPIC_STORE, CONSUME_STATE, '{}');
    const receipt = await preflight(ctx, pool([uuidMember(UUID_A)]), { blob: freshBlob() });
    assert.equal(ctx.store.getMigration(CSWAP_ANTHROPIC_STORE)?.state, CONSUME_STATE);
    assert.equal(receipt.disposition, 'go');
    const parsed = parseArgs([
      'node', 'qlb', 'migrate', 'receipt', '--provider', 'anthropic', '--phase', 'preflight', '--json',
      '--pool-file', ctx.poolPath, '--owner-file', ctx.ownerPath, '--db', ctx.dbPath,
      '--auth-json', join(ctx.dir, 'auth.json'),
    ]);
    assert.equal(parsed.cmd, 'migrate');
    if (parsed.cmd === 'migrate') assert.equal(parsed.phase, 'preflight');
  }));

  it('preflight output recursion: no forbidden value in JSON', withFixture(async (ctx) => {
    insertSlot(ctx.dbPath, { accountId: UUID_A, email: EMAIL });
    ctx.store.setActiveLogin('anthropic', UUID_A, 'auto', NOW);
    const expires = FRESH_EXPIRES;
    const raw = pool([{ id: 'pool-row-secret', email: EMAIL, name: 'Kept Name', credentials: oauth(expires) }]);
    const receipt = await preflight(ctx, raw, { blob: freshBlob() });
    const invalid = await preflight(ctx, pool([{ email: EMAIL, credentials: { type: 'oauth', access: 'bad-access', refresh: 'bad-refresh', expires: 'nope' } }]));
    assert.equal(invalid.code, 'source-membership-invalid');
    const texts = [
      formatAnthropicPreflight(receipt, true),
      formatAnthropicPreflight(receipt, false),
      formatAnthropicPreflight(invalid, true),
      formatAnthropicPreflight(invalid, false),
    ];
    const forbidden = [
      EMAIL, UUID_A, TOKEN, 'pool-access-token', 'pool-refresh-token', 'bad-access', 'bad-refresh',
      'Kept Name', 'pool-row-secret', String(expires), ctx.poolPath, ctx.dbPath, 'nope',
    ];
    for (const text of texts) {
      for (const secret of forbidden) assert.equal(text.includes(secret), false, secret);
    }
    assertAllowlisted(JSON.parse(formatAnthropicPreflight(receipt, true)));
    assertAllowlisted(JSON.parse(formatAnthropicPreflight(invalid, true)));
  }));

  it('schema tripwire: SCHEMA_VERSION is 6', () => {
    assert.equal(SCHEMA_VERSION, 6);
  });
});

function throwingBackend(error: Error): KeychainBackend {
  const fail = (): never => { throw error; };
  return {
    kind: 'test-memory',
    get: async () => fail(),
    set: async () => fail(),
    delete: async () => fail(),
    getSync: () => fail(),
    setSync: () => fail(),
    deleteSync: () => fail(),
  };
}

function dumpError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause === undefined ? '' : dumpError(error.cause);
  return `${error.name}\n${error.message}\n${error.stack ?? ''}\n${cause}`;
}

function assertAllowlisted(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === 'object') assertAllowlisted(item);
      else assert.match(String(item), /^member-\d{4}$/);
    }
    return;
  }
  assert.equal(typeof value, 'object');
  assert.ok(value);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    assert.match(key, /^(schemaVersion|phase|disposition|code|claudeCodeActiveToken|pool|count|aliases|members|alias|identityKind|slot|expiry|active)$/);
    if (key === 'aliases' || key === 'members') assertAllowlisted(item);
    else if (item !== null && typeof item === 'object') assert.fail(`nested ${key}`);
    else if (typeof item === 'string') {
      assert.match(item, /^(preflight|go|no-go|adoption-ambiguous|adoption-slot-missing|adoption-slot-unusable|source-membership-invalid|fresh|expiring|expired|expiry-unknown|unreadable|under-2h|none|not-native|matched|missing|ambiguous|dead-or-archived|email|accountUuid|member-\d{4})$/);
    } else assert.equal(typeof item === 'number' || typeof item === 'boolean', true);
  }
}
