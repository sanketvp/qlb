import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

type ModelLike = { id: string; api?: unknown; provider?: unknown; baseUrl?: unknown; [key: string]: unknown };
export type OpenRouterModelsConfig = {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  oauth?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelLike[];
  modelOverrides?: Record<string, ModelLike>;
};
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
  /** Pi's models.json OpenRouter provider config, if configured. */
  modelsJson?: OpenRouterModelsConfig;
  /** Pi's models.json OpenRouter provider baseUrl, if configured. */
  baseUrl?: string;
}

interface OpenRouterProviderConfig {
  api: typeof STREAM_API;
  baseUrl?: string;
  streamSimple: (model: ModelLike, context: unknown, options?: Record<string, unknown>) => EventSink;
  models: ModelLike[];
}

export interface ProviderApi {
  unregisterProvider(name: string): void | Promise<void>;
  registerProvider(name: string, config: OpenRouterProviderConfig): void | Promise<void>;
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
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: '', stderr: error.code === 'ENOENT' ? 'missing-binary' : '' });
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
  const value = result.stderr.trim().replace(/^qlb gate: refused: /, '');
  return result.code === 0 ? 'unknown' : value || 'unknown';
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

/** Pi's JSONC normalizer: comments and trailing commas are accepted by models.json. */
function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ''))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ''));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the OpenRouter part of models.json with Pi's JSONC normalization. Pi does
 * not expose its composed catalog through ExtensionAPI, so this preserves the
 * same provider layer before the gated extension replaces that catalog.
 */
export function readOpenRouterModelsJson(path: string): OpenRouterModelsConfig | undefined {
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')));
    if (!isObject(parsed) || !isObject(parsed.providers) || !isObject(parsed.providers.openrouter)) return undefined;
    const config = parsed.providers.openrouter;
    if ((config.baseUrl !== undefined && typeof config.baseUrl !== 'string') ||
        (config.api !== undefined && typeof config.api !== 'string') ||
        (config.apiKey !== undefined && typeof config.apiKey !== 'string') ||
        (config.oauth !== undefined && typeof config.oauth !== 'string') ||
        (config.authHeader !== undefined && typeof config.authHeader !== 'boolean') ||
        (config.headers !== undefined && !isObject(config.headers)) ||
        (config.models !== undefined && !Array.isArray(config.models)) ||
        (config.modelOverrides !== undefined && !isObject(config.modelOverrides))) return undefined;
    if (config.models?.some((model) => !isObject(model) || typeof model.id !== 'string' || model.id.length === 0)) return undefined;
    return config as OpenRouterModelsConfig;
  } catch {
    // ModelConfig treats unreadable or invalid files as an empty provider map.
    return undefined;
  }
}

/**
 * Pi 1.4.0 provider-composer.js applyModelsJson() rejects a provider config
 * before it applies an extension registration. Keep this exact precondition in
 * front of the queued registration: otherwise Pi catches the rejection and
 * restores its native, credential-backed OpenRouter provider.
 */
export class OpenRouterModelsJsonBlockedError extends Error {}

export function openRouterModelsJsonRegistrationError(config?: OpenRouterModelsConfig): string | undefined {
  if (!config) return undefined;
  if (config.oauth && !config.baseUrl) {
    return 'Provider openrouter: "baseUrl" is required when "oauth" is set.';
  }
  const hasOverrides = !!config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
  if (!config.models?.length && !config.baseUrl && !config.headers && !config.compat &&
      !hasOverrides && !config.apiKey && !config.oauth && config.authHeader === undefined) {
    return 'Provider openrouter: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".';
  }
  return undefined;
}

function mergeModelOverride(model: ModelLike, override: ModelLike | undefined): ModelLike {
  if (!override) return model;
  const baseCompat = isObject(model.compat) ? model.compat : undefined;
  const overrideCompat = isObject(override.compat) ? override.compat : undefined;
  return {
    ...model,
    ...override,
    id: model.id,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    compat: overrideCompat ? { ...baseCompat, ...overrideCompat } : model.compat,
  };
}

/** Mirrors Pi's applyModelsJson upsert/baseUrl/override order for OpenRouter chat models. */
export function composeOpenRouterModels(baseModels: ModelLike[], config?: OpenRouterModelsConfig): ModelLike[] {
  const models: ModelLike[] = baseModels.map((model) => ({
    ...model,
    baseUrl: config?.baseUrl ?? model.baseUrl,
    compat: config?.compat && isObject(model.compat) ? { ...model.compat, ...config.compat } : model.compat,
  }));
  for (const definition of config?.models ?? []) {
    const existingIndex = models.findIndex((model) => model.id === definition.id);
    const defaults = existingIndex >= 0
      ? models[existingIndex]
      : models.find((model) => model.api === definition.api)
        ?? models.find((model) => model.api === config?.api)
        ?? models.find((model) => model.api === STREAM_API)
        ?? models[0];
    const api = definition.api ?? config?.api ?? defaults?.api;
    const baseUrl = definition.baseUrl ?? config?.baseUrl ?? defaults?.baseUrl;
    if (typeof api !== 'string' || typeof baseUrl !== 'string' || baseUrl.length === 0) {
      throw new Error(`qlb-pi: OpenRouter model ${definition.id} has no API or baseUrl`);
    }
    const model: ModelLike = {
      id: definition.id,
      name: definition.name ?? definition.id,
      api,
      provider: 'openrouter',
      baseUrl,
      reasoning: definition.reasoning ?? false,
      thinkingLevelMap: definition.thinkingLevelMap,
      input: definition.input ?? ['text'],
      inputLimits: definition.inputLimits,
      cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      promptCache: definition.promptCache,
      contextWindow: definition.contextWindow ?? 128000,
      maxTokens: definition.maxTokens ?? 16384,
      samplingParams: definition.samplingParams,
      samplingParamsByThinkingLevel: definition.samplingParamsByThinkingLevel,
      compat: definition.compat ?? (config?.compat && isObject(defaults?.compat) ? { ...defaults.compat, ...config.compat } : undefined),
    };
    if (existingIndex >= 0) models[existingIndex] = model;
    else models.push(model);
  }
  return models.map((model) => mergeModelOverride(model, config?.modelOverrides?.[model.id]));
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
export async function registerOpenRouterUnavailableSource(pi: ProviderApi, createStream: () => EventSink): Promise<void> {
  await pi.unregisterProvider('openrouter');
  // An empty catalog prevents built-in chat, image and classifier models from
  // falling through while the replacement source cannot be initialized.
  await pi.registerProvider('openrouter', {
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
export async function registerOpenRouterSource(pi: ProviderApi, deps: OpenRouterSourceDeps = {}): Promise<boolean> {
  const mode = openRouterSourceMode(deps);
  if (mode === 'inert') return false;
  const modelsJsonError = openRouterModelsJsonRegistrationError(deps.modelsJson);
  if (modelsJsonError) throw new OpenRouterModelsJsonBlockedError(modelsJsonError);

  const createStream = deps.createStream;
  if (!createStream) throw new Error('qlb-pi: OpenRouter event stream is unavailable');
  const models = normalizedModels(deps.models);
  const unavailable: OpenRouterProviderConfig = {
    api: STREAM_API,
    models: [],
    streamSimple: failClosedStream(createStream, mode === 'owned' ? 'unknown' : 'owner-file-malformed'),
  };
  await pi.unregisterProvider('openrouter');
  // Extension-load registrations are queued by Pi. Queue a valid empty source
  // first: if Pi later rejects the real source, it leaves this replacement
  // registered instead of restoring the native credential-backed provider.
  await pi.registerProvider('openrouter', unavailable);
  if (mode !== 'owned') return true;
  try {
    await pi.registerProvider('openrouter', {
      api: STREAM_API,
      ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
      models,
      streamSimple: createOpenRouterStream(deps),
    });
  } catch {
    // The already-registered empty source remains active. This also covers
    // direct (post-load) registrations whose validation rejects asynchronously.
  }
  return true;
}
