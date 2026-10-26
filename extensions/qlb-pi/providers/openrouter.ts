import { spawn } from 'node:child_process';
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

type ModelLike = { id: string; api?: unknown; provider?: unknown };
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
}

export interface ProviderApi {
  unregisterProvider(name: string): void;
  // Pi's ExtensionAPI has an overloaded registration signature. The source
  // deliberately needs only this narrow call surface.
  registerProvider(name: string, config: any): void;
}

function findQlbCli(): { command: string; prefix: string[] } {
  if (process.env.QLB_CLI) return { command: process.execPath, prefix: [process.env.QLB_CLI] };
  const repoCli = join(__dirname, '..', '..', '..', 'dist', 'cli.js');
  return { command: process.execPath, prefix: [repoCli] };
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

function defaultRuntime(): Pick<Required<OpenRouterSourceDeps>, 'transport' | 'createStream'> {
  // Loaded only in Pi. Keeping this out of the module top-level lets unit tests
  // exercise every credential boundary without a Pi installation.
  const runtime = module.require('@earendil-works/pi-ai/compat') as {
    createAssistantMessageEventStream(): EventSink;
    openAICompletionsApi(): { streamSimple: OpenRouterTransport };
    anthropicMessagesApi(): { streamSimple: OpenRouterTransport };
  };
  const openai = runtime.openAICompletionsApi().streamSimple;
  const anthropic = runtime.anthropicMessagesApi().streamSimple;
  return {
    createStream: () => runtime.createAssistantMessageEventStream(),
    transport: (model, context, options) =>
      (model.api === 'anthropic-messages' ? anthropic : openai)(model, context, options),
  };
}

/**
 * Per-request OpenRouter source. The QLB gate is the sole credential source;
 * a failed gate produces one fail-closed event and never calls transport.
 */
export function createOpenRouterStream(deps: OpenRouterSourceDeps = {}) {
  const runtime = deps.transport && deps.createStream ? undefined : defaultRuntime();
  const transport = deps.transport ?? runtime!.transport;
  const createStream = deps.createStream ?? runtime!.createStream;
  const run = deps.run ?? runGate;

  return (model: ModelLike, context: unknown, options?: Record<string, unknown>): EventSink => {
    const output = createStream();
    void (async () => {
      try {
        const result = await run(
          ['gate', 'openrouter', '--json'],
          { ...process.env, QLB_PI_TOKEN_CALL: '1' },
        );
        if (result.code !== 0) throw new Error('gate failed');
        const access = parseAccess(result.stdout);
        for await (const event of transport(model, context, { ...options, apiKey: access.token })) {
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

/** Registers only the OpenRouter provider when its v2 owner entry is present. */
export function registerOpenRouterSource(pi: ProviderApi, deps: OpenRouterSourceDeps = {}): boolean {
  const mode = decidePiMode('openrouter', {
    rehearsal: process.env.QLB_PI_REHEARSAL,
    owner: ownerState(deps),
    marker: false,
  });
  if (mode === 'inert') return false;

  pi.unregisterProvider('openrouter');
  if (mode === 'owned') {
    pi.registerProvider('openrouter', { streamSimple: createOpenRouterStream(deps) });
  } else {
    const runtime = deps.createStream ? undefined : defaultRuntime();
    const createStream = deps.createStream ?? runtime!.createStream;
    pi.registerProvider('openrouter', {
      streamSimple: (model: ModelLike) => {
        const output = createStream();
        output.push(qlbUnavailable('openrouter', 'owner-file-malformed', model));
        output.end();
        return output;
      },
    });
  }
  return true;
}
