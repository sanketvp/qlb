import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { CSWAP_ANTHROPIC_STORE, CONSUME_STATE, fingerprintAccess } from '../src/cswap-consume';
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

function authFingerprint(req: http.IncomingMessage): string {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const token = typeof value === 'string' ? value.replace(/^Bearer\s+/i, '') : '';
  return fingerprintAccess(token);
}

async function withProxy(
  getCredentialForAccount: () => Promise<string>,
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
    getCredentialForAccount: async () => getCredentialForAccount(),
    upstreams: { anthropicBase: mock.url, codexBase: mock.url },
  });
  await proxy.start();
  return { proxy, store, mock: mock.server };
}

const BODY = {
  model: 'claude-sonnet-5--qlb-high',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('consume 401 re-GET', () => {
  it('resync-unchanged', async () => {
    let reads = 0;
    const fps: string[] = [];
    const { proxy, store, mock } = await withProxy(
      async () => {
        reads += 1;
        return 'access-a';
      },
      (req, res) => {
        fps.push(authFingerprint(req));
        res.writeHead(401);
        res.end('{}');
      },
    );
    try {
      const result = await post(proxy.proxyInfo.port, proxy.proxyInfo.token, BODY);
      assert.equal(result.status, 401);
      console.log(`READS=${reads} UPSTREAM_FPS=${fps.length} RETRY=0`);
      assert.equal(reads, 2);
      assert.equal(fps.length, 1);
      assert.equal(fps[0], fingerprintAccess('access-a'));
    } finally {
      await proxy.stop();
      mock.close();
      store.close();
    }
  });

  it('resync-changed', async () => {
    let reads = 0;
    const tokens = ['access-a', 'access-b'];
    const fps: string[] = [];
    const { proxy, store, mock } = await withProxy(
      async () => {
        const token = tokens[Math.min(reads, tokens.length - 1)]!;
        reads += 1;
        return token;
      },
      (req, res) => {
        fps.push(authFingerprint(req));
        if (fps.length === 1) {
          res.writeHead(401);
          res.end('{}');
          return;
        }
        res.writeHead(200);
        res.end('{}');
      },
    );
    try {
      const result = await post(proxy.proxyInfo.port, proxy.proxyInfo.token, BODY);
      assert.equal(result.status, 200);
      console.log(`READS=${reads} UPSTREAM_FPS=${fps.length} RETRY=1`);
      assert.equal(reads, 2);
      assert.deepEqual(fps, [fingerprintAccess('access-a'), fingerprintAccess('access-b')]);
    } finally {
      await proxy.stop();
      mock.close();
      store.close();
    }
  });

  it('resync-between-read-rotation', async () => {
    let reads = 0;
    const tokens = ['access-a', 'access-b', 'access-c'];
    const fps: string[] = [];
    const { proxy, store, mock } = await withProxy(
      async () => {
        const token = tokens[Math.min(reads, tokens.length - 1)]!;
        reads += 1;
        return token;
      },
      (req, res) => {
        fps.push(authFingerprint(req));
        if (fps.length === 1) {
          res.writeHead(401);
          res.end('{}');
          return;
        }
        res.writeHead(200);
        res.end('{}');
      },
    );
    try {
      const result = await post(proxy.proxyInfo.port, proxy.proxyInfo.token, BODY);
      assert.equal(result.status, 200);
      console.log(`READS=${reads} UPSTREAM_FPS=${fps.length} SENT_SECOND=${fps[1] === fingerprintAccess('access-b') ? 'b' : 'other'}`);
      assert.equal(reads, 2);
      assert.deepEqual(fps, [fingerprintAccess('access-a'), fingerprintAccess('access-b')]);
      assert.notEqual(fps[1], fingerprintAccess('access-c'));
    } finally {
      await proxy.stop();
      mock.close();
      store.close();
    }
  });
});
