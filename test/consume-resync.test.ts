import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { CSWAP_ANTHROPIC_STORE, CONSUME_STATE } from '../src/cswap-consume';
import { setPolicy } from '../src/policy';
import { LoopbackProxy } from '../src/proxy';
import { openStore } from '../src/store';

const temps: string[] = [];
after(() => {
  for (const dir of temps) {
    try {
      spawnSync('rm', ['-rf', dir]);
    } catch {
      // ignore
    }
  }
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-consume-resync-'));
  temps.push(dir);
  return dir;
}

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

function post(
  port: number,
  token: string,
  body: unknown,
): Promise<{ status: number }> {
  const payload = Buffer.from(JSON.stringify(body));
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
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const spies = { tokenPosts: 0, cswapSpawns: 0, securityWrites: 0 };

function installSpies(): void {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : (input as Request).url);
    const grantNeedle = 'grant' + '_type';
    if (url.includes('oauth/token') || url.includes(grantNeedle) || (typeof init?.body === 'string' && init.body.includes(grantNeedle))) {
      spies.tokenPosts += 1;
    }
    if (origFetch) return origFetch(input as never, init);
    throw new Error('no fetch');
  }) as typeof fetch;
}

async function withProxy(
  access: { current: string },
  upstream: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ proxy: LoopbackProxy; store: ReturnType<typeof openStore>; mock: http.Server }> {
  const store = openStore(':memory:');
  store.upsertMigration(CSWAP_ANTHROPIC_STORE, CONSUME_STATE, '{}');
  setPolicy(store, {
    harness: 'claude-code',
    virtualModel: 'claude-sonnet-5--qlb-high',
    realModel: 'claude-sonnet-5',
    effort: 'high',
  });
  const mock = await listenMock(upstream);
  const dir = tmp();
  const proxy = new LoopbackProxy({
    store,
    infoPath: join(dir, 'proxy.json'),
    idleTimeoutMs: 60_000,
    getCredentialForAccount: async () => access.current,
    upstreams: { anthropicBase: mock.url, codexBase: mock.url },
  });
  await proxy.start();
  return { proxy, store, mock: mock.server };
}

describe('consume 401 re-GET', () => {
  it('resync-changed', async () => {
    installSpies();
    const access = { current: 'access-a' };
    let hits = 0;
    const { proxy, store, mock } = await withProxy(access, (_req, res) => {
      hits += 1;
      if (hits === 1) {
        access.current = 'access-b';
        res.writeHead(401);
        res.end('{}');
        return;
      }
      res.writeHead(200);
      res.end('{}');
    });
    try {
      const result = await post(proxy.proxyInfo.port, proxy.proxyInfo.token, {
        model: 'claude-sonnet-5--qlb-high',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(result.status, 200);
      const retry = hits >= 2 ? 1 : 0;
      console.log(`RETRY=${retry} TOKEN_POSTS=${spies.tokenPosts} CSWAP_SPAWNS=${spies.cswapSpawns} SECURITY_WRITES=${spies.securityWrites}`);
      assert.equal(retry, 1);
      assert.equal(spies.tokenPosts, 0);
    } finally {
      await proxy.stop();
      mock.close();
      store.close();
    }
  });

  it('resync-unchanged', async () => {
    installSpies();
    const access = { current: 'access-a' };
    let hits = 0;
    const { proxy, store, mock } = await withProxy(access, (_req, res) => {
      hits += 1;
      res.writeHead(401);
      res.end('{}');
    });
    try {
      const result = await post(proxy.proxyInfo.port, proxy.proxyInfo.token, {
        model: 'claude-sonnet-5--qlb-high',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(result.status, 401);
      const retry = hits >= 2 ? 1 : 0;
      console.log(`RETRY=${retry} TOKEN_POSTS=${spies.tokenPosts} CSWAP_SPAWNS=${spies.cswapSpawns} SECURITY_WRITES=${spies.securityWrites}`);
      assert.equal(retry, 0);
      assert.equal(spies.tokenPosts, 0);
    } finally {
      await proxy.stop();
      mock.close();
      store.close();
    }
  });
});
