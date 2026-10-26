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

export type XaiGate = (signal?: AbortSignal) => Promise<unknown>;

interface GateProcessResult {
  stdout: string;
  stderr?: string;
  code: number;
}

export type XaiGateProcess = (args: string[], signal?: AbortSignal) => Promise<GateProcessResult>;

const GATE_TIMEOUT_MS = 75_000;
const MAX_GATE_STDOUT_BYTES = 64 * 1024;
const MAX_GATE_STDERR_BYTES = 4 * 1024;

class XaiGateFailure extends Error {
  constructor(readonly causeCode = 'unknown') {
    super('xai-gate-unavailable');
  }
}

function xaiGateFailure(causeCode = 'unknown'): XaiGateFailure {
  // Do not expose a child-process error or a gate response: either can contain
  // sensitive material. The stream boundary turns this into a fixed error event.
  return new XaiGateFailure(causeCode);
}

function gateCause(stderr: string | undefined): string {
  const value = stderr?.trim().replace(/^qlb gate: refused: /, '') ?? '';
  return /^[a-z][a-z0-9-]*$/.test(value) || /^phase=[a-z-]+$/.test(value) ? value : 'unknown';
}

function failureCause(error: unknown): string {
  return error instanceof XaiGateFailure ? error.causeCode : 'unknown';
}

/** A fixed terminal event: never label a transport failure as a gate failure. */
function xaiRequestError(model: XaiModel, reason: 'error' | 'aborted'): Record<string, unknown> {
  return {
    type: 'error',
    reason,
    error: {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: reason,
      errorMessage: reason === 'aborted' ? 'Request aborted' : 'xAI request failed',
      timestamp: Date.now(),
    },
  };
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

function defaultGateProcess(args: string[], signal?: AbortSignal): Promise<GateProcessResult> {
  const repoCli = join(__dirname, '..', '..', '..', 'dist', 'cli.js');
  const command = existsSync(repoCli) ? process.execPath : 'qlb';
  const commandArgs = existsSync(repoCli) ? [repoCli, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, QLB_PI_TOKEN_CALL: '1' },
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const fail = (cause: string) => {
      try { child.kill('SIGTERM'); } catch { /* child already exited */ }
      settle(() => reject(xaiGateFailure(cause)));
    };
    const onAbort = () => fail('gate-aborted');
    const timeout = setTimeout(() => fail('gate-timeout'), GATE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_GATE_STDOUT_BYTES) {
        fail('gate-output-too-large');
      } else {
        stdout += chunk.toString('utf8');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_GATE_STDERR_BYTES);
    });
    child.once('error', () => fail('missing-binary'));
    child.once('close', (code) => settle(() => resolve({ stdout, stderr, code: code ?? 1 })));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Build a one-request gate adapter; process execution is injectable for tests. */
export function createXaiGate(process: XaiGateProcess = defaultGateProcess): XaiGate {
  return async (signal?: AbortSignal) => {
    let result: GateProcessResult;
    try {
      result = await process(['gate', 'xai', '--json'], signal);
    } catch (error) {
      throw xaiGateFailure(failureCause(error));
    }
    if (result.code !== 0) throw xaiGateFailure(gateCause(result.stderr));
    try {
      return narrowAccess(JSON.parse(result.stdout));
    } catch {
      throw xaiGateFailure();
    }
  };
}

interface XaiAccessSource extends ActiveAccessSource {
  readWithSignal(signal?: AbortSignal): Promise<ActiveAccess>;
}

/** Source used by the extension registry; it requests a new gate result per Pi request. */
export function createXaiAccessSource(gate: XaiGate = createXaiGate()): XaiAccessSource {
  const read = async (signal?: AbortSignal): Promise<ActiveAccess> => {
    try {
      return narrowAccess(await gate(signal));
    } catch (error) {
      throw xaiGateFailure(failureCause(error));
    }
  };
  return { provider: 'xai', read: () => read(), readWithSignal: read };
}

function withQlbAccess(options: Record<string, unknown>, apiKey: string): Record<string, unknown> {
  const headers = options.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return { ...options, apiKey };
  }
  const safeHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'),
  );
  return { ...options, apiKey, headers: safeHeaders };
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
    api: 'openai-responses',
    streamSimple: (model, context, options = {}) => {
      const output = deps.createStream();
      void (async () => {
        const signal = options.signal as AbortSignal | undefined;
        let access: ActiveAccess;
        try {
          access = await source.readWithSignal(signal);
        } catch (error) {
          output.push(signal?.aborted
            ? xaiRequestError(model, 'aborted')
            : qlbUnavailable('xai', failureCause(error), model));
          output.end();
          return;
        }
        try {
          for await (const event of builtin(model, context, withQlbAccess(options, access.token))) {
            output.push(event);
          }
        } catch {
          // The gate succeeded. Do not misrepresent a provider transport failure as QLB unavailable.
          output.push(xaiRequestError(model, signal?.aborted ? 'aborted' : 'error'));
        } finally {
          output.end();
        }
      })();
      return output;
    },
  });
}
