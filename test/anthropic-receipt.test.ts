import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  formatAnthropicReceipt,
  projectAnthropicReceipt,
  readAnthropicReceiptSources,
  type AnthropicReceiptPhase,
} from '../src/anthropic-receipt';
import { SourceMembershipInvalidError } from '../src/anthropic-complete-set';
import { MockKeychain, qlbKeychainService } from '../src/keychain';
import { Migration, PI_POOL_STORE, stagingOwnerPath } from '../src/migration';
import { openStore, type Store } from '../src/store';

const ACCESS = 'access-token-secret-value';
const REFRESH = 'refresh-token-secret-value';
const EMAIL = '用户@example.com';
const UUID = '11111111-2222-4333-8444-555555555555';
const EMAIL_ID = 'pool-row-id-secret';
const UUID_ID = 'uuid-row-id-secret';
const EMAIL_NAME = 'Kept Display Name';
const UUID_NAME = 'Uuid Display Name';
const EXPIRES = 123456789;
const LEAK = 'nested-journal-leak-value';
const ALLOWED = /^(schemaVersion|phase|disposition|code|membership|count|aliases|buckets|success|refused|complete|stage|rehearse|commit|failure|source-membership-invalid|source-witness-unavailable|proof-unavailable|proof-stale|identity-mismatch|5h|7d|member-\d+)$/;
const PHASES: AnthropicReceiptPhase[] = ['stage', 'rehearse', 'commit', 'failure'];

function oauth(expires: number = EXPIRES) {
  return { type: 'oauth', access: ACCESS, refresh: REFRESH, expires };
}

function pool(accounts: unknown[]): string {
  return `${JSON.stringify({ accounts })}\n`;
}

function emailMember(expires: number = EXPIRES) {
  return { id: EMAIL_ID, name: EMAIL_NAME, email: EMAIL, credentials: oauth(expires) };
}

function uuidMember() {
  return { id: UUID_ID, name: UUID_NAME, accountUuid: UUID, credentials: oauth() };
}

function collect(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    out.add(value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.add(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.add(key);
      collect(item, out);
    }
  }
}

function assertNoEcho(receiptText: string, sources: unknown[]): void {
  const found = new Set<string>();
  for (const source of sources) collect(source, found);
  for (const secret of found) {
    if (secret.length < 4 || ALLOWED.test(secret)) continue;
    assert.equal(receiptText.includes(secret), false, secret);
  }
}

function assertAllowlisted(value: unknown): void {
  if (Array.isArray(value)) {
    assert.ok(value.length > 0);
    for (const item of value) assert.match(String(item), /^member-\d{4,}$/);
    return;
  }
  assert.equal(typeof value, 'object');
  assert.ok(value);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    assert.match(key, /^(schemaVersion|phase|disposition|code|membership|count|aliases|buckets)$/);
    if (key === 'aliases') assertAllowlisted(item);
    else if (key === 'buckets') {
      assert.ok(Array.isArray(item));
      for (const bucket of item) {
        assert.deepEqual(Object.keys(bucket as object).sort(), ['5h', '7d']);
        const readings = bucket as { '5h': unknown; '7d': unknown };
        assert.equal(typeof readings['5h'], 'number');
        assert.equal(typeof readings['7d'], 'number');
      }
    } else assert.equal(item !== null && typeof item === 'object', false);
  }
}

interface PoolCtx {
  dir: string;
  poolPath: string;
  ownerPath: string;
  authPath: string;
  store: Store;
  kc: MockKeychain;
  mig: Migration;
}

function withPool(raw: string, run: (ctx: PoolCtx) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-r1a-receipt-'));
  const poolPath = join(dir, 'anthropic-pool.json');
  const ownerPath = join(dir, 'qlb-owner.json');
  const authPath = join(dir, 'auth.json');
  writeFileSync(poolPath, raw, { mode: 0o600 });
  const store = openStore(join(dir, 'qlb.db'));
  const kc = new MockKeychain();
  const mig = new Migration(store, kc, poolPath, ownerPath, undefined, { authJsonPath: authPath });
  try {
    run({ dir, poolPath, ownerPath, authPath, store, kc, mig });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function sourcesOf(ctx: PoolCtx) {
  return readAnthropicReceiptSources(
    ctx.poolPath,
    ctx.ownerPath,
    ctx.store.getMigration(PI_POOL_STORE)?.detail_json,
  );
}

function receiptTexts(ctx: PoolCtx, phase: AnthropicReceiptPhase): { json: string; human: string; body: Record<string, unknown> } {
  const receipt = projectAnthropicReceipt(phase, sourcesOf(ctx));
  const json = formatAnthropicReceipt(receipt, true);
  return { json, human: formatAnthropicReceipt(receipt, false), body: JSON.parse(json) as Record<string, unknown> };
}

function echoSources(ctx: PoolCtx): unknown[] {
  const journal = JSON.parse(ctx.store.getMigration(PI_POOL_STORE)?.detail_json ?? 'null') as unknown;
  const stagingPath = stagingOwnerPath(ctx.ownerPath);
  const staging = existsSync(stagingPath) ? JSON.parse(readFileSync(stagingPath, 'utf8')) as unknown : null;
  const payloads = [EMAIL_ID, UUID_ID].flatMap((id, index) => {
    const account = index === 0 ? EMAIL : UUID_NAME;
    try {
      return [qlbKeychainService('anthropic', id), account, ctx.kc.getSync(qlbKeychainService('anthropic', id), account)];
    } catch {
      return [];
    }
  });
  return [JSON.parse(readFileSync(ctx.poolPath, 'utf8')), journal, staging, payloads, ctx.poolPath, ctx.ownerPath];
}

describe('anthropic migration receipt', () => {
  it('emits a stage success receipt only when the journal and staging bindings match the current pool', () => {
    withPool(pool([emailMember(), uuidMember()]), (ctx) => {
      ctx.mig.stage();
      const { body, json, human } = receiptTexts(ctx, 'stage');
      assert.deepEqual(body, {
        schemaVersion: 1,
        phase: 'stage',
        disposition: 'success',
        membership: 'complete',
        count: 2,
        aliases: ['member-0001', 'member-0002'],
      });
      assertAllowlisted(body);
      assert.equal(human.includes('membership: complete'), true);
      assert.equal(json.includes('resumeAction'), false);
      const original = readFileSync(ctx.poolPath);
      writeFileSync(ctx.poolPath, pool([emailMember(EXPIRES + 1)]));
      const drifted = receiptTexts(ctx, 'stage').body;
      assert.equal(drifted.disposition, 'refused');
      assert.equal('membership' in drifted, false);
      assert.equal('code' in drifted, false);
      writeFileSync(ctx.poolPath, original);
      const staged = JSON.parse(readFileSync(stagingOwnerPath(ctx.ownerPath), 'utf8')) as { binding?: { stagedAt?: number } };
      staged.binding!.stagedAt = (staged.binding?.stagedAt ?? 0) + 1;
      writeFileSync(stagingOwnerPath(ctx.ownerPath), JSON.stringify(staged));
      const mismatched = receiptTexts(ctx, 'stage').body;
      assert.deepEqual(mismatched, { schemaVersion: 1, phase: 'stage', disposition: 'refused' });
      assertNoEcho(JSON.stringify(mismatched), echoSources(ctx));
    });
  });

  it('does not echo source, journal, staging, or keychain values at any receipt depth', () => {
    withPool(pool([emailMember(), uuidMember()]), (ctx) => {
      ctx.mig.stage();
      const sources = sourcesOf(ctx);
      const journal = sources.journalDetail as { leak?: unknown };
      journal.leak = { nested: [LEAK, { token: ACCESS }] };
      const leaked = projectAnthropicReceipt('stage', sources);
      for (const phase of PHASES) {
        const receipt = phase === 'stage' ? leaked : projectAnthropicReceipt(phase, sources);
        for (const text of [formatAnthropicReceipt(receipt, true), formatAnthropicReceipt(receipt, false)]) {
          assertAllowlisted(JSON.parse(formatAnthropicReceipt(receipt, true)));
          assertNoEcho(text, [sources.journalDetail, sources.stagingDocument, echoSources(ctx), LEAK]);
        }
      }
      const binding = (sources.stagingDocument as { binding: Record<string, unknown> }).binding;
      binding.leak = LEAK;
      const hidden = formatAnthropicReceipt(projectAnthropicReceipt('stage', sources), true);
      assert.equal(JSON.parse(hidden).disposition, 'refused');
      assertNoEcho(hidden, [LEAK, sources.journalDetail, sources.stagingDocument, echoSources(ctx)]);
    });
  });

  it('refuses journal-only and staging-only state without a success receipt', () => {
    withPool(pool([emailMember()]), (ctx) => {
      ctx.mig.stage();
      const saved = sourcesOf(ctx);
      const journalOnly = projectAnthropicReceipt('stage', { ...saved, stagingDocument: null });
      const stagingOnly = projectAnthropicReceipt('stage', { ...saved, journalDetail: null });
      assert.deepEqual(journalOnly, { schemaVersion: 1, phase: 'stage', disposition: 'refused' });
      assert.deepEqual(stagingOnly, { schemaVersion: 1, phase: 'stage', disposition: 'refused' });
      assert.equal('code' in journalOnly, false);
      rmSync(stagingOwnerPath(ctx.ownerPath));
      assert.equal(receiptTexts(ctx, 'stage').body.disposition, 'refused');
      assert.equal(existsSync(ctx.ownerPath), false);
    });
  });

  it('reports source-membership-invalid and writes nothing when the initial pool is rejected', () => {
    const raw = pool([{ email: EMAIL, credentials: { type: 'oauth', access: ACCESS, refresh: REFRESH, expires: 'nope' } }]);
    withPool(raw, (ctx) => {
      assert.throws(
        () => ctx.mig.stage(),
        (error: unknown) => error instanceof SourceMembershipInvalidError && error.code === 'source-membership-invalid',
      );
      assert.equal(ctx.store.getMigration(PI_POOL_STORE), null);
      assert.equal(existsSync(stagingOwnerPath(ctx.ownerPath)), false);
      assert.equal(ctx.kc.listServices().length, 0);
      for (const phase of PHASES) {
        const text = formatAnthropicReceipt(projectAnthropicReceipt(phase, sourcesOf(ctx)), true);
        assert.deepEqual(JSON.parse(text), {
          schemaVersion: 1,
          phase,
          disposition: 'refused',
          code: 'source-membership-invalid',
        });
        assertNoEcho(text, [JSON.parse(raw), EMAIL, ACCESS, REFRESH, 'nope']);
      }
    });
  });

  it('keeps the prior recovery artifact and does not emit a success receipt after a failed restage', () => {
    withPool(pool([emailMember(), uuidMember()]), (ctx) => {
      ctx.mig.stage();
      const journal = ctx.store.getMigration(PI_POOL_STORE)?.detail_json ?? '';
      const staging = readFileSync(stagingOwnerPath(ctx.ownerPath));
      const payload = ctx.kc.getSync(qlbKeychainService('anthropic', EMAIL_ID), EMAIL);
      const invalid = pool([{ email: 'restage-secret@example.com', credentials: { type: 'oauth', access: ACCESS, refresh: REFRESH, expires: 'nope' } }]);
      writeFileSync(ctx.poolPath, invalid);
      assert.throws(
        () => ctx.mig.stage(),
        (error: unknown) => error instanceof SourceMembershipInvalidError && error.code === 'source-membership-invalid',
      );
      assert.equal(ctx.store.getMigration(PI_POOL_STORE)?.detail_json, journal);
      assert.deepEqual(readFileSync(stagingOwnerPath(ctx.ownerPath)), staging);
      assert.equal(ctx.kc.getSync(qlbKeychainService('anthropic', EMAIL_ID), EMAIL), payload);
      for (const phase of PHASES) {
        const body = receiptTexts(ctx, phase).body;
        assert.equal(body.disposition, 'refused');
        assert.equal(body.code, 'source-membership-invalid');
        assert.equal('membership' in body, false);
        assertNoEcho(JSON.stringify(body), [JSON.parse(invalid), JSON.parse(journal), 'restage-secret@example.com']);
      }
      assert.deepEqual(readFileSync(stagingOwnerPath(ctx.ownerPath)), staging);
    });
  });

  it('surfaces duplicate derived account ids as source-membership-invalid', () => {
    const duplicate = pool([
      { email: 'same@example.com', name: 'One', credentials: oauth() },
      { id: 'same@example.com', name: 'Two', accountUuid: '11111111-1111-4111-8111-111111111111', credentials: oauth() },
    ]);
    withPool(duplicate, (ctx) => {
      assert.throws(
        () => ctx.mig.stage(),
        (error: unknown) => error instanceof SourceMembershipInvalidError && error.code === 'source-membership-invalid',
      );
      assert.equal(ctx.store.getMigration(PI_POOL_STORE), null);
      assert.equal(existsSync(stagingOwnerPath(ctx.ownerPath)), false);
      for (const phase of PHASES) {
        const text = formatAnthropicReceipt(projectAnthropicReceipt(phase, sourcesOf(ctx)), true);
        assert.deepEqual(JSON.parse(text), {
          schemaVersion: 1,
          phase,
          disposition: 'refused',
          code: 'source-membership-invalid',
        });
        assertNoEcho(text, [JSON.parse(duplicate), 'same@example.com', '11111111-1111-4111-8111-111111111111']);
      }
    });
  });

  it('uses the plan proof-unavailable code for rehearse, commit, and failure without a success receipt', () => {
    withPool(pool([emailMember()]), (ctx) => {
      ctx.mig.stage();
      for (const phase of ['rehearse', 'commit', 'failure'] as const) {
        const body = receiptTexts(ctx, phase).body;
        assert.deepEqual(body, { schemaVersion: 1, phase, disposition: 'refused', code: 'proof-unavailable' });
        assertNoEcho(JSON.stringify(body), echoSources(ctx));
      }
      const status = ctx.mig.status();
      const statusJson = JSON.stringify(status);
      const digest = (JSON.parse(ctx.store.getMigration(PI_POOL_STORE)?.detail_json ?? '{}') as {
        binding: { completeSetCommitment: { digest: string } };
      }).binding.completeSetCommitment.digest;
      assert.equal(typeof status.resumeAction, 'string');
      assert.equal(statusJson.includes('"disposition"'), false);
      assert.equal(statusJson.includes(EMAIL), false);
      assert.equal(statusJson.includes('"label"'), false);
      assert.equal(statusJson.includes(digest), false);
      assert.equal(statusJson.includes('completeSetCommitment'), false);
      assert.equal(receiptTexts(ctx, 'stage').json.includes(EMAIL), false);
      assert.equal(receiptTexts(ctx, 'stage').json.includes(digest), false);
    });
  });

  it('prints rehearse buckets only from a complete proof and keeps commit and failure unavailable', () => {
    withPool(pool([emailMember(), uuidMember()]), (ctx) => {
      ctx.mig.stage();
      const detail = JSON.parse(ctx.store.getMigration(PI_POOL_STORE)?.detail_json ?? '{}') as {
        binding: { cycle: string; memberCount: number; aliases: string[]; identityKinds: string[] };
      };
      const binding = detail.binding;
      const hostile = 'Hostile Display Name';
      const proof = {
        version: 1,
        cycle: binding.cycle,
        provedAt: 50,
        memberCount: binding.memberCount,
        aliases: binding.aliases,
        members: binding.aliases.map((alias, index) => ({
          alias,
          identityKind: binding.identityKinds[index],
          hasProviderUuid: true,
          buckets: index === 0 ? { '5h': 11, '7d': 22 } : { '5h': 33, '7d': 44 },
        })),
      };
      ctx.store.upsertMigration(PI_POOL_STORE, 'VALIDATED', JSON.stringify({ ...detail, identityProof: proof }));
      const success = receiptTexts(ctx, 'rehearse');
      assert.deepEqual(success.body, {
        schemaVersion: 1,
        phase: 'rehearse',
        disposition: 'success',
        membership: 'complete',
        count: 2,
        aliases: ['member-0001', 'member-0002'],
        buckets: [{ '5h': 11, '7d': 22 }, { '5h': 33, '7d': 44 }],
      });
      assertAllowlisted(success.body);
      assert.equal(success.human.includes('buckets: 5h=11,7d=22;5h=33,7d=44'), true);
      for (const secret of [binding.cycle, EMAIL, UUID, ACCESS, REFRESH, EMAIL_ID, UUID_ID, EMAIL_NAME, UUID_NAME, hostile, 'hasProviderUuid', 'identityKind', 'provedAt', 'accountUuid']) {
        assert.equal(success.json.includes(secret), false, secret);
        assert.equal(success.human.includes(secret), false, secret);
      }
      for (const phase of ['commit', 'failure'] as const) {
        assert.deepEqual(receiptTexts(ctx, phase).body, {
          schemaVersion: 1, phase, disposition: 'refused', code: 'proof-stale',
        });
      }
      const smuggled = {
        ...proof,
        members: proof.members.map((member, index) => index === 0
          ? { ...member, buckets: { ...member.buckets, [`7d:${hostile}`]: 9 } }
          : member),
      };
      ctx.store.upsertMigration(PI_POOL_STORE, 'VALIDATED', JSON.stringify({ ...detail, identityProof: smuggled }));
      const hidden = receiptTexts(ctx, 'rehearse');
      assert.deepEqual(hidden.body, { schemaVersion: 1, phase: 'rehearse', disposition: 'refused', code: 'proof-unavailable' });
      assert.equal(hidden.json.includes(hostile), false);
      ctx.store.upsertMigration(PI_POOL_STORE, 'MIRRORED', JSON.stringify({
        ...detail,
        rehearseRefusal: { code: 'identity-mismatch' },
      }));
      const mismatch = receiptTexts(ctx, 'rehearse');
      assert.deepEqual(mismatch.body, { schemaVersion: 1, phase: 'rehearse', disposition: 'refused', code: 'identity-mismatch' });
      assertNoEcho(mismatch.json, [echoSources(ctx), EMAIL, UUID, hostile]);
      assert.equal(receiptTexts(ctx, 'commit').body.code, 'identity-mismatch');
      writeFileSync(ctx.poolPath, pool([{ email: EMAIL, credentials: { type: 'oauth', access: ACCESS, refresh: REFRESH, expires: 'nope' } }]));
      assert.equal(receiptTexts(ctx, 'rehearse').body.code, 'source-membership-invalid');
      assert.equal(receiptTexts(ctx, 'rehearse').json.includes('identity-mismatch'), false);
    });
  });
});

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [join(__dirname, '..', 'src', 'cli.js'), ...args], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: typeof failed.status === 'number' ? failed.status : 1,
      stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
      stderr: typeof failed.stderr === 'string' ? failed.stderr : '',
    };
  }
}

describe('qlb migrate receipt command', () => {
  it('prints the allowlisted receipt and does not write migration or credential files', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-r1a-receipt-cli-'));
    const poolPath = join(root, 'anthropic-pool.json');
    const ownerPath = join(root, 'qlb-owner.json');
    const dbPath = join(root, 'qlb.db');
    writeFileSync(poolPath, pool([emailMember()]), { mode: 0o600 });
    const store = openStore(dbPath);
    const mig = new Migration(store, new MockKeychain(), poolPath, ownerPath, undefined, { authJsonPath: join(root, 'auth.json') });
    mig.stage();
    const journal = store.getMigration(PI_POOL_STORE)?.detail_json ?? '';
    const staging = readFileSync(stagingOwnerPath(ownerPath));
    store.close();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      QLB_TEST_MODE: '1',
      QLB_HOME: root,
      HOME: root,
      QLB_DB_PATH: dbPath,
      QLB_CONFIG_PATH: join(root, 'config.json'),
      QLB_PI_AUTH_JSON_PATH: join(root, 'auth.json'),
      QLB_ANTHROPIC_POOL_PATH: join(root, 'missing-pool.json'),
      QLB_PLUGINS_DIR: join(root, 'plugins'),
    };
    mkdirSync(join(root, 'plugins'), { recursive: true });
    const before = filesUnder(root);
    const args = ['migrate', 'receipt', '--phase', 'stage', '--pool-file', poolPath, '--owner-file', ownerPath, '--db', dbPath];
    const json = runCli([...args, '--json'], env);
    const human = runCli(args, env);
    const missingPhase = runCli(['migrate', 'receipt', '--pool-file', poolPath, '--owner-file', ownerPath, '--db', dbPath], env);
    const otherProvider = runCli(['migrate', 'receipt', '--provider', 'xai', '--phase', 'stage', '--json'], env);
    const status = runCli(['migrate', 'status', '--json', '--pool-file', poolPath, '--owner-file', ownerPath, '--db', dbPath], env);
    assert.equal(json.status, 0);
    assert.equal(human.status, 0);
    const body = JSON.parse(json.stdout) as Record<string, unknown>;
    assert.deepEqual(body, {
      schemaVersion: 1,
      phase: 'stage',
      disposition: 'success',
      membership: 'complete',
      count: 1,
      aliases: ['member-0001'],
    });
    assert.equal(human.stdout.includes(EMAIL), false);
    assert.equal(human.stdout.includes('membership: complete'), true);
    assert.equal(missingPhase.status, 1);
    assert.equal(missingPhase.stdout, '');
    assert.match(missingPhase.stderr, /--phase must be stage\|rehearse\|commit\|failure/);
    assert.equal(otherProvider.status, 1);
    assert.equal(otherProvider.stdout, '');
    assert.match(otherProvider.stderr, /--provider must be anthropic/);
    const statusBody = JSON.parse(status.stdout) as Record<string, unknown>;
    assert.equal(typeof statusBody.resumeAction, 'string');
    assert.equal('disposition' in statusBody, false);
    const digest = (JSON.parse(journal) as { binding: { completeSetCommitment: { digest: string } } }).binding.completeSetCommitment.digest;
    assert.equal(JSON.stringify(statusBody).includes(EMAIL), false);
    assert.equal(JSON.stringify(statusBody).includes('"label"'), false);
    assert.equal(status.stdout.includes(digest), false);
    assert.equal(status.stdout.includes('completeSetCommitment'), false);
    assert.equal(json.stdout.includes(EMAIL), false);
    const reopened = openStore(dbPath);
    try {
      assert.equal(reopened.getMigration(PI_POOL_STORE)?.detail_json, journal);
    } finally {
      reopened.close();
    }
    assert.deepEqual(readFileSync(stagingOwnerPath(ownerPath)), staging);
    const added = filesUnder(root).filter((path) => !before.includes(path) && !path.endsWith('-wal') && !path.endsWith('-shm'));
    assert.deepEqual(added, []);
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the staging file stage writes when --owner-file is not qlb-owner.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-r1a-receipt-owner-'));
    const poolPath = join(root, 'anthropic-pool.json');
    const ownerPath = join(root, 'custom', 'not-the-map.json');
    const dbPath = join(root, 'qlb.db');
    mkdirSync(join(root, 'custom'), { recursive: true });
    writeFileSync(poolPath, pool([emailMember()]), { mode: 0o600 });
    const store = openStore(dbPath);
    new Migration(store, new MockKeychain(), poolPath, ownerPath, undefined, { authJsonPath: join(root, 'auth.json') }).stage();
    store.close();
    const mapStaging = join(root, 'custom', 'qlb-owner.json.staging');
    assert.equal(existsSync(mapStaging), true);
    assert.equal(existsSync(`${ownerPath}.staging`), false);
    const result = runCli(
      ['migrate', 'receipt', '--phase', 'stage', '--json', '--pool-file', poolPath, '--owner-file', ownerPath, '--db', dbPath],
      {
        ...process.env,
        QLB_TEST_MODE: '1',
        QLB_HOME: root,
        HOME: root,
        QLB_DB_PATH: dbPath,
        QLB_CONFIG_PATH: join(root, 'config.json'),
        QLB_PI_AUTH_JSON_PATH: join(root, 'auth.json'),
        QLB_ANTHROPIC_POOL_PATH: join(root, 'missing-pool.json'),
        QLB_PLUGINS_DIR: join(root, 'plugins'),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout) as { disposition: string }).disposition, 'success');
    assert.equal(existsSync(`${ownerPath}.staging`), false);
    rmSync(root, { recursive: true, force: true });
  });
});
