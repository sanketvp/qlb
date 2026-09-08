import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { setPolicy } from '../src/policy';
import { LoopbackProxy, PROXY_BIND_HOST } from '../src/proxy';
import { openStore } from '../src/store';

/**
 * Automated tests talk only to a local mock `http.createServer`.
 * They never contact Anthropic, OpenAI, ChatGPT, or Codex backends.
 */

const temps: string[] = [];
after(() => {
  for (const dir of temps) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qlb-proxy-'));
  temps.push(dir);
  return dir;
}

async function listenMock(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number; url: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return { server, port: addr.port, url: `http://127.0.0.1:${addr.port}` };
}

async function startProxy(opts: {
  store: ReturnType<typeof openStore>;
  mockUrl: string;
  idleTimeoutMs?: number;
  onIdle?: () => void;
}): Promise<LoopbackProxy> {
  const dir = tmp();
  const proxy = new LoopbackProxy({
    store: opts.store,
    infoPath: join(dir, 'proxy.json'),
    idleTimeoutMs: opts.idleTimeoutMs ?? 60_000,
    getCredentialForAccount: async () => 'upstream-secret',
    upstreams: { anthropicBase: opts.mockUrl, codexBase: opts.mockUrl },
    onIdle: opts.onIdle,
  });
  await proxy.start();
  return proxy;
}

function seedAnthropic(store: ReturnType<typeof openStore>): void {
  store.upsertAccount('acct-a', 'anthropic', 'acct-a');
  setPolicy(store, {
    harness: 'claude-code',
    virtualModel: 'claude-sonnet-5--qlb-high',
    realModel: 'claude-sonnet-5',
    effort: 'high',
  });
}

function seedCodex(store: ReturnType<typeof openStore>): void {
  store.upsertAccount('codex-acct', 'openai-codex', 'codex-acct');
  setPolicy(store, {
    harness: 'codex',
    virtualModel: 'gpt-5.4--qlb-high',
    realModel: 'gpt-5.4',
    effort: 'high',
  });
}

async function post(
  port: number,
  path: string,
  body: unknown,
  token: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: unknown; headers: http.IncomingHttpHeaders }> {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {
      host: `127.0.0.1:${port}`,
      'content-type': 'application/json',
      'content-length': payload.length,
      ...extraHeaders,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers,
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
            // keep text
          }
          resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('qlb-proxy — loopback helper §4.9.2 / §4.9.3', () => {
  it('binds only to 127.0.0.1 and writes proxy.json mode 0600', async () => {
    const store = openStore(':memory:');
    const mock = await listenMock((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    const proxy = await startProxy({ store, mockUrl: mock.url });
    try {
      const addr = proxy.address();
      assert.equal(addr.address, PROXY_BIND_HOST);
      const st = statSync(proxy.infoPath);
      assert.equal(st.mode & 0o777, 0o600);
      const info = JSON.parse(readFileSync(proxy.infoPath, 'utf8')) as {
        port: number;
        token: string;
        pid: number;
      };
      assert.equal(info.port, addr.port);
      assert.equal(typeof info.token, 'string');
      assert.ok(info.token.length >= 32);
      assert.equal(info.pid, process.pid);
    } finally {
      await proxy.stop();
      mock.server.close();
      store.close();
    }
  });

  it('requests without the bearer token get 401 BEFORE the mock upstream is called', async () => {
    const store = openStore(':memory:');
    seedAnthropic(store);
    let hits = 0;
    const mock = await listenMock((_req, res) => {
      hits += 1;
      res.writeHead(200);
      res.end('{}');
    });
    const proxy = await startProxy({ store, mockUrl: mock.url });
    try {
      const r = await post(
        proxy.proxyInfo.port,
        '/v1/messages',
        { model: 'claude-sonnet-5--qlb-high', messages: [] },
        null,
      );
      assert.equal(r.status, 401);
      assert.deepEqual(r.json, { error: 'qlb_unauthorized' });
      assert.equal(hits, 0);
    } finally {
      await proxy.stop();
      mock.server.close();
      store.close();
    }
  });

  it('wrong token is 401 and never reaches the mock upstream', async () => {
    const store = openStore(':memory:');
    seedAnthropic(store);
    let hits = 0;
    const mock = await listenMock((_req, res) => {
      hits += 1;
      res.writeHead(200);
      res.end('{}');
    });
    const proxy = await startProxy({ store, mockUrl: mock.url });
    try {
      const r = await post(
        proxy.proxyInfo.port,
        '/v1/messages',
        { model: 'claude-sonnet-5--qlb-high', messages: [] },
        'definitely-not-the-token',
      );
      assert.equal(r.status, 401);
      assert.equal(hits, 0);
    } finally {
      await proxy.stop();
      mock.server.close();
      store.close();
    }
  });

  it('correct token is proxied through; upstream sees injected credential, not the proxy token', async () => {
    const store = openStore(':memory:');
    seedAnthropic(store);
    let hits = 0;
    let seenAuth: string | undefined;
    let seenBody: unknown;
    const mock = await listenMock((req, res) => {
      hits += 1;
      seenAuth = req.headers.authorization;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seenBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'message', id: 'msg_mock' }));
      });
    });
    const proxy = await startProxy({ store, mockUrl: mock.url });
    try {
      const r = await post(
        proxy.proxyInfo.port,
        '/v1/messages',
        { model: 'claude-sonnet-5--qlb-high', messages: [] },
        proxy.proxyInfo.token,
      );
      assert.equal(r.status, 200);
      assert.equal(hits, 1);
      assert.equal(seenAuth, 'Bearer upstream-secret');
      assert.ok(seenBody && typeof seenBody === 'object');
      assert.equal((seenBody as { model: string }).model, 'claude-sonnet-5');
      assert.deepEqual(r.json, { type: 'message', id: 'msg_mock' });
    } finally {
      await proxy.stop();
      mock.server.close();
      store.close();
    }
  });

  it('unmapped virtual model returns 400 with zero calls to the mock upstream', async () => {
    const store = openStore(':memory:');
    store.upsertAccount('acct-a', 'anthropic', 'acct-a');
    let hits = 0;
    const mock = await listenMock((_req, res) => {
      hits += 1;
      res.writeHead(200);
      res.end('{}');
    });
    const proxy = await startProxy({ store, mockUrl: mock.url });
    try {
      const r = await post(
        proxy.proxyInfo.port,
        '/v1/messages',
        { model: 'claude-sonnet-5--qlb-high', messages: [] },
        proxy.proxyInfo.token,
      );
      assert.equal(r.status, 400);
      const body = r.json as { type: string; error: { type: string; message: string } };
      assert.equal(body.type, 'error');
      assert.equal(body.error.type, 'invalid_request_error');
      assert.match(body.error.message, /no policy for model/);
      assert.equal(hits, 0);

      const r2 = await post(
        proxy.proxyInfo.port,
        '/backend-api/codex/responses',
        { model: 'unmapped-codex' },
        proxy.proxyInfo.token,
      );
      assert.equal(r2.status, 400);
      const cbody = r2.json as { detail: string };
      assert.match(cbody.detail, /no policy for model 'unmapped-codex'/);
      assert.equal(hits, 0);
    } finally {
      await proxy.stop();
      mock.server.close();
      store.close();
    }
  });

  it('response headers from the mock upstream are written to the snapshot cache', async () => {
    const store = openStore(':memory:');
    seedCodex(store);
    const mock = await listenMock((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-codex-primary-used-percent': '41.5',
        'x-codex-secondary-used-percent': '12',
        'x-codex-primary-reset-after-seconds': '3600',
      });
      res.end(JSON.stringify({ id: 'resp_mock' }));
    });
    const proxy = await startProxy({ store, mockUrl: mock.url });
    try {
      const r = await post(
        proxy.proxyInfo.port,
        '/backend-api/codex/responses',
        { model: 'gpt-5.4--qlb-high', input: 'hi' },
        proxy.proxyInfo.token,
      );
      assert.equal(r.status, 200);
      const primary = store.getSnapshot('codex-acct', 'primary');
      const secondary = store.getSnapshot('codex-acct', 'secondary');
      assert.ok(primary);
      assert.equal(primary.usedPct, 41.5);
      assert.equal(primary.source, 'headers');
      assert.equal(primary.confidence, 'authoritative');
      assert.ok(secondary);
      assert.equal(secondary.usedPct, 12);
      assert.equal(secondary.source, 'headers');
    } finally {
      await proxy.stop();
      mock.server.close();
      store.close();
    }
  });

  it('idle-exit closes the server after a short inactivity timeout', async () => {
    const store = openStore(':memory:');
    const mock = await listenMock((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    let idled = false;
    const proxy = await startProxy({
      store,
      mockUrl: mock.url,
      idleTimeoutMs: 150,
      onIdle: () => {
        idled = true;
      },
    });
    try {
      assert.ok(proxy.address());
      await delay(400);
      assert.equal(idled, true);
      assert.throws(() => proxy.address());
    } finally {
      await proxy.stop();
      mock.server.close();
      store.close();
    }
  });
});
