// Registers qlb-pi's Anthropic provider for the `consume` and `conflict` modes.
// Dependency-injected so tests drive the exact wiring index.ts uses.

import { QLB_RUNTIME_AUTH_SENTINEL } from "./providers/openai-codex.js";
import { CONSUME_ERRORS, CSWAP_ACTIVE_ID } from "./consume.js";

export interface EventSink {
  push(event: unknown): void;
  end(): void;
}

export interface ModelLike {
  id: string;
  api?: unknown;
  provider?: unknown;
}

export interface AnthropicNativeProvider {
  id: "anthropic";
  name: string;
  baseUrl?: string;
  auth: {
    apiKey: {
      name: string;
      check(): Promise<{ type: "api_key"; source: string }>;
      resolve(): Promise<{ auth: { apiKey: string }; source: string }>;
    };
  };
  getModels(): readonly ModelLike[];
  stream: (model: ModelLike, context: unknown, options?: Record<string, unknown>) => unknown;
  streamSimple: (model: ModelLike, context: unknown, options?: Record<string, unknown>) => unknown;
}

export interface ProviderApi {
  unregisterProvider(name: string): void;
  registerProvider(provider: AnthropicNativeProvider): void;
}

export interface ConsumeUnavailableDeps {
  createStream: () => EventSink;
  models?: readonly ModelLike[];
  baseUrl?: string;
  recordOutcome: (entry: Record<string, unknown>) => void;
}

export function errorEvent(model: ModelLike, message: string): Record<string, unknown> {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
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
      stopReason: "error",
      errorMessage: message,
      timestamp: Date.now(),
    },
  };
}

function qlbManagedAuth() {
  return {
    apiKey: {
      name: "QLB consume",
      // A complete native Provider prevents Pi from merging the built-in OAuth
      // handler; index.ts installs this sentinel before file-backed auth lookup.
      async check() { return { type: "api_key" as const, source: "QLB consume" }; },
      async resolve() {
        return { auth: { apiKey: QLB_RUNTIME_AUTH_SENTINEL }, source: "QLB consume" };
      },
    },
  };
}

/** Fail-closed stub: replaces any existing Anthropic provider and never reads credentials. */
export function registerConflictProvider(
  pi: ProviderApi,
  createStream: () => EventSink,
  message: string = CONSUME_ERRORS.conflict,
  catalog: Pick<ConsumeUnavailableDeps, "models" | "baseUrl"> = {},
): void {
  const streamSimple = (model: ModelLike) => {
    const output = createStream();
    output.push(errorEvent(model, message));
    output.end();
    return output;
  };
  pi.unregisterProvider("anthropic");
  pi.registerProvider({
    id: "anthropic",
    name: "Anthropic (QLB consume unavailable)",
    ...(catalog.baseUrl ? { baseUrl: catalog.baseUrl } : {}),
    auth: qlbManagedAuth(),
    getModels: () => catalog.models ?? [],
    stream: streamSimple,
    streamSimple,
  });
}

/** Consume mode has no credential-attributable provider quota reading, so fail before any credential read. */
export function registerUnavailableConsumeProvider(
  pi: ProviderApi,
  deps: ConsumeUnavailableDeps,
): void {
  const streamSimple = (model: ModelLike) => {
    const output = deps.createStream();
    deps.recordOutcome({
      accountId: CSWAP_ACTIVE_ID,
      provider: "anthropic",
      model: model.id,
      outcome: "unavailable",
      error: CONSUME_ERRORS.quotaUnavailable,
    });
    output.push(errorEvent(model, CONSUME_ERRORS.quotaUnavailable));
    output.end();
    return output;
  };
  pi.unregisterProvider("anthropic");
  pi.registerProvider({
    id: "anthropic",
    name: "Anthropic (QLB consume unavailable)",
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    auth: qlbManagedAuth(),
    getModels: () => deps.models ?? [],
    stream: streamSimple,
    streamSimple,
  });
}
