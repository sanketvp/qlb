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
  gate?: () => Promise<GateResult>;
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

function defaultGate(): Promise<GateResult> {
  const { command, prefix } = findQlbCli();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, 'gate', PROVIDER, '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, QLB_PI_TOKEN_CALL: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function gateCause(result: GateResult): string {
  const value = result.stderr.trim();
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
export function createKimiCodingSource(deps: KimiCodingSourceDeps = {}): { provider: typeof PROVIDER; read(): Promise<ActiveAccess> } {
  return {
    provider: PROVIDER,
    async read(): Promise<ActiveAccess> {
      const result = await (deps.gate ?? defaultGate)();
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
  if (!(deps.owned ?? qlbOwnsKimiCoding)()) return;
  const source = createKimiCodingSource(deps);
  const createStream = deps.createStream ?? fallbackStream;
  const builtin = deps.builtin;

  pi.unregisterProvider(PROVIDER);
  pi.registerProvider(PROVIDER, {
    api: 'openai-completions',
    streamSimple: (model, context, options) => {
      const output = createStream();
      void (async () => {
        try {
          const access = await source.read();
          const transport = builtin ?? await builtinKimiCoding();
          for await (const event of transport(model, context, { ...options, apiKey: access.token })) output.push(event);
        } catch (error) {
          const cause = error instanceof Error ? error.message : 'unknown';
          output.push(qlbUnavailable(PROVIDER, cause, model));
        } finally {
          output.end();
        }
      })();
      return output;
    },
  });
}
