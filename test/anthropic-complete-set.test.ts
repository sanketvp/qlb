import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  admitAnthropicCompleteSet,
  encodeCompleteSetPreimage,
  SourceMembershipInvalidError,
  type CompleteSetMemberInput,
} from '../src/anthropic-complete-set';
import { MockKeychain, qlbKeychainService } from '../src/keychain';
import { Migration, PI_POOL_STORE, stagingOwnerPath, type OwnerFile } from '../src/migration';
import { openStore, type Store } from '../src/store';

const MAX_EXPIRY = Number.MAX_SAFE_INTEGER;
const HIGH = '\uD800';
const LOW = '\uDC00';

function sha256Base64Url(hex: string): string {
  return createHash('sha256').update(Buffer.from(hex, 'hex')).digest('base64url');
}

function pool(accounts: unknown): string {
  return `${JSON.stringify({ accounts })}\n`;
}

function oauth(expires: number, access = 'distinct-access-token', refresh = 'distinct-refresh-token') {
  return { type: 'oauth', access, refresh, expires };
}

function emailMember(identity: string, expires: number, fields: Record<string, unknown> = {}) {
  return { id: 'kept-id', name: 'Kept Name', ...fields, email: identity, credentials: oauth(expires) };
}

function uuidMember(identity: string, expires: number, fields: Record<string, unknown> = {}) {
  return { id: 'kept-id', name: 'Kept Name', ...fields, accountUuid: identity, credentials: oauth(expires) };
}

const VECTORS: Array<{ name: string; members: CompleteSetMemberInput[]; preimageHex: string; digest: string }> = [
  {
    name: 'minimal email, expiry 0',
    members: [{ ordinal: 0, expires: 0, identityKind: 'email', identity: 'a' }],
    preimageHex: '00000023716c623a616e7468726f7069633a706f6f6c2d636f6d706c6574652d7365743a76310000000001000000000101010000000000000000010000000161',
    digest: 'YQc5LJQ-tV4NFb7v5H7_x4fnY-L5M2-k7j7xo8dM1ro',
  },
  {
    name: 'two members',
    members: [
      { ordinal: 0, expires: 0, identityKind: 'email', identity: 'a' },
      { ordinal: 1, expires: 1, identityKind: 'accountUuid', identity: 'b' },
    ],
    preimageHex: '00000023716c623a616e7468726f7069633a706f6f6c2d636f6d706c6574652d7365743a76310000000002000000000101010000000000000000010000000161000000010101010000000000000001020000000162',
    digest: '0Y70vbsx6P9lXMA54rNY5qTTGlvQYGn-LFj7HKs76iA',
  },
  {
    name: 'reordered members',
    members: [
      { ordinal: 0, expires: 1, identityKind: 'accountUuid', identity: 'b' },
      { ordinal: 1, expires: 0, identityKind: 'email', identity: 'a' },
    ],
    preimageHex: '00000023716c623a616e7468726f7069633a706f6f6c2d636f6d706c6574652d7365743a76310000000002000000000101010000000000000001020000000162000000010101010000000000000000010000000161',
    digest: 'gEtvBbE4IueQ2HrhJ6OAyDs5DmOZ29VIOHaOy5ROA2o',
  },
  {
    name: 'maximum expiry',
    members: [{ ordinal: 0, expires: MAX_EXPIRY, identityKind: 'email', identity: 'a' }],
    preimageHex: '00000023716c623a616e7468726f7069633a706f6f6c2d636f6d706c6574652d7365743a7631000000000100000000010101001fffffffffffff010000000161',
    digest: 'BzUrVCJmPSlhY860a_1_IKalVxVly7--s_dS_zDk2Fk',
  },
  {
    name: 'non-ascii identity',
    members: [{ ordinal: 0, expires: 0, identityKind: 'email', identity: '用户' }],
    preimageHex: '00000023716c623a616e7468726f7069633a706f6f6c2d636f6d706c6574652d7365743a763100000000010000000001010100000000000000000100000006e794a8e688b7',
    digest: 'QNBMBJr6GiK9t_aFFcHK26k58X5IXTuQUNfv7Q7_9dc',
  },
  {
    name: 'nfc identity',
    members: [{ ordinal: 0, expires: 0, identityKind: 'email', identity: 'é' }],
    preimageHex: '00000023716c623a616e7468726f7069633a706f6f6c2d636f6d706c6574652d7365743a763100000000010000000001010100000000000000000100000002c3a9',
    digest: 'q7UfMxXSwD_QPf5RFlktuMm0ZBjdDVVfe1aqu9KMZqo',
  },
  {
    name: 'nfd identity',
    members: [{ ordinal: 0, expires: 0, identityKind: 'email', identity: 'e\u0301' }],
    preimageHex: '00000023716c623a616e7468726f7069633a706f6f6c2d636f6d706c6574652d7365743a76310000000001000000000101010000000000000000010000000365cc81',
    digest: 'L_Gy7JIVJ6lI-IKkVCSWMExRnGn4LFDhSwwoTnXf6VE',
  },
];

const MUTATIONS: Array<{ name: string; preimageHex: string; digest: string }> = [
  { name: 'member-count', preimageHex: '00000023716c623a616e7468726f7069633a706f6f6c2d636f6d706c6574652d7365743a76310000000002000000000101010000000000000000010000000161', digest: 'R2IyMxbM_XfaK1i_qe-EzelTcu6n3FZRIN7e9TuRJyc' },
  { name: 'ordinal', preimageHex: '00000023716c623a616e7468726f7069633a706f6f6c2d636f6d706c6574652d7365743a76310000000001000000010101010000000000000000010000000161', digest: 'DgUQceA60tc11bQGvhfVN1RJNWyU6623t24RGZAlaLk' },
  { name: 'oauth-tag', preimageHex: '00000023716c623a616e7468726f7069633a706f6f6c2d636f6d706c6574652d7365743a76310000000001000000000201010000000000000000010000000161', digest: 'fsJACV93hzsUb9HgeBa1SgdjYQWm7F-yRc-KBlyi33k' },
  { name: 'access-tag', preimageHex: '00000023716c623a616e7468726f7069633a706f6f6c2d636f6d706c6574652d7365743a76310000000001000000000100010000000000000000010000000161', digest: '8QkDSQDWIR5GHY0jFpkhX91HMAt4VCA-59haWmmxMYY' },
  { name: 'refresh-tag', preimageHex: '00000023716c623a616e7468726f7069633a706f6f6c2d636f6d706c6574652d7365743a76310000000001000000000101000000000000000000010000000161', digest: 'ilduq-PQ9kPszKuwIywIVC5Drfhz5D3jQdYM_S19aA0' },
  { name: 'expires', preimageHex: '00000023716c623a616e7468726f7069633a706f6f6c2d636f6d706c6574652d7365743a76310000000001000000000101010000000000000001010000000161', digest: 'BVmIlc7cJJ2NYSZ58hXtPTyEEz_QQdagtEvW8U4wrRo' },
  { name: 'identity-kind', preimageHex: '00000023716c623a616e7468726f7069633a706f6f6c2d636f6d706c6574652d7365743a76310000000001000000000101010000000000000000020000000161', digest: 'IgKjJe0AKOOicYGjW8_YNnAab2rbX7ycSZeTQi9ypY8' },
  { name: 'identity-bytes', preimageHex: '00000023716c623a616e7468726f7069633a706f6f6c2d636f6d706c6574652d7365743a76310000000001000000000101010000000000000000010000000162', digest: 'n12lmkl1KcmJNSZt7Xfy6iIJNUTS5e8H3UV7P7yJUJ4' },
];

function withPool(raw: string, run: (ctx: {
  store: Store;
  kc: MockKeychain;
  mig: Migration;
  ownerPath: string;
  authPath: string;
  poolPath: string;
  before: Buffer;
}) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-complete-set-'));
  const poolPath = join(dir, 'anthropic-pool.json');
  const ownerPath = join(dir, 'qlb-owner.json');
  const authPath = join(dir, 'auth.json');
  writeFileSync(poolPath, raw, { mode: 0o600 });
  const before = readFileSync(poolPath);
  const store = openStore(join(dir, 'qlb.db'));
  const kc = new MockKeychain();
  const mig = new Migration(store, kc, poolPath, ownerPath, undefined, { authJsonPath: authPath });
  try {
    run({ store, kc, mig, ownerPath, authPath, poolPath, before });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertUntouched(ctx: {
  store: Store;
  kc: MockKeychain;
  ownerPath: string;
  authPath: string;
  poolPath: string;
  before: Buffer;
}, leaked?: { id: string; label: string }): void {
  assert.equal(ctx.store.getMigration(PI_POOL_STORE), null);
  assert.deepEqual(ctx.store.listAccounts(), []);
  assert.equal(existsSync(stagingOwnerPath(ctx.ownerPath)), false);
  assert.equal(existsSync(`${ctx.authPath}.lock`), false);
  assert.deepEqual(readFileSync(ctx.poolPath), ctx.before);
  if (leaked) {
    assert.throws(() => ctx.kc.getSync(qlbKeychainService('anthropic', leaked.id), leaked.label));
  }
}

const STAGE_WITNESS = {
  minimal: 'n1BGi3Q0XTct2IOb9D-m1Vwxp0UsODqXIp5Lbq28n3g',
  two: 'Zmm75qtpTYlQ3V0Whq3i7yV8HHAUsefer_1a14HC_tY',
  reordered: '60ZEM2FP77_v03ibQoNFDDgT5iUA6KsgUPrUL6ndDEA',
  max: 'j3zBI0XZ8VmRxqAQQP_WMNXktg-6C3bpfZ3OtUQh4Ug',
  rollback: 'GbVskH-bHchv3WLF-87vgksQkQS0IZA8fCGZNu-hWas',
} as const;

function storedDetail(store: Store): Record<string, unknown> {
  return JSON.parse(store.getMigration(PI_POOL_STORE)?.detail_json ?? 'null') as Record<string, unknown>;
}

function storedBinding(store: Store): NonNullable<OwnerFile['binding']> {
  const binding = storedDetail(store).binding as OwnerFile['binding'];
  if (!binding?.completeSetCommitment) throw new Error('stored binding missing');
  return binding;
}

function assertWitness(store: Store, digest: string): void {
  assert.deepEqual(storedDetail(store).sourceWitness, { version: 1, algorithm: 'sha256', digest });
}

function assertRejected(raw: string, leaked?: { id: string; label: string }): void {
  withPool(raw, (ctx) => {
    assert.throws(() => ctx.mig.stage(), (error: unknown) => error instanceof SourceMembershipInvalidError
      && error.code === 'source-membership-invalid');
    assertUntouched(ctx, leaked);
  });
}

describe('anthropic complete-set binding', () => {
  it('matches literal complete-set preimages and base64url digests', () => {
    const minimal = VECTORS[0]!;
    for (const vector of VECTORS) {
      assert.equal(encodeCompleteSetPreimage(vector.members).toString('hex'), vector.preimageHex, vector.name);
      assert.equal(sha256Base64Url(vector.preimageHex), vector.digest, vector.name);
    }
    assert.notEqual(VECTORS[5]!.digest, VECTORS[6]!.digest);
    const minimalBytes = Buffer.from(minimal.preimageHex, 'hex');
    for (const mutation of MUTATIONS) {
      const mutated = Buffer.from(mutation.preimageHex, 'hex');
      const changed = [...mutated].filter((byte, index) => byte !== minimalBytes[index]).length;
      assert.equal(changed, 1, mutation.name);
      assert.equal(sha256Base64Url(mutation.preimageHex), mutation.digest, mutation.name);
      assert.notEqual(mutation.digest, minimal.digest, mutation.name);
    }
  });

  it('admits email-only and accountUuid-only members and excludes source values from the binding', () => {
    const emailOnly = admitAnthropicCompleteSet(pool([emailMember('a', 0)]));
    const uuidOnly = admitAnthropicCompleteSet(pool([uuidMember('b', 1)]));
    assert.deepEqual(emailOnly.commitment, { version: 1, memberCount: 1, digest: VECTORS[0]!.digest });
    assert.deepEqual(emailOnly.aliases, ['member-0001']);
    assert.deepEqual(emailOnly.identityKinds, ['email']);
    assert.deepEqual(uuidOnly.identityKinds, ['accountUuid']);
    const distinct = admitAnthropicCompleteSet(pool([emailMember('distinct-identity@example.com', 0)]));
    const rebound = JSON.stringify({
      aliases: distinct.aliases,
      identityKinds: distinct.identityKinds,
      completeSetCommitment: distinct.commitment,
    });
    assert.equal(rebound.includes('distinct-identity@example.com'), false);
    assert.equal(rebound.includes('distinct-access-token'), false);
    assert.equal(rebound.includes('distinct-refresh-token'), false);
    assert.equal(rebound.includes('kept-id'), false);
    const sameBytes = admitAnthropicCompleteSet(pool([
      emailMember('same', 0, { id: 'email-row' }),
      uuidMember('same', 1, { id: 'uuid-row' }),
    ]));
    assert.deepEqual(sameBytes.identityKinds, ['email', 'accountUuid']);
    const spaced = admitAnthropicCompleteSet(pool([emailMember(' a ', 0)]));
    assert.notEqual(spaced.commitment.digest, emailOnly.commitment.digest);
  });

  it('rejects every invalid membership, expiry boundary, and unpaired surrogate before any write', () => {
    const valid = emailMember('kept@example.com', 0, { id: 'kept' });
    const leaked = { id: 'kept', label: 'kept@example.com' };
    const invalidMembers = [
      null,
      [],
      'member',
      { id: 'only-id', name: 'Only', credentials: oauth(0) },
      { email: 'a@b.c', accountUuid: 'uuid', credentials: oauth(0) },
      { email: '', credentials: oauth(0) },
      { accountUuid: '', credentials: oauth(0) },
      { email: 'a@b.c' },
      { email: 'a@b.c', credentials: [] },
      { email: 'a@b.c', credentials: null },
      { email: 'a@b.c', credentials: { access: 'a', refresh: 'r', expires: 0 } },
      { email: 'a@b.c', credentials: { type: 'OAuth', access: 'a', refresh: 'r', expires: 0 } },
      { email: 'a@b.c', credentials: { type: 'oauth', refresh: 'r', expires: 0 } },
      { email: 'a@b.c', credentials: { type: 'oauth', access: '', refresh: 'r', expires: 0 } },
      { email: 'a@b.c', credentials: { type: 'oauth', access: 1, refresh: 'r', expires: 0 } },
      { email: 'a@b.c', credentials: { type: 'oauth', access: 'a', expires: 0 } },
      { email: 'a@b.c', credentials: { type: 'oauth', access: 'a', refresh: '', expires: 0 } },
      { email: 'a@b.c', credentials: { type: 'oauth', access: 'a', refresh: 'r' } },
      { email: 'a@b.c', credentials: { type: 'oauth', access: 'a', refresh: 'r', expires: '1' } },
      { email: 'a@b.c', credentials: { type: 'oauth', access: 'a', refresh: 'r', expires: -1 } },
      { email: 'a@b.c', credentials: { type: 'oauth', access: 'a', refresh: 'r', expires: 1.5 } },
      { email: 'a@b.c', credentials: { type: 'oauth', access: 'a', refresh: 'r', expires: null } },
      { email: 'a@b.c', credentials: { type: 'oauth', access: 'a', refresh: 'r', expires: MAX_EXPIRY + 1 } },
      { email: 'a@b.c', credentials: { type: 'oauth', access: 'a', refresh: 'r', expires: 1e20 } },
      { email: HIGH, credentials: oauth(0) },
      { email: LOW, credentials: oauth(0) },
      { accountUuid: HIGH, credentials: oauth(0) },
      { accountUuid: LOW, credentials: oauth(0) },
      { email: 'a@b.c', credentials: { type: 'oauth', access: HIGH, refresh: 'r', expires: 0 } },
      { email: 'a@b.c', credentials: { type: 'oauth', access: LOW, refresh: 'r', expires: 0 } },
      { email: 'a@b.c', credentials: { type: 'oauth', access: 'a', refresh: HIGH, expires: 0 } },
      { email: 'a@b.c', credentials: { type: 'oauth', access: 'a', refresh: LOW, expires: 0 } },
    ];
    for (const member of invalidMembers) assertRejected(pool([member]));
    for (const member of invalidMembers) assertRejected(pool([valid, member]), leaked);
    for (const raw of [
      '{}',
      '{"accounts":null}',
      '{"accounts":{}}',
      '{"accounts":[]}',
      '[]',
      'null',
      '{',
      '{"accounts":[{"email":"a@b.c","credentials":{"type":"oauth","access":"a","refresh":"r","expires":NaN}}]}',
      '{"accounts":[{"email":"a@b.c","credentials":{"type":"oauth","access":"a","refresh":"r","expires":Infinity}}]}',
      '{"accounts":[{"email":"a@b.c","credentials":{"type":"oauth","access":"a","refresh":"r","expires":-Infinity}}]}',
    ]) assertRejected(raw);
    assertRejected(pool([emailMember('same@example.com', 0), emailMember('same@example.com', 1)]));
    assert.throws(
      () => encodeCompleteSetPreimage([{ ordinal: 0, expires: Number.NaN, identityKind: 'email', identity: 'a' }]),
      (error: unknown) => error instanceof SourceMembershipInvalidError,
    );
    assert.throws(
      () => encodeCompleteSetPreimage([{ ordinal: 0, expires: 0, identityKind: 'email', identity: HIGH }]),
      (error: unknown) => error instanceof SourceMembershipInvalidError,
    );
  });

  it('stores one binding on the journal and the staging record', () => {
    const multiple = pool([emailMember('a', 0, { id: 'id-a', name: 'Name A' }), uuidMember('b', 1, { id: 'id-b', name: 'Name B' })]);
    const reordered = pool([uuidMember('b', 1, { id: 'id-b', name: 'Name B' }), emailMember('a', 0, { id: 'id-a', name: 'Name A' })]);
    let firstDigest = '';
    withPool(multiple, (ctx) => {
      const status = ctx.mig.stage();
      const detail = status.detail;
      const binding = storedBinding(ctx.store);
      const staged = JSON.parse(readFileSync(stagingOwnerPath(ctx.ownerPath), 'utf8')) as OwnerFile;
      assert.deepEqual(staged.binding, binding);
      assert.equal(JSON.stringify(status).includes(binding.completeSetCommitment.digest), false);
      assert.equal(JSON.stringify(status).includes('completeSetCommitment'), false);
      assert.equal(binding?.version, 1);
      assert.equal(binding?.cycle, detail.authBackupCycle);
      assert.equal(binding?.stagedAt, detail.stagedAt);
      assert.equal(binding?.stagedAt, staged.stagedAt);
      assert.equal(binding?.memberCount, 2);
      assert.deepEqual(binding?.aliases, ['member-0001', 'member-0002']);
      assert.deepEqual(binding?.identityKinds, ['email', 'accountUuid']);
      assert.deepEqual(binding?.completeSetCommitment, { version: 1, memberCount: 2, digest: VECTORS[1]!.digest });
      assertWitness(ctx.store, STAGE_WITNESS.two);
      assert.equal('sourceWitness' in detail, false);
      assert.equal(JSON.stringify(status).includes(STAGE_WITNESS.two), false);
      assert.equal(JSON.stringify(staged).includes('sourceWitness'), false);
      assert.equal(JSON.stringify(staged).includes(STAGE_WITNESS.two), false);
      const journal = ctx.store.getMigration(PI_POOL_STORE)?.detail_json ?? '';
      assert.equal(journal.includes('distinct-access-token'), false);
      assert.equal(journal.includes('distinct-refresh-token'), false);
      assert.deepEqual(detail.qlbAccountIds, ['id-a', 'id-b']);
      assert.deepEqual(staged.qlbAccountIds, ['id-a', 'id-b']);
      assert.equal(staged.accounts[0]?.label, 'a');
      assert.equal(staged.accounts[1]?.label, 'Name B');
      assert.equal(staged.accounts[0]?.fingerprint, createHash('sha256').update('distinct-refresh-token', 'utf8').digest('hex'));
      firstDigest = binding?.completeSetCommitment.digest ?? '';
      assert.equal(existsSync(`${ctx.authPath}.lock`), false);
    });
    withPool(reordered, (ctx) => {
      ctx.mig.stage();
      const binding = storedBinding(ctx.store);
      assert.deepEqual(binding?.aliases, ['member-0001', 'member-0002']);
      assert.deepEqual(binding?.identityKinds, ['accountUuid', 'email']);
      assert.equal(binding?.completeSetCommitment.digest, VECTORS[2]!.digest);
      assertWitness(ctx.store, STAGE_WITNESS.reordered);
      assert.notEqual(binding?.completeSetCommitment.digest, firstDigest);
    });
    withPool(pool([emailMember('a', 0)]), (ctx) => {
      ctx.mig.stage();
      assert.equal(storedBinding(ctx.store).completeSetCommitment.digest, VECTORS[0]!.digest);
      assertWitness(ctx.store, STAGE_WITNESS.minimal);
      assert.equal(JSON.stringify(ctx.mig.status()).includes(VECTORS[0]!.digest), false);
      assert.equal(JSON.stringify(ctx.mig.status()).includes(STAGE_WITNESS.minimal), false);
    });
    withPool(pool([emailMember('a', MAX_EXPIRY)]), (ctx) => {
      ctx.mig.stage();
      assert.equal(storedBinding(ctx.store).completeSetCommitment.digest, VECTORS[3]!.digest);
      assertWitness(ctx.store, STAGE_WITNESS.max);
    });
  });

  it('rejects two eligible members that derive the same account id before any write', () => {
    assertRejected(pool([
      { email: 'same@example.com', name: 'One', credentials: oauth(0) },
      uuidMember('11111111-1111-4111-8111-111111111111', 1, { id: 'same@example.com', name: 'Two' }),
    ]), { id: 'same@example.com', label: 'same@example.com' });
  });

  it('removes binding from the journal when a staged pool is rolled back', () => {
    withPool(pool([emailMember('a@example.com', 0, { id: 'acct-a', name: 'A' })]), (ctx) => {
      const staged = ctx.mig.stage();
      assert.equal(typeof staged.detail.binding, 'object');
      assertWitness(ctx.store, STAGE_WITNESS.rollback);
      assert.equal('sourceWitness' in staged.detail, false);
      const rolled = ctx.mig.rollback();
      assert.equal(rolled.state, 'NATIVE');
      assert.equal(rolled.detail.rolledBackFrom, 'pre-commit');
      assert.equal(Object.hasOwn(rolled.detail, 'binding'), false);
      assert.equal(Object.hasOwn(rolled.detail, 'sourceWitness'), false);
      assert.equal(existsSync(stagingOwnerPath(ctx.ownerPath)), false);
      const stored = JSON.parse(ctx.store.getMigration(PI_POOL_STORE)!.detail_json) as Record<string, unknown>;
      assert.equal(Object.hasOwn(stored, 'binding'), false);
      assert.equal(Object.hasOwn(stored, 'sourceWitness'), false);
      assert.equal(JSON.stringify(stored).includes(STAGE_WITNESS.rollback), false);
    });
  });
});
