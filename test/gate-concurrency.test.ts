import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { FileKeychain } from './support/file-keychain';

import { runPiGate } from '../src/pi-gate';
import { beginCutover } from '../src/lifecycle';
import { QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../src/keychain';
import { openStore, openStoreConnection } from '../src/store';

describe('qlb gate evidence concurrency (S54)', () => {
  it('uses the store busy timeout and records both concurrent calls without SQLITE_BUSY', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'qlb-gate-concurrency-')), 'qlb.db');
    const store = openStore(dbPath);
    beginCutover(store);
    store.close();
    const gate = (provider: 'xai' | 'kimi-coding') => runPiGate(provider, {
      dbPath,
      env: { QLB_PI_TOKEN_CALL: '1' },
      deliver: () => undefined,
      guard: () => true,
      admitted: () => ({ ok: true }),
      prerequisites: () => undefined,
      provider: { read: () => ({ token: `fixture-${provider}`, accountId: `${provider}-default`, source: 'fixture' }) },
    });

    assert.deepEqual(await Promise.all([gate('xai'), gate('kimi-coding')]), [0, 0]);

    const db = openStoreConnection(dbPath, true);
    try {
      const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      assert.equal(timeout.timeout, 5_000);
      const rows = db.prepare("SELECT key FROM config WHERE key IN ('pi.xai.lastServedAt', 'pi.kimi-coding.lastServedAt') ORDER BY key").all() as Array<{ key: string }>;
      assert.deepEqual(rows.map((row) => row.key), ['pi.kimi-coding.lastServedAt', 'pi.xai.lastServedAt']);
    } finally {
      db.close();
    }
  });
});

type Fixture = {
  root: string;
  home: string;
  qlbHome: string;
  dbPath: string;
  credentialPath: string;
  tracePath: string;
  startPath: string;
  expectedFingerprint: string;
};

type ChildResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  result?: { exitCode: number; elapsedMs: number; fingerprint: string; stderr: string[] };
};

const CHILD = join(process.cwd(), 'dist-test', 'test', 'support', 'kimi-gate-child.js');
const FIXTURE_ACCESS = 'fixture-kimi-access-next';
const FIXTURE_REFRESH = 'fixture-kimi-refresh-next';

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'qlb-kimi-gate-load-'));
  const home = join(root, 'home');
  const qlbHome = join(root, 'qlb');
  const dbPath = join(qlbHome, 'qlb.db');
  const store = openStore(dbPath);
  beginCutover(store);
  store.close();
  const credentialPath = join(root, 'fixture-keychain.json');
  new FileKeychain(credentialPath).setSync(
    qlbKeychainService('kimi-coding', 'default'),
    QLB_KEYCHAIN_ACCOUNT,
    JSON.stringify({ access: 'fixture-kimi-access-old', refresh: 'fixture-kimi-refresh-old', expires: Date.now() + 50_000 }),
  );
  return {
    root,
    home,
    qlbHome,
    dbPath,
    credentialPath,
    tracePath: join(root, 'sql-trace.log'),
    startPath: join(root, 'start'),
    expectedFingerprint: fingerprint(FIXTURE_ACCESS),
  };
}

async function refreshServer(): Promise<{ host: string; posts: () => number; close: () => Promise<void> }> {
  let postCount = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/oauth/token') {
      response.statusCode = 404;
      response.end();
      return;
    }
    request.resume();
    postCount += 1;
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: FIXTURE_ACCESS, refresh_token: FIXTURE_REFRESH, expires_in: 3_600 }));
    }, 150);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    host: `http://127.0.0.1:${address.port}`,
    posts: () => postCount,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function waitForReady(paths: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const check = (): void => {
      if (paths.every((path) => existsSync(path))) return resolve();
      if (Date.now() > deadline) return reject(new Error('fixture children did not become ready'));
      setTimeout(check, 10);
    };
    check();
  });
}

function childResult(args: string[], env: NodeJS.ProcessEnv): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', CHILD, 'gate', 'kimi-coding', ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => {
      let result: ChildResult['result'];
      try { result = JSON.parse(stdout) as ChildResult['result']; } catch { /* assertion below reports safe process metadata */ }
      resolve({ status, stdout, stderr, result });
    });
  });
}

async function runConcurrentGates(f: Fixture, host: string, count: number): Promise<ChildResult[]> {
  const readyPaths = Array.from({ length: count }, (_, index) => join(f.root, `ready-${index}`));
  const children = readyPaths.map((readyPath) => childResult(
    [f.dbPath, f.credentialPath, f.tracePath, readyPath, f.startPath, f.qlbHome],
    {
      ...process.env,
      QLB_TEST_MODE: '1',
      QLB_HOME: f.qlbHome,
      HOME: f.home,
      KIMI_CODE_OAUTH_HOST: host,
    },
  ));
  await waitForReady(readyPaths);
  writeFileSync(f.startPath, '', { mode: 0o600 });
  return Promise.all(children);
}

function evidenceRows(f: Fixture): number {
  if (!existsSync(f.tracePath)) return 0;
  return readFileSync(f.tracePath, 'utf8').split('\n').filter((line) => line === 'BEGIN IMMEDIATE').length;
}

function servedFingerprint(f: Fixture): string | undefined {
  const db = openStoreConnection(f.dbPath, true);
  try {
    return (db.prepare('SELECT value FROM config WHERE key = ?').get('pi.kimi-coding.lastServedFingerprint') as { value?: string } | undefined)?.value;
  } finally {
    db.close();
  }
}

describe('qlb gate Kimi Coding load (AC29)', () => {
  it('40 concurrent kimi-coding gate processes at 50 s before expiry make one POST and all return the new token within 5 s', async () => {
    const f = fixture();
    const server = await refreshServer();
    try {
      const children = await runConcurrentGates(f, server.host, 40);
      const maxLatency = Math.max(...children.map((child) => child.result?.elapsedMs ?? Infinity));
      console.log(`max latency ${maxLatency} ms`);
      console.log(`evidence rows ${evidenceRows(f)}`);

      assert.equal(server.posts(), 1);
      assert.ok(children.every((child) => child.status === 0 && child.result?.exitCode === 0), 'every fixture gate exits 0');
      assert.ok(children.every((child) => child.result?.fingerprint === f.expectedFingerprint), 'every fixture gate delivered the refreshed token');
      assert.ok(children.every((child) => (child.result?.elapsedMs ?? Infinity) < 5_000), 'every fixture gate completes within 5 s');
      assert.ok(children.every((child) => !/(?:busy|pi:evidence-gap)/i.test(`${child.stderr}\n${child.result?.stderr.join('\n') ?? ''}`)), 'no fixture gate reports busy or an evidence gap');
      assert.equal(evidenceRows(f), 40);
      assert.equal(servedFingerprint(f), f.expectedFingerprint);
    } finally {
      await server.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('the gate never uses a read-only connection: a fixture-held readOnly:true store does not stop its evidence write', async () => {
    const f = fixture();
    const server = await refreshServer();
    const readOnly = openStoreConnection(f.dbPath, true);
    try {
      readOnly.prepare('SELECT count(*) FROM config').get();
      const [child] = await runConcurrentGates(f, server.host, 1);
      assert.equal(child.status, 0);
      assert.equal(child.result?.exitCode, 0);
      assert.equal(child.result?.fingerprint, f.expectedFingerprint);
      assert.ok(!/(?:busy|pi:evidence-gap)/i.test(`${child.stderr}\n${child.result?.stderr.join('\n') ?? ''}`));
      assert.equal(evidenceRows(f), 1);
      assert.equal(servedFingerprint(f), f.expectedFingerprint);
    } finally {
      readOnly.close();
      await server.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
