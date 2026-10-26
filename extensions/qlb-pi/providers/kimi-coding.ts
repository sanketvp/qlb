import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { qlbUnavailable, type ActiveAccess } from '../active-access.js';
import { decidePiMode, ownerStateForProvider, readPiOwnerFile } from '../consume.js';

const PROVIDER = 'kimi-coding';
const OWNER_FILE = join(homedir(), '.pi', 'agent', 'qlb-owner.json');

type ModelLike = { id: string; api?: unknown; provider?: unknown };
type Stream = { push(event: unknown): void; end(): void };
type Builtin = (model: ModelLike, context: unknown, options?: Record<string, unknown>) => AsyncIterable<unknown>;

export interface GateResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface KimiCodingSourceDeps {
  gate?: (signal?: AbortSignal) => Promise<GateResult>;
}

export interface KimiCodingProviderDeps extends KimiCodingSourceDeps {
  /** Test seam; production consults only the v2 owner entry for this provider. */
  owned?: () => boolean;
  createStream?: () => Stream;
  builtin?: Builtin;
}

function findQlbCli(): { command: string; prefix: string[] } {
  if (process.env.QLB_CLI) return { command: process.execPath, prefix: [process.env.QLB_CLI] };
  const repoCli = join(__dirname, '..', '..', '..', 'dist', 'cli.js');
  return existsSync(repoCli) ? { command: process.execPath, prefix: [repoCli] } : { command: 'qlb', prefix: [] };
}

// P13 may wait up to 60 seconds for a concurrent single-consume winner.
const GATE_TIMEOUT_MS = 65_000;

function defaultGate(signal?: AbortSignal): Promise<GateResult> {
  if (signal?.aborted) return Promise.reject(new Error('request-aborted'));
  const { command, prefix } = findQlbCli();
  return new Promise((resolve, reject) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (result: (() => void)) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      result();
    };
    const abort = () => {
      child.kill('SIGTERM');
      finish(() => reject(new Error('request-aborted')));
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() => reject(new Error('gate-timeout')));
    }, GATE_TIMEOUT_MS);
    try {
      child = spawn(command, [...prefix, 'gate', PROVIDER, '--json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, QLB_PI_TOKEN_CALL: '1' },
      });
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => reject(new Error(error.code === 'ENOENT' ? 'missing-binary' : 'unknown')));
    });
    child.on('close', (code) => finish(() => resolve({ code: code ?? 1, stdout, stderr })));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function gateCause(result: GateResult): string {
  const value = result.stderr.trim().replace(/^qlb gate: refused: /, '');
  return /^[a-z][a-z0-9-]*$/.test(value) || /^phase=[a-z-]+$/.test(value) ? value : 'unknown';
}

function parseAccess(stdout: string): ActiveAccess {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('unknown');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('unknown');
  const access = value as Record<string, unknown>;
  if (typeof access.token !== 'string' || access.token === '' ||
      typeof access.accountId !== 'string' || access.accountId === '' ||
      typeof access.source !== 'string' || access.source === '') throw new Error('unknown');
  const result: ActiveAccess = { token: access.token, accountId: access.accountId, source: access.source };
  if (typeof access.expiresAt === 'number' && Number.isFinite(access.expiresAt)) result.expiresAt = access.expiresAt;
  return result;
}

/** A fresh QLB gate call is deliberately made for every provider request. */
export function createKimiCodingSource(deps: KimiCodingSourceDeps = {}): { provider: typeof PROVIDER; read(signal?: AbortSignal): Promise<ActiveAccess> } {
  return {
    provider: PROVIDER,
    async read(signal?: AbortSignal): Promise<ActiveAccess> {
      const result = await (deps.gate ?? defaultGate)(signal);
      if (result.code !== 0) throw new Error(gateCause(result));
      return parseAccess(result.stdout);
    },
  };
}

async function builtinKimiCoding(): Promise<Builtin> {
  // Keep this runtime import aligned with index.ts's compatibility seam while
  // allowing the CommonJS CLI test build to compile the provider source.
  const specifier: string = '@earendil-works/pi-ai/compat';
  const namespace = await import(specifier) as unknown as {
    openAICompletionsApi?: () => { streamSimple?: Builtin };
  };
  const transport = namespace.openAICompletionsApi?.().streamSimple;
  if (typeof transport !== 'function') throw new Error('unknown');
  return transport;
}

function abortedRequest(model: ModelLike): {
  type: 'error';
  reason: 'aborted';
  error: {
    role: 'assistant';
    content: [];
    api: unknown;
    provider: typeof PROVIDER;
    model: string;
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } };
    stopReason: 'aborted';
    errorMessage: string;
    timestamp: number;
  };
} {
  // Match Pi's native provider convention: an aborted request is an error event
  // with reason and stopReason both set to "aborted", not a provider outage.
  return {
    type: 'error',
    reason: 'aborted',
    error: {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: PROVIDER,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'aborted',
      errorMessage: 'Request was aborted',
      timestamp: Date.now(),
    },
  };
}

function fallbackStream(): Stream {
  const queue: unknown[] = [];
  let closed = false;
  let waiting: ((value: IteratorResult<unknown>) => void) | undefined;
  return {
    push(event) {
      if (closed) return;
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve({ done: false, value: event });
      } else {
        queue.push(event);
      }
    },
    end() {
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve({ done: true, value: undefined });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          const event = queue.shift();
          if (event !== undefined) return Promise.resolve({ done: false, value: event });
          if (closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve) => { waiting = resolve; });
        },
      };
    },
  } as Stream;
}

function qlbOwnsKimiCoding(): boolean {
  // A malformed ownership file is intercepted too: the gate then exposes its
  // stable failure cause instead of falling back to Pi's native credential.
  return decidePiMode(PROVIDER, {
    rehearsal: process.env.QLB_PI_REHEARSAL,
    owner: ownerStateForProvider(readPiOwnerFile(OWNER_FILE), PROVIDER),
  }) !== 'inert';
}

function qlbRequestOptions(options: Record<string, unknown> | undefined, token: string): Record<string, unknown> {
  const inheritedHeaders = options?.headers;
  const headers = inheritedHeaders && typeof inheritedHeaders === 'object' && !Array.isArray(inheritedHeaders)
    ? Object.fromEntries(Object.entries(inheritedHeaders).filter(([name]) => name.toLowerCase() !== 'authorization'))
    : {};
  // Pi resolves native Kimi OAuth before this source. openai-completions merges
  // request headers last, so retain no inherited Authorization value here.
  return { ...options, apiKey: token, headers: { ...headers, Authorization: `Bearer ${token}` } };
}

/** Installs a fail-closed Kimi source without ever consulting Pi's stored OAuth grant. */
export function registerKimiCodingProvider(
  pi: {
    unregisterProvider(name: string): void;
    registerProvider(name: string, config: {
      api: string;
      streamSimple: (model: ModelLike, context: unknown, options?: Record<string, unknown>) => Stream;
    }): void;
  },
  deps: KimiCodingProviderDeps = {},
): void {
  const owned = deps.owned ?? qlbOwnsKimiCoding;
  if (!owned()) return;
  const source = createKimiCodingSource(deps);
  const createStream = deps.createStream ?? fallbackStream;
  const builtin = deps.builtin;

  pi.unregisterProvider(PROVIDER);
  pi.registerProvider(PROVIDER, {
    api: 'openai-completions',
    streamSimple: (model, context, options) => {
      const output = createStream();
      void (async () => {
        const signal = options?.signal instanceof AbortSignal ? options.signal : undefined;
        try {
          // Re-read ownership on every request. A rollback must never fall through
          // to Pi's native OAuth grant while this source remains registered.
          if (!owned()) throw new Error('owner-entry-missing');
          const access = await source.read(signal);
          if (signal?.aborted) {
            output.push(abortedRequest(model));
            return;
          }
          const transport = builtin ?? await builtinKimiCoding();
          for await (const event of transport(model, context, qlbRequestOptions(options, access.token))) output.push(event);
        } catch (error) {
          if (signal?.aborted) {
            output.push(abortedRequest(model));
          } else {
            const cause = error instanceof Error ? error.message : 'unknown';
            output.push(qlbUnavailable(PROVIDER, cause, model));
          }
        } finally {
          output.end();
        }
      })();
      return output;
    },
  });
}
