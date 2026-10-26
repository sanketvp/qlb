import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { qlbUnavailable, type ActiveAccess } from '../active-access.js';
import {
  decidePiMode,
  ownerStateForProvider,
  parsePiOwnerFile,
  readPiOwnerFile,
} from '../consume.js';

const OWNER_FILE = join(homedir(), '.pi', 'agent', 'qlb-owner.json');
const STREAM_API = 'openai-completions' as const;
const AUTH_HEADERS = new Set(['authorization', 'x-api-key', 'cf-aig-authorization']);

type ModelLike = { id: string; api?: unknown; provider?: unknown; [key: string]: unknown };
type EventSink = AsyncIterable<unknown> & { push(value: unknown): void; end(): void };
export type OpenRouterTransport = (
  model: ModelLike,
  context: unknown,
  options?: Record<string, unknown>,
) => AsyncIterable<unknown>;
export type GateRun = (
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface OpenRouterSourceDeps {
  ownerPath?: string;
  /** Test seam; undefined represents an absent owner file. */
  readOwner?: (path: string) => string | undefined;
  run?: GateRun;
  transport?: OpenRouterTransport;
  createStream?: () => EventSink;
  /** Pi's built-in OpenRouter chat catalog, supplied by index.ts's compat import. */
  models?: ModelLike[];
}

interface OpenRouterProviderConfig {
  api: typeof STREAM_API;
  streamSimple: (model: ModelLike, context: unknown, options?: Record<string, unknown>) => EventSink;
  models: ModelLike[];
}

export interface ProviderApi {
  unregisterProvider(name: string): void;
  registerProvider(name: string, config: OpenRouterProviderConfig): void;
}

function findQlbCli(): { command: string; prefix: string[] } {
  if (process.env.QLB_CLI) return { command: process.execPath, prefix: [process.env.QLB_CLI] };
  const repoCli = join(__dirname, '..', '..', '..', 'dist', 'cli.js');
  if (existsSync(repoCli)) return { command: process.execPath, prefix: [repoCli] };
  return { command: 'qlb', prefix: [] };
}

/** Runs only the gate command; stderr and malformed output never reach Pi's event sink. */
export const runGate: GateRun = async (args, env) => {
  const { command, prefix } = findQlbCli();
  return new Promise((resolve) => {
    const child = spawn(command, [...prefix, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 15_000);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: '', stderr: '' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
};

function parseAccess(stdout: string): ActiveAccess {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('invalid gate output'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid gate output');
  const record = parsed as Record<string, unknown>;
  if (typeof record.token !== 'string' || record.token.length === 0 ||
      typeof record.accountId !== 'string' || record.accountId.length === 0 ||
      typeof record.source !== 'string' || record.source.length === 0) {
    throw new Error('invalid gate output');
  }
  return { token: record.token, accountId: record.accountId, source: record.source };
}

function safeGateCause(result: { code: number; stderr: string }): string {
  return result.code === 0 ? 'unknown' : result.stderr.trim() || 'unknown';
}

/** Pi lets caller headers win over adapter defaults, so never pass stored auth through. */
function withoutStoredAuth(options?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!options?.headers || typeof options.headers !== 'object' || Array.isArray(options.headers)) return options;
  const headers = Object.fromEntries(
    Object.entries(options.headers as Record<string, unknown>)
      .filter(([name]) => !AUTH_HEADERS.has(name.toLowerCase())),
  );
  return { ...options, headers };
}

function normalizedModels(models: ModelLike[] | undefined): ModelLike[] {
  // Pi dispatches streamSimple only when model.api equals provider.api. Replacing
  // the chat catalog with a single API family keeps both native OpenRouter chat
  // dialects inside this gate; index.ts's transport restores the original API.
  return (models ?? []).map((model) => ({ ...model, api: STREAM_API }));
}

/**
 * Per-request OpenRouter source. The QLB gate is the sole credential source;
 * a failed gate produces one fail-closed event and never calls transport.
 */
export function createOpenRouterStream(deps: OpenRouterSourceDeps = {}) {
  if (!deps.transport || !deps.createStream) {
    throw new Error('qlb-pi: OpenRouter runtime is unavailable');
  }
  const transport = deps.transport;
  const createStream = deps.createStream;
  const run = deps.run ?? runGate;

  return (model: ModelLike, context: unknown, options?: Record<string, unknown>): EventSink => {
    const output = createStream();
    void (async () => {
      try {
        const result = await run(
          ['gate', 'openrouter', '--json'],
          { ...process.env, QLB_PI_TOKEN_CALL: '1' },
        );
        if (result.code !== 0) {
          output.push(qlbUnavailable('openrouter', safeGateCause(result), model));
          return;
        }
        const access = parseAccess(result.stdout);
        const safeOptions = withoutStoredAuth(options);
        for await (const event of transport(model, context, { ...safeOptions, apiKey: access.token })) {
          output.push(event);
        }
      } catch {
        output.push(qlbUnavailable('openrouter', 'unknown', model));
      } finally {
        output.end();
      }
    })();
    return output;
  };
}

function ownerState(deps: OpenRouterSourceDeps): ReturnType<typeof ownerStateForProvider> {
  const path = deps.ownerPath ?? OWNER_FILE;
  if (!deps.readOwner) return ownerStateForProvider(readPiOwnerFile(path), 'openrouter');
  try {
    const text = deps.readOwner(path);
    return ownerStateForProvider(text === undefined ? { kind: 'absent' } : parsePiOwnerFile(text), 'openrouter');
  } catch {
    return 'malformed';
  }
}

function failClosedStream(createStream: () => EventSink, cause: string) {
  return (model: ModelLike): EventSink => {
    const output = createStream();
    output.push(qlbUnavailable('openrouter', cause, model));
    output.end();
    return output;
  };
}

/** Registers a fail-closed replacement if Pi compat cannot be loaded. */
export function registerOpenRouterUnavailableSource(pi: ProviderApi, createStream: () => EventSink): void {
  pi.unregisterProvider('openrouter');
  // An empty catalog prevents built-in chat, image and classifier models from
  // falling through while the replacement source cannot be initialized.
  pi.registerProvider('openrouter', {
    api: STREAM_API,
    models: [],
    streamSimple: failClosedStream(createStream, 'unknown'),
  });
}

export function openRouterSourceMode(deps: OpenRouterSourceDeps = {}): 'inert' | 'owned' | 'conflict' {
  return decidePiMode('openrouter', {
    rehearsal: process.env.QLB_PI_REHEARSAL,
    owner: ownerState(deps),
    marker: false,
  }) as 'inert' | 'owned' | 'conflict';
}

/** Registers only the OpenRouter provider when its v2 owner entry is present. */
export function registerOpenRouterSource(pi: ProviderApi, deps: OpenRouterSourceDeps = {}): boolean {
  const mode = openRouterSourceMode(deps);
  if (mode === 'inert') return false;

  const createStream = deps.createStream;
  if (!createStream) throw new Error('qlb-pi: OpenRouter event stream is unavailable');
  pi.unregisterProvider('openrouter');
  const models = normalizedModels(deps.models);
  pi.registerProvider('openrouter', mode === 'owned'
    ? { api: STREAM_API, models, streamSimple: createOpenRouterStream(deps) }
    : { api: STREAM_API, models, streamSimple: failClosedStream(createStream, 'owner-file-malformed') });
  return true;
}
