import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { streamWithAuthRetry } from '../extensions/qlb-pi/auth-retry';
import { isAuthFailureText, isAuthHttpStatus } from '../extensions/qlb-pi/outcome';
import { doctorQlb } from '../src/diagnostics';
import { defaultConfig } from '../src/config';
import { MockKeychain, qlbKeychainService } from '../src/keychain';
import {
  ADAPTER_ACCOUNT_IDS,
  ADAPTER_ACCOUNT_LABELS,
  type ApiKeyPayload,
} from '../src/migration';
import {
  attemptWithNativeResyncRetry,
  bindDetectAndResync,
  createNativeCredentialReader,
  detectAndResyncFromNative,
  inspectOwnedNativeDrift,
  nativeResyncAuditEntry,
  parseResyncCredential,
  type ResyncCredential,
  type ResyncResult,
} from '../src/native-resync';
import { setPolicy } from '../src/policy';
import { LoopbackProxy } from '../src/proxy';
import { parseGrant } from '../src/refresh-lease';
import { openStore } from '../src/store';
import type { Grant } from '../src/types';

const temps: string[] = [];
after(() => {
  // files under tmpdir are leftover fixtures; nothing to close besides stores in tests
  void temps;
});

function grant(access: string, refresh = 'refresh-1'): Grant {
  return {
    access,
    refresh,
    expires: Date.now() + 60_000,
    generation: 0,
  };
}

function apiKey(access: string): ApiKeyPayload {
  return { type: 'api-key', access };
}

describe('detectAndResyncFromNative', () => {
  it('writes native credential when it differs from QLB copy and returns resynced: true', async () => {
    const kc = new MockKeychain();
    const owned = grant('qlb-access', 'qlb-refresh');
    const native = grant('native-access', 'native-refresh');
    let writes = 0;
    let written: ResyncCredential | null = null;
    const result = await detectAndResyncFromNative('xai', 'xai-default', {
      keychain: kc,
      readNativeCredential: async () => native,
      readOwnedCredential: async () => owned,
      writeOwnedCredential: async (_kc, _id, cred) => {
        writes += 1;
        written = cred;
      },
    });
    assert.equal(result.resynced, true);
    assert.match(result.reason, /differed/);
    assert.equal(writes, 1);
    assert.ok(written);
    assert.equal((written as Grant).access, 'native-access');
    assert.equal((written as Grant).refresh, 'native-refresh');
    assert.equal((written as Grant).writtenBy, 'native-resync');
  });

  it('does not write when native matches QLB copy (genuine revocation signal)', async () => {
    const kc = new MockKeychain();
    const cred = grant('same-access', 'same-refresh');
    let writes = 0;
    const result = await detectAndResyncFromNative('anthropic', 'acct-1', {
      keychain: kc,
      readNativeCredential: async () => cred,
      readOwnedCredential: async () => ({ ...cred }),
      writeOwnedCredential: async () => {
        writes += 1;
      },
    });
    assert.equal(result.resynced, false);
    assert.match(result.reason, /genuine revocation/);
    assert.equal(writes, 0);
  });

  it('returns resynced: false and never throws when native credential is unreadable', async () => {
    const kc = new MockKeychain();
    let writes = 0;
    const thrown = await detectAndResyncFromNative('kimi-coding', 'kimi-default', {
      keychain: kc,
      readNativeCredential: async () => {
        throw new Error('simulated native read error');
      },
      readOwnedCredential: async () => grant('owned'),
      writeOwnedCredential: async () => {
        writes += 1;
      },
    });
    assert.equal(thrown.resynced, false);
    assert.match(thrown.reason, /unreadable/);
    assert.equal(writes, 0);

    const missing = await detectAndResyncFromNative('openrouter', 'openrouter-default', {
      keychain: kc,
      readNativeCredential: async () => null,
      readOwnedCredential: async () => apiKey('owned-key'),
      writeOwnedCredential: async () => {
        writes += 1;
      },
    });
    assert.equal(missing.resynced, false);
    assert.match(missing.reason, /unreadable/);
    assert.equal(writes, 0);
  });

  it('resyncs OpenRouter API keys by access-token fingerprint, not OAuth Grant shape', async () => {
    const kc = new MockKeychain();
    let written: ResyncCredential | null = null;
    const result = await detectAndResyncFromNative('openrouter', 'openrouter-default', {
      keychain: kc,
      readNativeCredential: async () => apiKey('sk-or-native'),
      readOwnedCredential: async () => apiKey('sk-or-owned'),
      writeOwnedCredential: async (_kc, _id, cred) => {
        written = cred;
      },
    });
    assert.equal(result.resynced, true);
    assert.ok(written);
    assert.equal((written as ApiKeyPayload).type, 'api-key');
    assert.equal((written as ApiKeyPayload).access, 'sk-or-native');
  });
});

describe('attemptWithNativeResyncRetry — retry once, never loop', () => {
  it('on 401, resyncs once and retries; a second 401 does not resync again', async () => {
    const attempts: string[] = [];
    let resyncCalls = 0;
    const audits: ResyncResult[] = [];
    let cred = 'old-token';

    const { result, resyncAttempted, retried } = await attemptWithNativeResyncRetry({
      attempt: async () => {
        attempts.push(cred);
        return { status: 401 as number, token: cred };
      },
      isAuthFailure: (r) => r.status === 401,
      resync: async () => {
        resyncCalls += 1;
        cred = 'new-token';
        return { resynced: true, reason: 'native differed' };
      },
      onResync: (r) => audits.push(r),
    });

    assert.equal(retried, true);
    assert.equal(resyncCalls, 1);
    assert.deepEqual(attempts, ['old-token', 'new-token']);
    assert.equal(result.status, 401);
    assert.equal(result.token, 'new-token');
    assert.equal(resyncAttempted?.resynced, true);
    assert.equal(audits.length, 1);
  });

  it('does not retry when resync reports identical credentials (genuine revocation)', async () => {
    let attempts = 0;
    let resyncCalls = 0;
    const { result, retried, resyncAttempted } = await attemptWithNativeResyncRetry({
      attempt: async () => {
        attempts += 1;
        return { status: 401 };
      },
      isAuthFailure: (r) => r.status === 401,
      resync: async () => {
        resyncCalls += 1;
        return {
          resynced: false,
          reason: 'native credential identical to QLB copy (genuine revocation; re-auth required)',
        };
      },
    });
    assert.equal(attempts, 1);
    assert.equal(resyncCalls, 1);
    assert.equal(retried, false);
    assert.equal(result.status, 401);
    assert.equal(resyncAttempted?.resynced, false);
  });

  it('does not resync at all on a non-auth failure', async () => {
    let resyncCalls = 0;
    const { retried, resyncAttempted, result } = await attemptWithNativeResyncRetry({
      attempt: async () => ({ status: 500 }),
      isAuthFailure: (r) => r.status === 401,
      resync: async () => {
        resyncCalls += 1;
        return { resynced: true, reason: 'should not run' };
      },
    });
    assert.equal(result.status, 500);
    assert.equal(retried, false);
    assert.equal(resyncAttempted, null);
    assert.equal(resyncCalls, 0);
  });

  it('audit entry distinguishes recovered-via-resync from genuine failure', () => {
    const recovered = nativeResyncAuditEntry({
      provider: 'anthropic',
      accountId: 'acct-1',
      result: { resynced: true, reason: 'native credential differed' },
    });
    const genuine = nativeResyncAuditEntry({
      provider: 'anthropic',
      accountId: 'acct-1',
      result: {
        resynced: false,
        reason: 'native credential identical to QLB copy (genuine revocation; re-auth required)',
      },
    });
    assert.equal(recovered.kind, 'native_resync');
    assert.equal(recovered.resynced, true);
    assert.equal(genuine.kind, 'native_resync');
    assert.equal(genuine.resynced, false);
    assert.match(String(genuine.reason), /genuine revocation/);
    assert.notEqual(recovered.resynced, genuine.resynced);
  });
});

describe('qlb-pi streamWithAuthRetry', () => {
  async function* events(
    list: unknown[],
  ): AsyncGenerator<unknown> {
    for (const e of list) yield e;
  }

  it('retries the stream exactly once after a resynced 401, and does not loop on a second 401', async () => {
    let starts = 0;
    let resyncCalls = 0;
    const pushed: unknown[] = [];
    const audits: Array<{ resynced: boolean; reason: string }> = [];
    let access = 'old';

    const result = await streamWithAuthRetry({
      readAccess: () => access,
      startStream: (tok) => {
        starts += 1;
        return events([
          {
            type: 'error',
            reason: 'error',
            error: {
              errorMessage: `401 OAuth access token has been revoked (token=${tok})`,
            },
          },
        ]);
      },
      resync: async () => {
        resyncCalls += 1;
        access = 'new';
        return { resynced: true, reason: 'native differed' };
      },
      onEvent: (e) => pushed.push(e),
      onResync: (r) => audits.push(r),
    });

    assert.equal(starts, 2);
    assert.equal(resyncCalls, 1);
    assert.equal(result.retried, true);
    assert.equal(result.outcome, 'failed');
    assert.equal(pushed.length, 1, 'first-attempt 401 events discarded after resync');
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.resynced, true);
    assert.match(String((pushed[0] as { error?: { errorMessage?: string } }).error?.errorMessage), /token=new/);
  });

  it('surfaces the original 401 and does not retry when resync reports genuine revocation', async () => {
    let starts = 0;
    const pushed: unknown[] = [];
    const result = await streamWithAuthRetry({
      readAccess: () => 'same',
      startStream: () => {
        starts += 1;
        return events([
          {
            type: 'error',
            reason: 'error',
            error: { errorMessage: '401 OAuth access token has been revoked' },
          },
        ]);
      },
      resync: async () => ({
        resynced: false,
        reason: 'native credential identical to QLB copy (genuine revocation; re-auth required)',
      }),
      onEvent: (e) => pushed.push(e),
      onResync: () => undefined,
    });
    assert.equal(starts, 1);
    assert.equal(result.retried, false);
    assert.equal(result.outcome, 'failed');
    assert.equal(pushed.length, 1);
  });
});

describe('createNativeCredentialReader (temp files only)', () => {
  it('reads all 5 provider shapes from injected paths / fake OpenRouter key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-resync-native-'));
    temps.push(dir);
    const pool = join(dir, 'anthropic-pool.json');
    const auth = join(dir, 'auth.json');
    writeFileSync(
      pool,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'acct-a',
            email: 'a@example.com',
            credentials: {
              type: 'oauth',
              access: 'anth-access',
              refresh: 'anth-refresh',
              expires: 9,
            },
          },
        ],
      }) + '\n',
    );
    writeFileSync(
      auth,
      JSON.stringify({
        xai: { type: 'oauth', access: 'xai-a', refresh: 'xai-r', expires: 9 },
        'kimi-coding': { type: 'oauth', access: 'kimi-a', refresh: 'kimi-r', expires: 9 },
        'openai-codex': { type: 'oauth', access: 'codex-a', refresh: 'codex-r', expires: 9 },
      }) + '\n',
    );
    const read = createNativeCredentialReader({
      poolFilePath: pool,
      authJsonPath: auth,
      readOpenRouterKey: () => 'sk-or-fake',
    });
    const anth = await read('anthropic', 'acct-a');
    const xai = await read('xai', ADAPTER_ACCOUNT_IDS.xai);
    const kimi = await read('kimi-coding', ADAPTER_ACCOUNT_IDS['kimi-coding']);
    const codex = await read('openai-codex', ADAPTER_ACCOUNT_IDS['openai-codex']);
    const or = await read('openrouter', ADAPTER_ACCOUNT_IDS.openrouter);
    assert.equal(anth && 'access' in anth ? anth.access : null, 'anth-access');
    assert.equal(xai && 'access' in xai ? xai.access : null, 'xai-a');
    assert.equal(kimi && 'access' in kimi ? kimi.access : null, 'kimi-a');
    assert.equal(codex && 'access' in codex ? codex.access : null, 'codex-a');
    assert.ok(or && 'type' in or && or.type === 'api-key');
    assert.equal(or.access, 'sk-or-fake');
  });
});

describe('bindDetectAndResync + MockKeychain', () => {
  it('overwrites the QLB Keychain item for a drifted xai grant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-resync-bind-'));
    temps.push(dir);
    const store = openStore(join(dir, 'qlb.db'));
    const kc = new MockKeychain();
    const id = ADAPTER_ACCOUNT_IDS.xai;
    const label = ADAPTER_ACCOUNT_LABELS.xai;
    store.upsertAccount(id, 'xai', label);
    kc.setSync(qlbKeychainService('xai', id), label, JSON.stringify(grant('old')));
    const fn = bindDetectAndResync({
      store,
      keychain: kc,
      readNativeCredential: async () => grant('new'),
    });
    const result = await fn(id, 'xai');
    assert.equal(result.resynced, true);
    const stored = parseGrant(kc.getSync(qlbKeychainService('xai', id), label));
    assert.equal(stored.access, 'new');
    store.close();
  });
});

describe('inspectOwnedNativeDrift (read-only)', () => {
  it('warns when copies differ and passes when they match, without writing', async () => {
    let writes = 0;
    const reports = await inspectOwnedNativeDrift({
      accounts: [
        { id: 'xai-default', provider: 'xai', label: 'Grok (xAI)' },
        { id: 'acct-a', provider: 'anthropic', label: 'a@example.com' },
      ],
      migrations: [
        { store: 'pi-xai', state: 'QLB_OWNED' },
        { store: 'pi-pool', state: 'QLB_OWNED' },
      ],
      readNativeCredential: async (provider) =>
        provider === 'xai' ? grant('native') : grant('same'),
      readOwnedCredential: async (provider) => {
        writes += 1;
        return provider === 'xai' ? grant('owned') : grant('same');
      },
    });
    const xai = reports.find((r) => r.accountId === 'xai-default');
    const anth = reports.find((r) => r.accountId === 'acct-a');
    assert.equal(xai?.level, 'WARN');
    assert.equal(xai?.matches, false);
    assert.equal(anth?.level, 'PASS');
    assert.equal(anth?.matches, true);
    assert.equal(writes, 2);
  });
});

describe('qlb doctor native-sync checks', () => {
  it('reports drift for a QLB_OWNED account without writing Keychain', async () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-doctor-resync-'));
    temps.push(home);
    const cfg = defaultConfig(home);
    const store = openStore(cfg.dbPath);
    store.upsertAccount('xai-default', 'xai', 'Grok (xAI)');
    store.upsertMigration('pi-xai', 'QLB_OWNED');
    store.close();
    const kc = new MockKeychain();
    kc.setSync(
      qlbKeychainService('xai', 'xai-default'),
      'Grok (xAI)',
      JSON.stringify(grant('qlb-copy')),
    );
    const report = await doctorQlb(cfg, {
      command: () => 'ok',
      keychain: kc,
      readNativeCredential: async () => grant('native-copy'),
    });
    const check = report.checks.find((c) => c.name === 'native-sync:xai-default');
    assert.ok(check);
    assert.equal(check.level, 'WARN');
    assert.match(check.message, /DIFFERS from native/);
    const still = parseResyncCredential(
      kc.getSync(qlbKeychainService('xai', 'xai-default'), 'Grok (xAI)'),
    );
    assert.equal(still.access, 'qlb-copy');
  });
});

describe('proxy retry-once wiring on upstream 401', () => {
  async function listenMock(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<{ server: http.Server; url: string }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    return { server, url: `http://127.0.0.1:${addr.port}` };
  }

  async function post(
    port: number,
    token: string,
  ): Promise<{ status: number; json: unknown }> {
    const payload = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5--qlb-high', messages: [] }));
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            host: `127.0.0.1:${port}`,
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': payload.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json: unknown = text;
            try {
              json = JSON.parse(text);
            } catch {
              // keep
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  it('retries the same request once after a resync, and does not resync on the second 401', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-proxy-resync-'));
    temps.push(dir);
    const store = openStore(join(dir, 'qlb.db'));
    store.upsertAccount('acct-a', 'anthropic', 'acct-a');
    setPolicy(store, {
      harness: 'claude-code',
      virtualModel: 'claude-sonnet-5--qlb-high',
      realModel: 'claude-sonnet-5',
      effort: 'high',
    });

    const seen: string[] = [];
    const mock = await listenMock((req, res) => {
      const auth = String(req.headers.authorization ?? '');
      seen.push(auth);
      req.resume();
      req.on('end', () => {
        if (auth === 'Bearer new-token') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'OAuth access token has been revoked' }));
        }
      });
    });

    let cred = 'old-token';
    let resyncCalls = 0;
    const proxy = new LoopbackProxy({
      store,
      infoPath: join(dir, 'proxy.json'),
      idleTimeoutMs: 60_000,
      getCredentialForAccount: async () => cred,
      resyncFromNative: async () => {
        resyncCalls += 1;
        cred = 'new-token';
        return { resynced: true, reason: 'native credential differed' };
      },
      upstreams: { anthropicBase: mock.url, codexBase: mock.url },
    });
    await proxy.start();
    try {
      const r = await post(proxy.proxyInfo.port, proxy.proxyInfo.token);
      assert.equal(r.status, 200);
      assert.deepEqual(seen, ['Bearer old-token', 'Bearer new-token']);
      assert.equal(resyncCalls, 1);
      const modes = store.listDecisions().map((d) => d.mode);
      assert.ok(modes.includes('native_resync'));
      assert.ok(modes.includes('proxy'));
      const resyncRow = store.listDecisions().find((d) => d.mode === 'native_resync');
      assert.ok(resyncRow);
      const snap = JSON.parse(resyncRow.snapshot_json) as { kind: string; resynced: boolean };
      assert.equal(snap.kind, 'native_resync');
      assert.equal(snap.resynced, true);
    } finally {
      await proxy.stop();
      mock.server.close();
      store.close();
    }
  });

  it('records genuine revocation (resynced: false) and does not retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qlb-proxy-revoke-'));
    temps.push(dir);
    const store = openStore(join(dir, 'qlb.db'));
    store.upsertAccount('acct-a', 'anthropic', 'acct-a');
    setPolicy(store, {
      harness: 'claude-code',
      virtualModel: 'claude-sonnet-5--qlb-high',
      realModel: 'claude-sonnet-5',
      effort: 'high',
    });
    let hits = 0;
    let resyncCalls = 0;
    const mock = await listenMock((req, res) => {
      hits += 1;
      req.resume();
      req.on('end', () => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'revoked' }));
      });
    });
    const proxy = new LoopbackProxy({
      store,
      infoPath: join(dir, 'proxy.json'),
      idleTimeoutMs: 60_000,
      getCredentialForAccount: async () => 'same-token',
      resyncFromNative: async () => {
        resyncCalls += 1;
        return {
          resynced: false,
          reason: 'native credential identical to QLB copy (genuine revocation; re-auth required)',
        };
      },
      upstreams: { anthropicBase: mock.url, codexBase: mock.url },
    });
    await proxy.start();
    try {
      const r = await post(proxy.proxyInfo.port, proxy.proxyInfo.token);
      assert.equal(r.status, 401);
      assert.equal(hits, 1);
      assert.equal(resyncCalls, 1);
      const resyncRow = store.listDecisions().find((d) => d.mode === 'native_resync');
      assert.ok(resyncRow);
      const snap = JSON.parse(resyncRow.snapshot_json) as { resynced: boolean; kind: string };
      assert.equal(snap.kind, 'native_resync');
      assert.equal(snap.resynced, false);
      assert.match(resyncRow.reason, /genuine revocation/);
    } finally {
      await proxy.stop();
      mock.server.close();
      store.close();
    }
  });
});

describe('auth-failure classifiers', () => {
  it('detects 401 HTTP status and revoked-token stream text, not generic 400s', () => {
    assert.equal(isAuthHttpStatus(401), true);
    assert.equal(isAuthHttpStatus(403), false);
    assert.equal(isAuthHttpStatus(200), false);
    assert.equal(isAuthFailureText('401 OAuth access token has been revoked'), true);
    assert.equal(isAuthFailureText('invalid_grant'), true);
    assert.equal(
      isAuthFailureText(
        '400 {"type":"error","error":{"message":"Third-party apps now draw from your extra usage"}}',
      ),
      false,
    );
  });
});

