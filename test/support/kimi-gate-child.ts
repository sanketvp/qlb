import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

import { QLB_KEYCHAIN_ACCOUNT, qlbKeychainService } from '../../src/keychain';
import { runPiGate } from '../../src/pi-gate';
import { consumeKimiCodingCredential } from '../../src/single-consume';
import { resolve } from '../../src/token/kimi-coding';
import { FileKeychain } from './file-keychain';

const [command, provider, dbPath, credentialPath, tracePath, readyPath, startPath, home] = process.argv.slice(2);

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

async function waitForStart(): Promise<void> {
  writeFileSync(readyPath, '', { mode: 0o600 });
  const deadline = Date.now() + 15_000;
  while (!existsSync(startPath)) {
    if (Date.now() > deadline) throw new Error('fixture start timeout');
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
}

function loopbackTransport() {
  return {
    request: async (request: { url: string; method: 'POST'; headers: Record<string, string>; body: string }) => {
      const url = new URL(request.url);
      if (url.hostname !== '127.0.0.1') throw new Error('fixture rejected non-loopback request');
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(5_000),
      });
      let body: unknown = null;
      try { body = await response.json(); } catch { /* refresh classifies malformed fixture replies */ }
      return { status: response.status, body };
    },
  };
}

async function main(): Promise<void> {
  if (command !== 'gate' || provider !== 'kimi-coding' || !dbPath || !credentialPath || !tracePath || !readyPath || !startPath || !home) {
    throw new Error('fixture usage');
  }
  if (process.env.QLB_TEST_MODE !== '1' || !process.env.QLB_HOME || !process.env.HOME) {
    throw new Error('fixture isolation missing');
  }
  await waitForStart();
  const keychain = new FileKeychain(credentialPath);
  const stderr: string[] = [];
  let deliveredFingerprint = '';
  const started = Date.now();
  const disabledLock = process.env.QLB_GATE_FIXTURE_DISABLE_LOCK === '1';
  const exitCode = await runPiGate('kimi-coding', {
    dbPath,
    env: process.env,
    guard: () => true,
    admitted: () => ({ ok: true }),
    prerequisites: () => undefined,
    cswapProcesses: () => [],
    stderr: (line) => stderr.push(line),
    sqlTrace: (sql) => { if (sql === 'BEGIN IMMEDIATE') appendFileSync(tracePath, `${sql}\n`, { mode: 0o600 }); },
    deliver: (value) => {
      const parsed = JSON.parse(value) as { token: string };
      deliveredFingerprint = fingerprint(parsed.token);
    },
    provider: {
      read: () => resolve({ keychain }),
      refresh: async (current, context) => {
        const credential = await consumeKimiCodingCredential({
          access: current?.token ?? '',
          expires: current?.expiresAt ?? 0,
        }, {
          keychain,
          home,
          env: process.env,
          ...(disabledLock ? { lock: { withLock: async <T>(_name: 'xai' | 'kimi-coding', work: () => Promise<T>) => work() } } : {}),
          transport: loopbackTransport(),
          onLineage: context?.onLineage,
          onDead: context?.onDead,
        });
        return {
          token: credential.access,
          accountId: 'default',
          expiresAt: credential.expires,
          source: 'fixture-file-keychain',
        };
      },
    },
  });
  process.stdout.write(`${JSON.stringify({ exitCode, elapsedMs: Date.now() - started, fingerprint: deliveredFingerprint, stderr })}\n`);
}

void main().catch(() => {
  process.stderr.write('kimi gate fixture failed\n');
  process.exitCode = 1;
});
