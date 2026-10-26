import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { qlbUnavailable, type ActiveAccess, type ActiveAccessSource } from '../active-access.js';

export interface XaiModel {
  id: string;
  api?: unknown;
  provider?: unknown;
}

export interface XaiEventSink {
  push(event: unknown): void;
  end(): void;
}

export interface XaiProviderApi {
  unregisterProvider(name: string): void;
  registerProvider(name: string, config: {
    api: string;
    streamSimple: (model: XaiModel, context: unknown, options?: Record<string, unknown>) => unknown;
  }): void;
}

export type XaiBuiltin = (
  model: XaiModel,
  context: unknown,
  options: Record<string, unknown>,
) => AsyncIterable<unknown>;

export type XaiGate = () => Promise<unknown>;

interface GateProcessResult {
  stdout: string;
  code: number;
}

export type XaiGateProcess = (args: string[]) => Promise<GateProcessResult>;

function xaiGateFailure(): Error {
  // Do not expose a child-process error or a gate response: either can contain
  // sensitive material. The stream boundary turns this into a fixed error event.
  return new Error('xai-gate-unavailable');
}

function narrowAccess(value: unknown): ActiveAccess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw xaiGateFailure();
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.token !== 'string' || candidate.token.length === 0 ||
      typeof candidate.accountId !== 'string' || candidate.accountId.length === 0 ||
      typeof candidate.source !== 'string' || candidate.source.length === 0) {
    throw xaiGateFailure();
  }
  const result: ActiveAccess = {
    token: candidate.token,
    accountId: candidate.accountId,
    source: candidate.source,
  };
  if (typeof candidate.expiresAt === 'number' && Number.isFinite(candidate.expiresAt)) {
    result.expiresAt = candidate.expiresAt;
  }
  return result;
}

function defaultGateProcess(args: string[]): Promise<GateProcessResult> {
  const repoCli = join(__dirname, '..', '..', '..', 'dist', 'cli.js');
  const command = existsSync(repoCli) ? process.execPath : 'qlb';
  const commandArgs = existsSync(repoCli) ? [repoCli, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, QLB_PI_TOKEN_CALL: '1' },
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout, code: code ?? 1 }));
  });
}

/** Build a one-request gate adapter; process execution is injectable for tests. */
export function createXaiGate(process: XaiGateProcess = defaultGateProcess): XaiGate {
  return async () => {
    let result: GateProcessResult;
    try {
      result = await process(['gate', 'xai', '--json']);
    } catch {
      throw xaiGateFailure();
    }
    if (result.code !== 0) throw xaiGateFailure();
    try {
      return narrowAccess(JSON.parse(result.stdout));
    } catch {
      throw xaiGateFailure();
    }
  };
}

/** Source used by the extension registry; it requests a new gate result per Pi request. */
export function createXaiAccessSource(gate: XaiGate = createXaiGate()): ActiveAccessSource {
  return {
    provider: 'xai',
    async read(): Promise<ActiveAccess> {
      try {
        return narrowAccess(await gate());
      } catch {
        throw xaiGateFailure();
      }
    },
  };
}

export interface RegisterXaiProviderDeps {
  createStream(): XaiEventSink;
  gate?: XaiGate;
}

/**
 * Replace Pi's native xAI source only after migration selects this provider.
 * Every request obtains its ephemeral access token through `qlb gate xai`;
 * native Pi credentials are never read as a fallback.
 */
export function registerXaiProvider(
  pi: XaiProviderApi,
  builtin: XaiBuiltin,
  deps: RegisterXaiProviderDeps,
): void {
  const source = createXaiAccessSource(deps.gate);
  pi.unregisterProvider('xai');
  pi.registerProvider('xai', {
    api: 'openai-completions',
    streamSimple: (model, context, options = {}) => {
      const output = deps.createStream();
      void (async () => {
        try {
          const access = await source.read();
          for await (const event of builtin(model, context, { ...options, apiKey: access.token })) {
            output.push(event);
          }
        } catch {
          output.push(qlbUnavailable('xai', 'unknown', model));
        } finally {
          output.end();
        }
      })();
      return output;
    },
  });
}
