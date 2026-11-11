import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  encodeCompleteSetPreimage,
  encodeSourceWitnessPreimage,
  sourceWitnessForMembers,
  SourceMembershipInvalidError,
  type SourceWitnessMemberInput,
} from '../src/anthropic-complete-set';
import {
  formatAnthropicReceipt,
  projectAnthropicReceipt,
  type AnthropicReceiptPhase,
} from '../src/anthropic-receipt';
import { MockKeychain } from '../src/keychain';
import { Migration, PI_POOL_STORE, preQlbPath, sidecarPath, stagingOwnerPath } from '../src/migration';
import { legacyPiAuthBackupPath, piAuthBackupPath } from '../src/pi-auth-backup';
import { openStore, type Store } from '../src/store';

const HIGH = '\uD800';
const LOW = '\uDC00';
const SECRET = 'witness-secret-access-token';

function sha256Base64Url(hex: string): string {
  return createHash('sha256').update(Buffer.from(hex, 'hex')).digest('base64url');
}

function byteDiff(left: Buffer, right: Buffer): number {
  const length = Math.max(left.length, right.length);
  let changed = 0;
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) changed += 1;
  }
  return changed;
}

const VECTORS: Array<{ name: string; members: SourceWitnessMemberInput[]; preimageHex: string; digest: string }> = [
  {
    name: 'minimal email, expiry 0',
    members: [{ ordinal: 0, expires: 0, identityKind: 'email', identity: 'a', access: 'A', refresh: 'R' }],
    preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a7631000000000100000000010100000001410100000001520000000000000000010000000161',
    digest: '2jpViZeqVSM6-Od1WFAeiQICkghk9jhkzDvuSH1RjBU',
  },
  {
    name: 'two members',
    members: [
      { ordinal: 0, expires: 0, identityKind: 'email', identity: 'a', access: 'A', refresh: 'R' },
      { ordinal: 1, expires: 1, identityKind: 'accountUuid', identity: 'b', access: 'B', refresh: 'S' },
    ],
    preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a763100000000020000000001010000000141010000000152000000000000000001000000016100000001010100000001420100000001530000000000000001020000000162',
    digest: 'nDeDaKTEdOSOTYtFufdpijA6jrvgIIzuXMEDyIeHljo',
  },
  {
    name: 'reordered members',
    members: [
      { ordinal: 0, expires: 1, identityKind: 'accountUuid', identity: 'b', access: 'B', refresh: 'S' },
      { ordinal: 1, expires: 0, identityKind: 'email', identity: 'a', access: 'A', refresh: 'R' },
    ],
    preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a763100000000020000000001010000000142010000000153000000000000000102000000016200000001010100000001410100000001520000000000000000010000000161',
    digest: 'TICA8aa_I7yoiBm5bHcHOTEofvvFu7AcOYqAlu3odfk',
  },
  {
    name: 'maximum expiry',
    members: [{ ordinal: 0, expires: Number.MAX_SAFE_INTEGER, identityKind: 'email', identity: 'a', access: 'A', refresh: 'R' }],
    preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a763100000000010000000001010000000141010000000152001fffffffffffff010000000161',
    digest: '6cnt7epq3pDaVaMSj-nND_3xsfwNfWHodXLjIHFmQOs',
  },
  {
    name: 'non-ascii identity',
    members: [{ ordinal: 0, expires: 0, identityKind: 'email', identity: '用户', access: 'A', refresh: 'R' }],
    preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a76310000000001000000000101000000014101000000015200000000000000000100000006e794a8e688b7',
    digest: '52h_B0QN-X_V6GVYEwIgwKB6oGpfV39QMl2cGlDMHKE',
  },
  {
    name: 'nfc identity',
    members: [{ ordinal: 0, expires: 0, identityKind: 'email', identity: 'é', access: 'A', refresh: 'R' }],
    preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a76310000000001000000000101000000014101000000015200000000000000000100000002c3a9',
    digest: 'jJ0b8jrONoVvwZdLi8bO-g4-7jmPR9ABWqqtKHDsDQg',
  },
  {
    name: 'nfd identity',
    members: [{ ordinal: 0, expires: 0, identityKind: 'email', identity: 'e\u0301', access: 'A', refresh: 'R' }],
    preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a7631000000000100000000010100000001410100000001520000000000000000010000000365cc81',
    digest: 'fr7NhBPIEi2WQu_E1_mIT7eo6abk1IebNOkQwizyp9A',
  },
  {
    name: 'access byte',
    members: [{ ordinal: 0, expires: 0, identityKind: 'email', identity: 'a', access: 'B', refresh: 'R' }],
    preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a7631000000000100000000010100000001420100000001520000000000000000010000000161',
    digest: 'Aj6FBbiInVl9mdL2LRiVogNry0qTCYcylLOLQXhCpso',
  },
  {
    name: 'refresh byte',
    members: [{ ordinal: 0, expires: 0, identityKind: 'email', identity: 'a', access: 'A', refresh: 'S' }],
    preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a7631000000000100000000010100000001410100000001530000000000000000010000000161',
    digest: 'TVDGbB8vNEFBy6v84Fm7HCrFHQEw6z56JYq1FAX_tjA',
  },
  {
    name: 'expiry byte',
    members: [{ ordinal: 0, expires: 1, identityKind: 'email', identity: 'a', access: 'A', refresh: 'R' }],
    preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a7631000000000100000000010100000001410100000001520000000000000001010000000161',
    digest: 'e6J_bZ_XrLNsWOrjgulzUd7O-YVonHxVq0XZFEA0aa8',
  },
  {
    name: 'identity byte',
    members: [{ ordinal: 0, expires: 0, identityKind: 'email', identity: 'b', access: 'A', refresh: 'R' }],
    preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a7631000000000100000000010100000001410100000001520000000000000000010000000162',
    digest: 'y0CefnUg2Kjcqk-fYm_IMuDGVdm32OL1dVbZy2mk56k',
  },
  {
    name: 'identity kind',
    members: [{ ordinal: 0, expires: 0, identityKind: 'accountUuid', identity: 'a', access: 'A', refresh: 'R' }],
    preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a7631000000000100000000010100000001410100000001520000000000000000020000000161',
    digest: 'Hlh2SCRrIPCk_GLb0yo1kWVZ5J-V0oNy4a0Me_hYi4A',
  },
  {
    name: 'credential bytes',
    members: [{
      ordinal: 0,
      expires: 0,
      identityKind: 'email',
      identity: 'witness-identity@example.com',
      access: 'witness-access-token',
      refresh: 'witness-refresh-token',
    }],
    preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a76310000000001000000000101000000147769746e6573732d6163636573732d746f6b656e01000000157769746e6573732d726566726573682d746f6b656e0000000000000000010000001c7769746e6573732d6964656e74697479406578616d706c652e636f6d',
    digest: 'WGu7jMhuhgWawiGYxUFj_fAVU9xtIEbm0ph4H1gCk4k',
  },
];

const ONE_BYTE = new Set(['access byte', 'refresh byte', 'expiry byte', 'identity byte', 'identity kind']);

const MUTATIONS: Array<{ name: string; preimageHex: string; digest: string }> = [
  { name: 'member-count', preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a7631000000000200000000010100000001410100000001520000000000000000010000000161', digest: '2V5XsTmabphIaBzWDHp7KjG7N2UUN8_yrf8QIV_XXuE' },
  { name: 'ordinal', preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a7631000000000100000001010100000001410100000001520000000000000000010000000161', digest: 'z48Fz7vEcm_nc6x2ARMRxZxn_we4otvHc6-ZM6SZOzw' },
  { name: 'oauth-tag', preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a7631000000000100000000020100000001410100000001520000000000000000010000000161', digest: 'ISUN4Z4XwXwOfei-oZqUBi5M_g-_pJN-TC9wPPE8b6k' },
  { name: 'access-present-tag', preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a7631000000000100000000010000000001410100000001520000000000000000010000000161', digest: 'oO4UFMWiwn98m5iBtqOtuhfAlSsp2cHJU1VvjOQykNk' },
  { name: 'refresh-present-tag', preimageHex: '00000025716c623a616e7468726f7069633a706f6f6c2d736f757263652d7769746e6573733a7631000000000100000000010100000001410000000001520000000000000000010000000161', digest: '_4Gd3McznKEWtT79VF6cKyTwwgSoXRq0SQPGFzXfBxI' },
];

function poolAccount(member: SourceWitnessMemberInput): Record<string, unknown> {
  const credentials = { type: 'oauth', access: member.access, refresh: member.refresh, expires: member.expires };
  return member.identityKind === 'email'
    ? { id: `id-${member.ordinal}`, email: member.identity, credentials }
    : { id: `id-${member.ordinal}`, accountUuid: member.identity, credentials };
}

function withPool(raw: string, run: (ctx: {
  store: Store;
  mig: Migration;
  ownerPath: string;
  authPath: string;
  poolPath: string;
}) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-source-witness-'));
  const poolPath = join(dir, 'anthropic-pool.json');
  const ownerPath = join(dir, 'qlb-owner.json');
  const authPath = join(dir, 'auth.json');
  writeFileSync(poolPath, raw, { mode: 0o600 });
  const store = openStore(join(dir, 'qlb.db'));
  const mig = new Migration(store, new MockKeychain(), poolPath, ownerPath, undefined, { authJsonPath: authPath });
  try {
    run({ store, mig, ownerPath, authPath, poolPath });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('encodeSourceWitnessPreimage', () => {
  it('matches literal source-witness preimages and independent base64url digests', () => {
    const minimal = VECTORS[0]!;
    const minimalBytes = Buffer.from(minimal.preimageHex, 'hex');
    const domainLength = minimalBytes.readUInt32BE(0);
    assert.equal(minimalBytes.subarray(4, 4 + domainLength).toString('utf8'), 'qlb:anthropic:pool-source-witness:v1\u0000');
    for (const vector of VECTORS) {
      const encoded = encodeSourceWitnessPreimage(vector.members);
      assert.equal(encoded.toString('hex'), vector.preimageHex, vector.name);
      assert.equal(sha256Base64Url(vector.preimageHex), vector.digest, vector.name);
      assert.deepEqual(sourceWitnessForMembers(vector.members), {
        version: 1,
        algorithm: 'sha256',
        digest: vector.digest,
      }, vector.name);
      if (ONE_BYTE.has(vector.name)) assert.equal(byteDiff(encoded, minimalBytes), 1, vector.name);
    }
    assert.notEqual(VECTORS[5]!.digest, VECTORS[6]!.digest);
    assert.notEqual(
      encodeCompleteSetPreimage(minimal.members).toString('hex'),
      minimal.preimageHex,
    );
    for (const mutation of MUTATIONS) {
      const mutated = Buffer.from(mutation.preimageHex, 'hex');
      assert.equal(byteDiff(mutated, minimalBytes), 1, mutation.name);
      assert.equal(sha256Base64Url(mutation.preimageHex), mutation.digest, mutation.name);
      assert.notEqual(mutation.digest, minimal.digest, mutation.name);
    }
  });

  it('rejects invalid witness fields with source-membership-invalid and does not echo credential bytes', () => {
    const base: SourceWitnessMemberInput = {
      ordinal: 0,
      expires: 0,
      identityKind: 'email',
      identity: 'a',
      access: 'A',
      refresh: 'R',
    };
    const invalid: SourceWitnessMemberInput[][] = [
      [],
      [{ ...base, expires: Number.NaN }],
      [{ ...base, expires: Number.POSITIVE_INFINITY }],
      [{ ...base, expires: Number.NEGATIVE_INFINITY }],
      [{ ...base, expires: -1 }],
      [{ ...base, expires: 1.5 }],
      [{ ...base, expires: Number.MAX_SAFE_INTEGER + 1 }],
      [{ ...base, expires: 1e20 }],
      [{ ...base, ordinal: 1 }],
      [{ ...base, access: '' }],
      [{ ...base, refresh: '' }],
      [{ ...base, identity: '' }],
      [{ ...base, access: HIGH }],
      [{ ...base, access: LOW }],
      [{ ...base, refresh: HIGH }],
      [{ ...base, refresh: LOW }],
      [{ ...base, identity: HIGH }],
      [{ ...base, identity: LOW }],
      [{ ...base, access: `${SECRET}${HIGH}` }],
      [{ ...base, refresh: `${SECRET}${LOW}` }],
    ];
    for (const members of invalid) {
      assert.throws(
        () => encodeSourceWitnessPreimage(members),
        (error: unknown) => {
          assert.ok(error instanceof SourceMembershipInvalidError);
          assert.equal(error.message, 'source-membership-invalid');
          assert.equal(error.code, 'source-membership-invalid');
          assert.equal(String(error).includes(SECRET), false);
          return true;
        },
      );
    }
  });
});

describe('stage source witness', () => {
  it('persists a journal-only digest and still refuses commit, resume, and commit receipts', () => {
    const vector = VECTORS[12]!;
    const member = vector.members[0]!;
    withPool(`${JSON.stringify({ accounts: vector.members.map(poolAccount) })}\n`, (ctx) => {
      const status = ctx.mig.stage();
      const journal = ctx.store.getMigration(PI_POOL_STORE)?.detail_json ?? '';
      const stagedText = readFileSync(stagingOwnerPath(ctx.ownerPath), 'utf8');
      const statusText = JSON.stringify(status);
      const stored = JSON.parse(journal) as { sourceWitness?: unknown; poolV2PublicationStarted?: unknown };
      assert.deepEqual(stored.sourceWitness, { version: 1, algorithm: 'sha256', digest: vector.digest });
      assert.equal(encodeSourceWitnessPreimage(vector.members).toString('hex'), vector.preimageHex);
      assert.equal(stored.poolV2PublicationStarted, undefined);
      for (const forbidden of [member.access, member.refresh, vector.digest, 'sourceWitness']) {
        assert.equal(stagedText.includes(forbidden), false, forbidden);
        assert.equal(statusText.includes(forbidden), false, forbidden);
      }
      for (const forbidden of [member.access, member.refresh]) {
        assert.equal(journal.includes(forbidden), false, forbidden);
      }
      const sources = {
        poolText: readFileSync(ctx.poolPath, 'utf8'),
        journalDetail: JSON.parse(journal) as unknown,
        stagingDocument: JSON.parse(stagedText) as unknown,
      };
      const stageReceipt = projectAnthropicReceipt('stage', sources);
      assert.equal(stageReceipt.disposition, 'success');
      const stageReceiptText = formatAnthropicReceipt(stageReceipt, true);
      for (const forbidden of [member.access, member.refresh, member.identity, vector.digest, 'sourceWitness']) {
        assert.equal(stageReceiptText.includes(forbidden), false, forbidden);
      }
      const refusedPhases: AnthropicReceiptPhase[] = ['rehearse', 'commit', 'failure'];
      for (const phase of refusedPhases) {
        const receipt = projectAnthropicReceipt(phase, sources);
        assert.deepEqual(receipt, { schemaVersion: 1, phase, disposition: 'refused', code: 'proof-unavailable' });
        const text = formatAnthropicReceipt(receipt, true);
        assert.equal(text.includes(vector.digest), false, phase);
        assert.equal(text.includes(member.access), false, phase);
      }
      const poolBefore = readFileSync(ctx.poolPath);
      assert.throws(
        () => ctx.mig.commit(),
        (error: unknown) => error instanceof Error && error.message === 'proof-unavailable',
      );
      assert.throws(
        () => ctx.mig.resume(),
        (error: unknown) => error instanceof Error && error.message === 'proof-unavailable',
      );
      assert.equal(ctx.mig.status().resumeAction, 'proof-unavailable');
      assert.equal(ctx.mig.status().resumeAction.includes('complete commit'), false);
      assert.deepEqual(readFileSync(ctx.poolPath), poolBefore);
      assert.equal(existsSync(ctx.ownerPath), false);
      assert.equal(existsSync(ctx.authPath), false);
      assert.equal(existsSync(preQlbPath(ctx.poolPath)), false);
      assert.equal(existsSync(sidecarPath(ctx.poolPath)), false);
      assert.equal(existsSync(piAuthBackupPath(ctx.authPath, 'anthropic')), false);
      assert.equal(existsSync(legacyPiAuthBackupPath(ctx.authPath, 'anthropic')), false);
      assert.equal(existsSync(stagingOwnerPath(ctx.ownerPath)), true);
      const afterRefusal = JSON.parse(ctx.store.getMigration(PI_POOL_STORE)?.detail_json ?? '{}') as {
        sourceWitness?: { digest: string };
        poolV2PublicationStarted?: unknown;
      };
      assert.equal(afterRefusal.sourceWitness?.digest, vector.digest);
      assert.equal(afterRefusal.poolV2PublicationStarted, undefined);
      const rolled = ctx.mig.rollback();
      assert.equal(rolled.state, 'NATIVE');
      assert.equal(Object.hasOwn(rolled.detail, 'sourceWitness'), false);
      const cleared = ctx.store.getMigration(PI_POOL_STORE)?.detail_json ?? '';
      assert.equal(cleared.includes('sourceWitness'), false);
      assert.equal(cleared.includes(vector.digest), false);
      assert.equal(cleared.includes(member.access), false);
    });
  });
});
