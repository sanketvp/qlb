import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { formatAnthropicReceipt, projectAnthropicReceipt, readAnthropicReceiptSources } from '../src/anthropic-receipt';
import {
  assembleIdentityProof,
  identityProofBuckets,
  readProfileIdentity,
  readUsageBuckets,
  type AnthropicHttpResult,
  type AnthropicPoolTransport,
  type ProofBindingView,
} from '../src/anthropic-rehearsal-proof';
import { MockKeychain, qlbKeychainService } from '../src/keychain';
import { ANTHROPIC_OAUTH_PROFILE_URL, ANTHROPIC_USAGE_URL } from '../src/anthropic-oauth';
import { Migration, PI_POOL_STORE, anthropicPoolFetchTransport, stagingOwnerPath } from '../src/migration';
import { openStore, type Store } from '../src/store';
import { seedActiveSlots } from './support/adoption-slots';

const PROVED_AT = 1_700_000_000_000;
const EMAIL = 'ada@example.com';
const OTHER_EMAIL = 'other@example.com';
const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN_A = 'access-token-a';
const TOKEN_B = 'access-token-b';
const HOSTILE = 'Hostile Display Name';
const EXPIRES = PROVED_AT + 60_000;

function ok(body: unknown, status = 200): AnthropicHttpResult {
  return { status, body };
}

function usage(five: unknown = 11, seven: unknown = 22, extra: Record<string, unknown> = {}) {
  return { five_hour: { utilization: five }, seven_day: { utilization: seven }, ...extra };
}

describe('readProfileIdentity', () => {
  const cases: Array<{ name: string; kind: 'email' | 'accountUuid'; declared: string; body: unknown; status?: number; code: string }> = [
    { name: 'email match', kind: 'email', declared: EMAIL, body: { account: { uuid: UUID_A, email: EMAIL } }, code: 'ok' },
    { name: 'trimmed provider uuid', kind: 'accountUuid', declared: UUID_A, body: { account: { uuid: ` ${UUID_A} ` } }, code: 'ok' },
    { name: 'wrong email', kind: 'email', declared: EMAIL, body: { account: { uuid: UUID_A, email: OTHER_EMAIL } }, code: 'identity-mismatch' },
    { name: 'wrong uuid', kind: 'accountUuid', declared: UUID_A, body: { account: { uuid: UUID_B } }, code: 'identity-mismatch' },
    { name: 'missing uuid', kind: 'email', declared: EMAIL, body: { account: { email: EMAIL } }, code: 'identity-mismatch' },
    { name: 'missing email', kind: 'email', declared: EMAIL, body: { account: { uuid: UUID_A } }, code: 'identity-mismatch' },
    { name: 'source uuid is not trimmed', kind: 'accountUuid', declared: ` ${UUID_A} `, body: { account: { uuid: ` ${UUID_A} ` } }, code: 'identity-mismatch' },
    { name: 'email member also declares accountUuid', kind: 'email', declared: EMAIL, body: { account: { uuid: UUID_A, email: EMAIL, accountUuid: UUID_B } }, code: 'identity-mismatch' },
    { name: 'uuid member also declares email', kind: 'accountUuid', declared: UUID_A, body: { account: { uuid: UUID_A, email: EMAIL } }, code: 'identity-mismatch' },
    { name: 'profile http', kind: 'email', declared: EMAIL, body: { account: { uuid: UUID_A, email: EMAIL } }, status: 401, code: 'proof-unavailable' },
    { name: 'profile json', kind: 'email', declared: EMAIL, body: null, code: 'proof-unavailable' },
  ];
  for (const item of cases) {
    it(item.name, () => {
      const result = readProfileIdentity(item.kind, item.declared, ok(item.body, item.status));
      assert.equal(result.ok ? 'ok' : result.code, item.code);
    });
  }
});

describe('readUsageBuckets', () => {
  const hostile = { limits: [{ scope: { model: { display_name: HOSTILE } }, percent: 99 }] };
  const cases: Array<{ name: string; body: unknown; status?: number; value?: string }> = [
    { name: 'finite buckets', body: usage(11, 22, hostile), value: '11/22' },
    { name: 'zero is finite', body: usage(0, 4), value: '0/4' },
    { name: 'five_hour null is an idle window', body: { five_hour: null, seven_day: { utilization: 8 }, ...hostile }, value: '0/8' },
    { name: 'five_hour key absent is an idle window', body: { seven_day: { utilization: 1 } }, value: '0/1' },
    { name: 'missing 7d', body: { five_hour: { utilization: 1 } } },
    { name: 'seven_day null', body: { five_hour: null, seven_day: null } },
    { name: 'seven_day null with a finite five_hour', body: { five_hour: { utilization: 3 }, seven_day: null } },
    { name: 'nan', body: usage(Number.NaN, 1) },
    { name: 'infinity', body: usage(Number.POSITIVE_INFINITY, 1) },
    { name: 'boolean', body: usage(true, 1) },
    { name: 'string utilization', body: usage('12', 1) },
    { name: 'five_hour string', body: { five_hour: '12', seven_day: { utilization: 1 } } },
    { name: 'bad reset', body: { five_hour: { utilization: 1, resets_at: 'nope' }, seven_day: { utilization: 2 } } },
    { name: 'usage http', body: usage(), status: 500 },
    { name: 'usage json', body: [] },
  ];
  for (const item of cases) {
    it(item.name, () => {
      const result = readUsageBuckets(ok(item.body, item.status));
      if (item.value) {
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(`${result.buckets['5h']}/${result.buckets['7d']}`, item.value);
        assert.equal(JSON.stringify(result).includes(HOSTILE), false);
      } else {
        assert.deepEqual(result, { ok: false, code: 'proof-unavailable' });
      }
    });
  }

  it('rejects a repeated provider uuid', () => {
    const assembled = assembleIdentityProof({
      cycle: 'cycle-1',
      provedAt: PROVED_AT,
      aliases: ['member-0001', 'member-0002'],
      identityKinds: ['email', 'email'],
      readings: [
        { providerUuid: UUID_A, buckets: { '5h': 1, '7d': 2 } },
        { providerUuid: UUID_A, buckets: { '5h': 3, '7d': 4 } },
      ],
    });
    assert.deepEqual(assembled, { ok: false, code: 'identity-mismatch' });
  });
});

interface Step { op: 'profile' | 'usage'; status?: number; body?: unknown; boom?: boolean }

function scripted(steps: Step[], log: string[]): AnthropicPoolTransport {
  let cursor = 0;
  const take = async (op: Step['op'], token: string): Promise<AnthropicHttpResult> => {
    log.push(`${op}:${token}`);
    const step = steps[cursor];
    cursor += 1;
    if (!step || step.op !== op || step.boom) throw new Error('scripted-transport');
    return { status: step.status ?? 200, body: step.body };
  };
  return { getProfile: (token) => take('profile', token), getUsage: (token) => take('usage', token) };
}

function oauth(access: string, expires = EXPIRES) {
  return { type: 'oauth', access, refresh: `refresh-${access}`, expires };
}

function emailMember(access: string, email = EMAIL, expires = EXPIRES) {
  return { id: `id-${access}`, name: 'Email Name', email, credentials: oauth(access, expires) };
}

function uuidMember(access: string, accountUuid: string, expires = EXPIRES) {
  return { id: `id-${access}`, name: 'Uuid Name', accountUuid, credentials: oauth(access, expires) };
}

function poolText(accounts: unknown[]): string {
  return `${JSON.stringify({ accounts })}\n`;
}

interface Pool {
  poolPath: string;
  ownerPath: string;
  authPath: string;
  store: Store;
  kc: MockKeychain;
  mig: Migration;
  close: () => void;
}

function adoptionFor(raw: string): Array<{ accountId: string; email: string | null }> {
  const parsed = JSON.parse(raw) as { accounts?: Array<{ email?: string; accountUuid?: string }> };
  return (parsed.accounts ?? []).map((account) => {
    if (typeof account.accountUuid === 'string') return { accountId: account.accountUuid, email: null };
    const email = account.email ?? '';
    const accountId = email === EMAIL ? UUID_A : email === OTHER_EMAIL ? UUID_B : `slot-${email}`;
    return { accountId, email };
  });
}

function openPool(raw: string, transport: AnthropicPoolTransport, now = () => PROVED_AT): Pool {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-r1a-proof-'));
  const poolPath = join(dir, 'anthropic-pool.json');
  const ownerPath = join(dir, 'qlb-owner.json');
  const authPath = join(dir, 'auth.json');
  writeFileSync(poolPath, raw, { mode: 0o600 });
  const store = openStore(join(dir, 'qlb.db'));
  const slots = adoptionFor(raw);
  if (slots[0]) seedActiveSlots(store, slots, slots[0].accountId);
  const kc = new MockKeychain();
  const mig = new Migration(store, kc, poolPath, ownerPath, undefined, {
    authJsonPath: authPath,
    now,
    initialActiveAlias: 'member-0001',
    anthropicPoolTransport: transport,
  });
  mig.stage();
  return {
    poolPath, ownerPath, authPath, store, kc, mig,
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function detail(pool: Pool): Record<string, unknown> {
  return JSON.parse(pool.store.getMigration(PI_POOL_STORE)?.detail_json ?? '{}') as Record<string, unknown>;
}

function statusOf(pool: Pool, access: string): string {
  return pool.store.getAccount(`id-${access}`)?.status ?? 'missing';
}

async function rehearseError(pool: Pool): Promise<Error & { exitCode?: number }> {
  try {
    await pool.mig.rehearse(async () => { throw new Error('rehearse hook must not run'); });
  } catch (error) {
    return error as Error & { exitCode?: number };
  }
  assert.fail('rehearse succeeded');
}

describe('anthropic pool rehearsal', () => {
  it('proves every member in order, then persists one transaction', async () => {
    const log: string[] = [];
    const hostileUsage = usage(33, 44, { limits: [{ scope: { model: { display_name: HOSTILE } }, percent: 90 }] });
    const pool = openPool(poolText([emailMember(TOKEN_A), uuidMember(TOKEN_B, UUID_B)]), scripted([
      { op: 'profile', body: { account: { uuid: ` ${UUID_A} `, email: EMAIL } } },
      { op: 'usage', body: usage(11, 22) },
      { op: 'profile', body: { account: { uuid: UUID_B } } },
      { op: 'usage', body: hostileUsage },
    ], log));
    try {
      const before = pool.store.getMigration(PI_POOL_STORE)?.detail_json ?? '';
      const staging = readFileSync(stagingOwnerPath(pool.ownerPath));
      const keychain = pool.kc.getSync(qlbKeychainService('anthropic', `id-${TOKEN_A}`), EMAIL);
      let transactions = 0;
      const original = pool.store.runImmediate.bind(pool.store);
      pool.store.runImmediate = (fn) => { transactions += 1; return original(fn); };
      assert.equal(statusOf(pool, TOKEN_A), 'imported-unvalidated');
      const rehearsed = await pool.mig.rehearse(async () => ({ ok: true }));
      assert.equal(rehearsed.state, 'VALIDATED');
      assert.equal(transactions, 1);
      assert.deepEqual(log, [`profile:${TOKEN_A}`, `usage:${TOKEN_A}`, `profile:${TOKEN_B}`, `usage:${TOKEN_B}`]);
      assert.equal(statusOf(pool, TOKEN_A), 'validated');
      assert.equal(statusOf(pool, TOKEN_B), 'validated');
      const proof = (detail(pool).identityProof ?? {}) as { members?: Array<{ buckets: unknown }> };
      assert.deepEqual(proof.members?.map((member) => member.buckets), [
        { '5h': 11, '7d': 22 },
        { '5h': 33, '7d': 44 },
      ]);
      const proofJson = JSON.stringify(proof);
      const journal = pool.store.getMigration(PI_POOL_STORE)?.detail_json ?? '';
      for (const secret of [UUID_A, UUID_B, TOKEN_A, TOKEN_B, HOSTILE, EMAIL, `refresh-${TOKEN_A}`]) {
        assert.equal(proofJson.includes(secret), false, secret);
      }
      assert.equal(JSON.stringify(rehearsed).includes(HOSTILE), false);
      assert.deepEqual(readFileSync(stagingOwnerPath(pool.ownerPath)), staging);
      assert.equal(pool.kc.getSync(qlbKeychainService('anthropic', `id-${TOKEN_A}`), EMAIL), keychain);
      assert.equal(existsSync(pool.ownerPath), false);
      const receipt = projectAnthropicReceipt('rehearse', readAnthropicReceiptSources(pool.poolPath, pool.ownerPath, journal));
      const text = formatAnthropicReceipt(receipt, true);
      assert.equal(text.includes(HOSTILE), false);
      assert.equal(text.includes(EMAIL), false);
      assert.deepEqual(JSON.parse(text).buckets, [{ '5h': 11, '7d': 22 }, { '5h': 33, '7d': 44 }]);
      assert.equal(before.includes('identityProof'), false);
      const rolled = pool.mig.rollback();
      assert.equal(rolled.state, 'NATIVE');
      assert.equal(Object.hasOwn(detail(pool), 'identityProof'), false);
      assert.equal(Object.hasOwn(detail(pool), 'binding'), false);
    } finally {
      pool.close();
    }
  });

  it('validates a mixed pool when only one member has an active 5-hour window', async () => {
    const roster = [
      { email: EMAIL, token: TOKEN_A, five: 11, seven: 22 },
      { email: 'idle-b@example.com', token: TOKEN_B, five: null, seven: 30 },
      { email: 'idle-c@example.com', token: 'access-token-c', five: 'absent' as const, seven: 40 },
      { email: 'idle-d@example.com', token: 'access-token-d', five: null, seven: 50 },
      { email: 'idle-e@example.com', token: 'access-token-e', five: 'absent' as const, seven: 60 },
    ];
    const log: string[] = [];
    const steps: Step[] = [];
    const expectedBuckets = roster.map((member) => {
      const slot = member.email === EMAIL ? UUID_A : `slot-${member.email}`;
      const usageBody: Record<string, unknown> = { seven_day: { utilization: member.seven } };
      if (member.five === null) usageBody.five_hour = null;
      else if (member.five !== 'absent') usageBody.five_hour = { utilization: member.five };
      if (member.five === null) {
        usageBody.limits = [{ scope: { model: { display_name: HOSTILE } }, percent: 9 }];
      }
      steps.push(
        { op: 'profile', body: { account: { uuid: slot, email: member.email } } },
        { op: 'usage', body: usageBody },
      );
      return { '5h': typeof member.five === 'number' ? member.five : 0, '7d': member.seven };
    });
    const pool = openPool(
      poolText(roster.map((member) => emailMember(member.token, member.email))),
      scripted(steps, log),
    );
    try {
      const rehearsed = await pool.mig.rehearse(async () => { throw new Error('rehearse hook must not run'); });
      assert.equal(rehearsed.state, 'VALIDATED');
      assert.deepEqual(log, roster.flatMap((member) => [`profile:${member.token}`, `usage:${member.token}`]));
      for (const member of roster) assert.equal(statusOf(pool, member.token), 'validated');
      const journal = detail(pool);
      const binding = journal.binding as ProofBindingView;
      assert.deepEqual(identityProofBuckets(journal.identityProof, binding), expectedBuckets);
      const proof = journal.identityProof as { members?: Array<{ buckets: unknown }> };
      assert.deepEqual(proof.members?.map((member) => member.buckets), expectedBuckets);
      assert.equal(JSON.stringify(proof).includes(HOSTILE), false);
      const receipt = projectAnthropicReceipt('rehearse', readAnthropicReceiptSources(
        pool.poolPath,
        pool.ownerPath,
        pool.store.getMigration(PI_POOL_STORE)?.detail_json,
      ));
      assert.equal(receipt.phase, 'rehearse');
      assert.equal(receipt.disposition, 'success');
      if (receipt.phase === 'rehearse' && receipt.disposition === 'success') {
        assert.deepEqual(receipt.buckets, expectedBuckets);
      }
      assert.equal(pool.mig.status().resumeAction, 'rehearsal succeeded; complete commit');
      const committed = pool.mig.commit();
      assert.equal(committed.state, 'QLB_OWNED');
      assert.deepEqual(log, roster.flatMap((member) => [`profile:${member.token}`, `usage:${member.token}`]));
    } finally {
      pool.close();
    }
  });

  it('stops on the failing member and writes no proof or validated status', async () => {
    const cases: Array<{ name: string; steps: Step[]; message: string; log: string[] }> = [
      {
        name: 'second profile http',
        message: 'rehearse failed',
        log: [`profile:${TOKEN_A}`, `usage:${TOKEN_A}`, `profile:${TOKEN_B}`],
        steps: [
          { op: 'profile', body: { account: { uuid: UUID_A, email: EMAIL } } },
          { op: 'usage', body: usage() },
          { op: 'profile', status: 503, body: { account: { uuid: UUID_B, email: OTHER_EMAIL } } },
        ],
      },
      {
        name: 'duplicate provider uuid',
        message: 'identity-mismatch',
        log: [`profile:${TOKEN_A}`, `usage:${TOKEN_A}`, `profile:${TOKEN_B}`],
        steps: [
          { op: 'profile', body: { account: { uuid: UUID_A, email: EMAIL } } },
          { op: 'usage', body: usage() },
          { op: 'profile', body: { account: { uuid: UUID_A, email: OTHER_EMAIL } } },
        ],
      },
      {
        name: 'usage throw',
        message: 'rehearse failed',
        log: [`profile:${TOKEN_A}`, `usage:${TOKEN_A}`],
        steps: [
          { op: 'profile', body: { account: { uuid: UUID_A, email: EMAIL } } },
          { op: 'usage', boom: true },
        ],
      },
      {
        name: 'malformed five_hour',
        message: 'rehearse failed',
        log: [`profile:${TOKEN_A}`, `usage:${TOKEN_A}`],
        steps: [
          { op: 'profile', body: { account: { uuid: UUID_A, email: EMAIL } } },
          { op: 'usage', body: { five_hour: '12', seven_day: { utilization: 1 }, limits: [{ scope: { model: { display_name: HOSTILE } }, percent: 9 }] } },
        ],
      },
    ];
    for (const item of cases) {
      const log: string[] = [];
      const accounts = item.log.length === 2
        ? [emailMember(TOKEN_A)]
        : [emailMember(TOKEN_A), emailMember(TOKEN_B, OTHER_EMAIL)];
      const pool = openPool(poolText(accounts), scripted(item.steps, log));
      try {
        const journal = pool.store.getMigration(PI_POOL_STORE)?.detail_json;
        const error = await rehearseError(pool);
        assert.equal(error.message, item.message, item.name);
        assert.equal(error.exitCode, 3, item.name);
        assert.equal(error.message.includes(HOSTILE), false);
        assert.deepEqual(log, item.log, item.name);
        assert.equal(pool.mig.status().state, 'MIRRORED', item.name);
        assert.equal(statusOf(pool, TOKEN_A), 'imported-unvalidated', item.name);
        if (item.log.length !== 2) assert.equal(statusOf(pool, TOKEN_B), 'imported-unvalidated', item.name);
        assert.equal((pool.store.getMigration(PI_POOL_STORE)?.detail_json ?? '').includes(HOSTILE), false, item.name);
        const after = pool.store.getMigration(PI_POOL_STORE)?.detail_json ?? '';
        assert.equal(after.includes('identityProof'), false, item.name);
        if (item.message === 'identity-mismatch') {
          assert.deepEqual(detail(pool).rehearseRefusal, { code: 'identity-mismatch' });
          assert.equal(JSON.stringify(detail(pool).rehearseRefusal).includes(UUID_A), false, item.name);
        } else {
          assert.equal(after, journal, item.name);
        }
      } finally {
        pool.close();
      }
    }
  });

  it('restage drops a stale refusal and proof without dropping the source witness', async () => {
    const mismatchLog: string[] = [];
    const refused = openPool(poolText([emailMember(TOKEN_A)]), scripted([
      { op: 'profile', body: { account: { uuid: UUID_A, email: OTHER_EMAIL } } },
    ], mismatchLog));
    try {
      const error = await rehearseError(refused);
      assert.equal(error.message, 'identity-mismatch');
      const stale = detail(refused);
      assert.deepEqual(stale.rehearseRefusal, { code: 'identity-mismatch' });
      const witness = stale.sourceWitness;
      assert.equal(typeof (witness as { digest?: unknown }).digest, 'string');
      refused.mig.stage();
      const restaged = detail(refused);
      assert.equal(refused.mig.status().state, 'MIRRORED');
      assert.equal(Object.hasOwn(restaged, 'rehearseRefusal'), false);
      assert.equal(Object.hasOwn(restaged, 'identityProof'), false);
      assert.deepEqual(restaged.sourceWitness, witness);
      const receipt = projectAnthropicReceipt('rehearse', readAnthropicReceiptSources(
        refused.poolPath,
        refused.ownerPath,
        refused.store.getMigration(PI_POOL_STORE)?.detail_json,
      ));
      assert.equal(receipt.disposition === 'refused' && receipt.code, 'proof-unavailable');
    } finally {
      refused.close();
    }

    const proofLog: string[] = [];
    const proved = openPool(poolText([emailMember(TOKEN_A)]), scripted([
      { op: 'profile', body: { account: { uuid: UUID_A, email: EMAIL } } },
      { op: 'usage', body: usage() },
    ], proofLog));
    try {
      const witness = detail(proved).sourceWitness;
      const rehearsed = await proved.mig.rehearse(async () => { throw new Error('rehearse hook must not run'); });
      assert.equal(rehearsed.state, 'VALIDATED');
      assert.deepEqual(detail(proved).sourceWitness, witness);
      assert.equal(Object.hasOwn(detail(proved), 'identityProof'), true);
      proved.mig.stage();
      const restaged = detail(proved);
      assert.equal(Object.hasOwn(restaged, 'identityProof'), false);
      assert.equal(Object.hasOwn(restaged, 'rehearseRefusal'), false);
      assert.deepEqual(restaged.sourceWitness, witness);
    } finally {
      proved.close();
    }
  });

  it('refuses an expired staged grant before either request', async () => {
    const log: string[] = [];
    const pool = openPool(
      poolText([emailMember(TOKEN_A, EMAIL, PROVED_AT), uuidMember(TOKEN_B, UUID_B)]),
      scripted([], log),
    );
    try {
      const error = await rehearseError(pool);
      assert.equal(error.message, 'token-expired');
      assert.equal(error.exitCode, 3);
      assert.equal(error.message.includes(EMAIL), false);
      assert.deepEqual(log, []);
      assert.equal(pool.mig.status().state, 'MIRRORED');
      assert.deepEqual(detail(pool).rehearseRefusal, { code: 'token-expired' });
      assert.equal(statusOf(pool, TOKEN_A), 'imported-unvalidated');
    } finally {
      pool.close();
    }
  });

  it('rolls back a database failure inside the proof transaction', async () => {
    const log: string[] = [];
    const pool = openPool(poolText([emailMember(TOKEN_A), uuidMember(TOKEN_B, UUID_B)]), scripted([
      { op: 'profile', body: { account: { uuid: UUID_A, email: EMAIL } } },
      { op: 'usage', body: usage(1, 2) },
      { op: 'profile', body: { account: { uuid: UUID_B } } },
      { op: 'usage', body: usage(3, 4) },
    ], log));
    try {
      const journal = pool.store.getMigration(PI_POOL_STORE)?.detail_json;
      const original = pool.store.setAccountStatus.bind(pool.store);
      let writes = 0;
      pool.store.setAccountStatus = (id, status) => {
        writes += 1;
        if (writes === 2) throw new Error(`fixture-db ${HOSTILE}`);
        original(id, status);
      };
      const error = await rehearseError(pool);
      assert.equal(error.message, 'rehearse failed');
      assert.equal(error.message.includes(HOSTILE), false);
      assert.equal(error.exitCode, 3);
      assert.equal(pool.mig.status().state, 'MIRRORED');
      assert.equal(pool.store.getMigration(PI_POOL_STORE)?.detail_json, journal);
      assert.equal(statusOf(pool, TOKEN_A), 'imported-unvalidated');
      assert.equal(statusOf(pool, TOKEN_B), 'imported-unvalidated');
      assert.equal(log.length, 4);
    } finally {
      pool.close();
    }
  });

  it('builds the production profile and usage requests without retaining an unreadable body', async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'Bearer token-a');
      assert.equal(JSON.stringify(headers).includes('refresh'), false);
      return new Response(`not-json ${HOSTILE}`, { status: 200 });
    }) as typeof fetch;
    try {
      const transport = anthropicPoolFetchTransport();
      const profile = await transport.getProfile('token-a');
      const usage = await transport.getUsage('token-a');
      assert.deepEqual(calls, [
        `GET ${ANTHROPIC_OAUTH_PROFILE_URL}`,
        `GET ${ANTHROPIC_USAGE_URL}`,
      ]);
      assert.deepEqual(profile, { status: 200, body: null });
      assert.deepEqual(usage, { status: 200, body: null });
      assert.equal(JSON.stringify(profile).includes(HOSTILE), false);
    } finally {
      globalThis.fetch = original;
    }
  });
});
