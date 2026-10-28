// QLB-backed OpenAI Codex access source (§4.7.2).
//
// The source reader accepts an injected gate runner; the registration adapter
// invokes the QLB gate per request and never falls back to Pi's persisted OAuth entry.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { qlbUnavailable } from '../active-access.js';
import type { ActiveAccess, ActiveAccessSource } from '../active-access.js';

export interface GateResult {
  code: number;
  stdout: string;
  /** A stable gate failure code only; never surface raw stderr to Pi. */
  stderr?: string;
}

/** Injectable process boundary for `qlb gate openai-codex --json`. */
export type GateRunner = (provider: 'openai-codex') => Promise<GateResult>;

export interface OpenAICodexSourceDeps {
  runGate: GateRunner;
}

type GatePayload = {
  token?: unknown;
  accountId?: unknown;
  chatgptAccountId?: unknown;
  expiresAt?: unknown;
  source?: unknown;
};

class OpenAICodexGateFailure extends Error {
  constructor(readonly causeCode = 'unknown') {
    // Do not expose gate stdout/stderr: either may contain credential material.
    super('QLB gate openai-codex unavailable');
  }
}

function unavailable(causeCode = 'unknown'): OpenAICodexGateFailure {
  return new OpenAICodexGateFailure(causeCode);
}

function gateCause(stderr: string | undefined): string {
  const cause = stderr?.trim().replace(/^qlb gate: refused: /, '') ?? '';
  return /^[a-z][a-z0-9=-]*$/.test(cause) ? cause : 'unknown';
}

function failureCause(error: unknown): string {
  if (error instanceof OpenAICodexGateFailure) return error.causeCode;
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? 'missing-binary' : 'unknown';
}

function parseGatePayload(stdout: string): ActiveAccess {
  let payload: GatePayload;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unavailable();
    payload = parsed as GatePayload;
  } catch {
    throw unavailable();
  }

  if (
    typeof payload.token !== 'string' || !payload.token
    || typeof payload.accountId !== 'string' || !payload.accountId
    || typeof payload.chatgptAccountId !== 'string' || !payload.chatgptAccountId
    || typeof payload.source !== 'string' || !payload.source
    || (payload.expiresAt !== undefined && (typeof payload.expiresAt !== 'number' || !Number.isFinite(payload.expiresAt)))
  ) {
    throw unavailable();
  }

  return {
    token: payload.token,
    accountId: payload.accountId,
    chatgptAccountId: payload.chatgptAccountId,
    ...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
    source: payload.source,
  };
}

/** A per-request gate source; callers register it with the P1 access registry. */
export function createOpenAICodexSource(deps: OpenAICodexSourceDeps): ActiveAccessSource {
  return {
    provider: 'openai-codex',
    async read(): Promise<ActiveAccess> {
      let result: GateResult;
      try {
        result = await deps.runGate('openai-codex');
      } catch (error) {
        throw unavailable(failureCause(error));
      }
      if (result.code !== 0) throw unavailable(gateCause(result.stderr));
      return parseGatePayload(result.stdout);
    },
  };
}

/** Headers for Pi's OpenAI Codex transport. The account header is never the QLB composite slot id. */
export function openAICodexHeaders(access: ActiveAccess): Record<'Authorization' | 'ChatGPT-Account-Id', string> {
  if (!access.chatgptAccountId) throw unavailable();
  return {
    Authorization: `Bearer ${access.token}`,
    'ChatGPT-Account-Id': access.chatgptAccountId,
  };
}

export interface OpenAICodexModel {
  id: string;
  api?: unknown;
  provider?: unknown;
}

export interface OpenAICodexEventSink {
  push(event: unknown): void;
  end(): void;
}

export const QLB_RUNTIME_AUTH_SENTINEL = 'qlb-managed';

export interface OpenAICodexNativeProvider {
  id: 'openai-codex';
  name: string;
  baseUrl?: string;
  auth: {
    apiKey: {
      name: string;
      check(): Promise<{ type: 'api_key'; source: string }>;
      resolve(): Promise<{ auth: { apiKey: string }; source: string }>;
    };
  };
  getModels(): readonly OpenAICodexModel[];
  stream: (model: OpenAICodexModel, context: unknown, options?: Record<string, unknown>) => unknown;
  streamSimple: (model: OpenAICodexModel, context: unknown, options?: Record<string, unknown>) => unknown;
}

export interface OpenAICodexProviderApi {
  unregisterProvider(name: string): void;
  registerProvider(provider: OpenAICodexNativeProvider): void;
}

export type OpenAICodexBuiltin = (
  model: OpenAICodexModel,
  context: unknown,
  options: Record<string, unknown>,
) => AsyncIterable<unknown>;

export interface RegisterOpenAICodexProviderDeps {
  createStream(): OpenAICodexEventSink;
  /** Built-in catalog metadata is safe to retain; built-in auth is never retained. */
  models?: readonly OpenAICodexModel[];
  baseUrl?: string;
  /** Injectable only for tests; production invokes `qlb gate openai-codex`. */
  runGate?: GateRunner;
}

function findQlbCli(): { command: string; prefix: string[] } {
  if (process.env.QLB_CLI) return { command: process.execPath, prefix: [process.env.QLB_CLI] };
  const repoCli = join(__dirname, '..', '..', '..', 'dist', 'cli.js');
  return existsSync(repoCli) ? { command: process.execPath, prefix: [repoCli] } : { command: 'qlb', prefix: [] };
}

/** Process boundary for the production per-request gate. */
function runOpenAICodexGate(_provider: 'openai-codex'): Promise<GateResult> {
  const { command, prefix } = findQlbCli();
  return new Promise((resolve) => {
    const child = spawn(command, [...prefix, 'gate', 'openai-codex', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, QLB_PI_TOKEN_CALL: '1' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: GateResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* child already exited */ }
      finish({ code: 1, stdout: '', stderr: '' });
    }, 15_000);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error: NodeJS.ErrnoException) => finish({
      code: 1,
      stdout: '',
      stderr: error.code === 'ENOENT' ? 'missing-binary' : '',
    }));
    child.once('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

function withQlbAccess(options: Record<string, unknown>, access: ActiveAccess): Record<string, unknown> {
  const headers = options.headers;
  const inherited = headers && typeof headers === 'object' && !Array.isArray(headers)
    ? Object.fromEntries(Object.entries(headers).filter(([name]) => {
      const normalized = name.toLowerCase();
      return normalized !== 'authorization' && normalized !== 'chatgpt-account-id';
    }))
    : {};
  return { ...options, apiKey: access.token, headers: { ...inherited, ...openAICodexHeaders(access) } };
}

/**
 * Replaces Pi's native Codex source after QLB owns it. Every request reads a
 * fresh gate result; a failed gate emits one fixed event and never invokes the
 * built-in transport (or Pi's persisted OAuth credential).
 */
export function registerOpenAICodexProvider(
  pi: OpenAICodexProviderApi,
  builtin: OpenAICodexBuiltin,
  deps: RegisterOpenAICodexProviderDeps,
): void {
  const source = createOpenAICodexSource({ runGate: deps.runGate ?? runOpenAICodexGate });
  const streamSimple = (model: OpenAICodexModel, context: unknown, options: Record<string, unknown> = {}) => {
    const output = deps.createStream();
    void (async () => {
      try {
        const access = await source.read();
        for await (const event of builtin(model, context, withQlbAccess(options, access))) {
          output.push(event);
        }
      } catch (error) {
        output.push(qlbUnavailable('openai-codex', failureCause(error), model));
      } finally {
        output.end();
      }
    })();
    return output;
  };
  pi.unregisterProvider('openai-codex');
  // Pi 1.4.0 ModelRuntime merges an omitted extension oauth field with the
  // built-in one (dist/core/provider-composer.js:312-325), and OAuth resolution
  // reads then refreshes the stored entry (pi-ai/dist/auth/resolve.js:24-27,
  // 62-83). Register a complete native provider instead, with no OAuth hooks.
  pi.registerProvider({
    id: 'openai-codex',
    name: 'OpenAI Codex (QLB)',
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    auth: {
      apiKey: {
        name: 'QLB gate',
        // This check lets Pi list the QLB provider without reading auth.json.
        async check() { return { type: 'api_key', source: 'QLB gate' }; },
        async resolve() { return { auth: { apiKey: QLB_RUNTIME_AUTH_SENTINEL }, source: 'QLB gate' }; },
      },
    },
    getModels: () => deps.models ?? [],
    stream: streamSimple,
    streamSimple,
  });
}
