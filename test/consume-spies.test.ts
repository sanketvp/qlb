import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const nodeRequire = createRequire(__filename);
const httpMod = nodeRequire('node:http') as typeof http;
const httpsMod = nodeRequire('node:https') as typeof https;
const cpMod = nodeRequire('node:child_process') as typeof cp;

import { createOwnedCredentialSource } from '../src/credentials';
import {
  CSWAP_ANTHROPIC_STORE,
  CONSUME_STATE,
} from '../src/cswap-consume';
import type { KeychainBackend } from '../src/keychain';
import { setPolicy } from '../src/policy';
import { LoopbackProxy } from '../src/proxy';
import { openStore } from '../src/store';

const spies = { tokenPosts: 0, cswapSpawns: 0, securityWrites: 0, securityFinds: 0 };

const origHttpRequest = httpMod.request;
const origHttpsRequest = httpsMod.request;
const origSpawn = cpMod.spawn;
const origSpawnSync = cpMod.spawnSync;
const origExecFile = cpMod.execFile;
const origExecFileSync = cpMod.execFileSync;
const origExec = cpMod.exec;
const origExecSync = cpMod.execSync;

function argvOf(file: unknown, args: unknown): string[] {
  const head = typeof file === 'string' ? file : String(file ?? '');
  const rest = Array.isArray(args) ? args.map((a) => String(a)) : [];
  return [head, ...rest];
}

function isCswap(file: unknown, args: unknown): boolean {
  return argvOf(file, args).some((part) => /(^|\/)cswap$/.test(part) || part === 'cswap');
}

function isSecurityWrite(file: unknown, args: unknown): boolean {
  const argv = argvOf(file, args);
  const joined = argv.join(' ');
  return /add-generic-password|delete-generic-password|security -i/.test(joined);
}

function isSecurityFind(file: unknown, args: unknown): boolean {
  const argv = argvOf(file, args);
  return argv.some((p) => p.endsWith('security') || p === '/usr/bin/security')
    && argv.includes('find-generic-password');
}

function isTokenPost(urlOrOpts: unknown, body: unknown): boolean {
  let url = '';
  if (typeof urlOrOpts === 'string' || urlOrOpts instanceof URL) {
    url = String(urlOrOpts);
  } else if (urlOrOpts && typeof urlOrOpts === 'object') {
    const o = urlOrOpts as { path?: string; href?: string; hostname?: string; host?: string };
    url = `${o.href ?? ''} ${o.hostname ?? o.host ?? ''}${o.path ?? ''}`;
  }
  const text = `${url} ${typeof body === 'string' || Buffer.isBuffer(body) ? String(body) : ''}`;
  const grantNeedle = 'grant' + '_type';
  return text.includes('/oauth/token') || text.includes(grantNeedle);
}

function wrapRequest(
  orig: typeof http.request,
): typeof http.request {
  return function patchedRequest(this: unknown, ...args: unknown[]) {
    const req = (orig as (...a: unknown[]) => http.ClientRequest).apply(this, args);
    const origEnd = req.end.bind(req);
    req.end = ((body?: unknown, encoding?: unknown, cb?: unknown) => {
      if (isTokenPost(args[0], body) || (args.length > 1 && isTokenPost(args[1], body))) {
        spies.tokenPosts += 1;
      }
      return origEnd(body as never, encoding as never, cb as never);
    }) as typeof req.end;
    return req;
  } as typeof http.request;
}

function noteChild(file: unknown, args: unknown): 'cswap' | 'sec-write' | 'sec-find' | null {
  if (isCswap(file, args)) {
    spies.cswapSpawns += 1;
    return 'cswap';
  }
  if (isSecurityWrite(file, args)) {
    spies.securityWrites += 1;
    return 'sec-write';
  }
  if (isSecurityFind(file, args)) {
    spies.securityFinds += 1;
    return 'sec-find';
  }
  return null;
}

function patch<T extends object>(obj: T, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { configurable: true, writable: true, value });
}

function installBoundarySpies(): void {
  patch(httpMod, 'request', wrapRequest(origHttpRequest));
  patch(httpsMod, 'request', wrapRequest(origHttpsRequest));

  patch(cpMod, 'execFileSync', ((file: unknown, args?: unknown, options?: unknown) => {
    const kind = noteChild(file, args);
    if (kind === 'cswap') return '';
    if (kind === 'sec-write') return '';
    if (kind === 'sec-find') return '';
    return origExecFileSync(file as string, args as string[], options as object);
  }) as typeof cp.execFileSync);

  patch(cpMod, 'execFile', ((file: unknown, args?: unknown, options?: unknown, callback?: unknown) => {
    const kind = noteChild(file, typeof args === 'function' ? [] : args);
    if (kind === 'cswap' || kind === 'sec-write' || kind === 'sec-find') {
      const cb = [args, options, callback].find((x) => typeof x === 'function') as
        | ((err: Error | null, stdout: string, stderr: string) => void)
        | undefined;
      const stdout = '';
      cb?.(null, stdout, '');
      return origSpawn(process.execPath, ['-e', 'process.exit(0)']);
    }
    return origExecFile.apply(cp, [file, args, options, callback] as never);
  }) as typeof cp.execFile);

  patch(cpMod, 'spawn', ((file: unknown, args?: unknown, options?: unknown) => {
    const kind = noteChild(file, args);
    if (kind === 'cswap' || kind === 'sec-write') {
      return origSpawn(process.execPath, ['-e', 'process.exit(0)'], options as object);
    }
    return origSpawn.apply(cp, [file, args, options] as never);
  }) as typeof cp.spawn);

  patch(cpMod, 'spawnSync', ((file: unknown, args?: unknown, options?: unknown) => {
    const kind = noteChild(file, args);
    if (kind === 'cswap' || kind === 'sec-write') {
      return { status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null } as ReturnType<typeof cp.spawnSync>;
    }
    if (kind === 'sec-find') return { status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null } as ReturnType<typeof cp.spawnSync>;
    return origSpawnSync.apply(cp, [file, args, options] as never);
  }) as typeof cp.spawnSync);

  patch(cpMod, 'exec', ((command: unknown, options?: unknown, callback?: unknown) => {
    noteChild(String(command).split(/\s+/)[0], String(command).split(/\s+/).slice(1));
    return origExec.apply(cp, [command, options, callback] as never);
  }) as typeof cp.exec);

  patch(cpMod, 'execSync', ((command: unknown, options?: unknown) => {
    const parts = String(command).split(/\s+/);
    const kind = noteChild(parts[0], parts.slice(1));
    if (kind === 'cswap' || kind === 'sec-write') return Buffer.from('');
    if (kind === 'sec-find') return Buffer.from('');
    return origExecSync.apply(cp, [command, options] as never);
  }) as typeof cp.execSync);
}

function restoreBoundarySpies(): void {
  patch(httpMod, 'request', origHttpRequest);
  patch(httpsMod, 'request', origHttpsRequest);
  patch(cpMod, 'spawn', origSpawn);
  patch(cpMod, 'spawnSync', origSpawnSync);
  patch(cpMod, 'execFile', origExecFile);
  patch(cpMod, 'execFileSync', origExecFileSync);
  patch(cpMod, 'exec', origExec);
  patch(cpMod, 'execSync', origExecSync);
}

after(() => {
  restoreBoundarySpies();
});

function resetSpies(): void {
  spies.tokenPosts = 0;
  spies.cswapSpawns = 0;
  spies.securityWrites = 0;
  spies.securityFinds = 0;
}

// Any QLB-owned Keychain access on the consume path is a defect: count and refuse.
let ownedKeychainCalls = 0;
const refusingKeychain = new Proxy({}, {
  get: () => () => {
    ownedKeychainCalls += 1;
    throw new Error('owned keychain must not be touched on the consume path');
  },
}) as KeychainBackend;

interface ConsumeRun {
  status: number;
}

/** Drive one consumed request through the production proxy boundary. */
async function runConsumeThroughProxy(): Promise<ConsumeRun> {
  const store = openStore(':memory:');
  store.upsertMigration(CSWAP_ANTHROPIC_STORE, CONSUME_STATE, '{}');
  setPolicy(store, {
    harness: 'claude-code',
    virtualModel: 'claude-sonnet-5--qlb-high',
    realModel: 'claude-sonnet-5',
    effort: 'high',
  });
  const dir = mkdtempSync(join(tmpdir(), 'qlb-spy-proxy-'));
  const proxy = new LoopbackProxy({
    store,
    infoPath: join(dir, 'proxy.json'),
    idleTimeoutMs: 60_000,
    getCredentialForAccount: createOwnedCredentialSource({
      store,
      keychain: refusingKeychain,
    }),
    upstreams: { anthropicBase: 'http://127.0.0.1:1', codexBase: 'http://127.0.0.1:1' },
  });
  await proxy.start();
  try {
    const result = await post(proxy.proxyInfo.port, proxy.proxyInfo.token, {
      model: 'claude-sonnet-5--qlb-high',
      messages: [{ role: 'user', content: 'hi' }],
    });
    return { status: result.status };
  } finally {
    await proxy.stop();
    store.close();
  }
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

describe('consume injected spies', () => {
  it('consume admission stops before credential reads without authoritative quota', async () => {
    installBoundarySpies();
    resetSpies();

    resetSpies();
    ownedKeychainCalls = 0;
    const changed = await runConsumeThroughProxy();
    console.log(`CHANGED SECURITY_FINDS=${spies.securityFinds} TOKEN_POSTS=${spies.tokenPosts} CSWAP_SPAWNS=${spies.cswapSpawns} SECURITY_WRITES=${spies.securityWrites}`);
    assert.equal(changed.status, 503);
    assert.equal(spies.securityFinds, 0);
    assert.equal(spies.tokenPosts, 0);
    assert.equal(spies.cswapSpawns, 0);
    assert.equal(spies.securityWrites, 0);
    assert.equal(ownedKeychainCalls, 0);
  });

  it('mutation controls make each counter nonzero', () => {
    installBoundarySpies();
    resetSpies();

    const req = https.request({
      hostname: '127.0.0.1',
      port: 1,
      path: '/oauth/token',
      method: 'POST',
    });
    req.on('error', () => undefined);
    req.end(['grant', '_type=refresh_token'].join(''));
    assert.ok(spies.tokenPosts > 0, 'TOKEN_POSTS mutation did not fire');

    cp.spawnSync('cswap', ['list']);
    assert.ok(spies.cswapSpawns > 0, 'CSWAP_SPAWNS mutation did not fire');

    cp.execFileSync('/usr/bin/security', ['add-generic-password', '-a', 'qlb-mutation-never', '-s', 'qlb-mutation-never']);
    assert.ok(spies.securityWrites > 0, 'SECURITY_WRITES mutation did not fire');

    console.log(`MUTATION TOKEN_POSTS=${spies.tokenPosts} CSWAP_SPAWNS=${spies.cswapSpawns} SECURITY_WRITES=${spies.securityWrites}`);
  });

});
