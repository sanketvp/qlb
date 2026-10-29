// Registers qlb-pi's Anthropic provider for the `consume` and `conflict` modes.
// Dependency-injected so tests drive the exact wiring index.ts uses; index.ts
// supplies Pi's real event stream, builtin transport, CLI runner and Keychain reader.

import { streamWithAuthRetry } from "./auth-retry.js";
import { QLB_RUNTIME_AUTH_SENTINEL } from "./providers/openai-codex.js";
import { redactEvent, redactSecrets } from "../../src/redact.js";
import {
  consumeAccessSource,
  CONSUME_ERRORS,
  CSWAP_ACTIVE_ID,
  type CswapActiveAccess,
  type ConsumeJournal,
  type OwnerFileState,
} from "./consume.js";

export interface EventSink {
  push(event: unknown): void;
  end(): void;
}

export interface ModelLike {
  id: string;
  api?: unknown;
  provider?: unknown;
}

export type Builtin = (
  model: ModelLike,
  context: unknown,
  options: Record<string, unknown>,
) => AsyncIterable<unknown>;

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

export interface ConsumeDeps {
  createStream: () => EventSink;
  /** Built-in catalog metadata is safe to retain; built-in auth is never retained. */
  models?: readonly ModelLike[];
  baseUrl?: string;
  /** Per-request journal re-check (`qlb consume status`). */
  consumeJournal: () => Promise<ConsumeJournal>;
  ownerState: () => OwnerFileState;
  readAccess: () => CswapActiveAccess;
  shapePayload: (payload: unknown) => unknown;
  recordOutcome: (entry: Record<string, unknown>) => void;
  onDecision?: (decision: { accountId: string; provider: string; model: string }) => void;
}

const KNOWN_MESSAGES = new Set<string>(Object.values(CONSUME_ERRORS));
const GENERIC_FAILURE = "cswap-active request failed";

/** Only our own fixed messages cross a sink; anything else becomes a generic failure. */
function safeMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return KNOWN_MESSAGES.has(message) ? message : GENERIC_FAILURE;
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
  catalog: Pick<ConsumeDeps, "models" | "baseUrl"> = {},
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

export function registerConsumeProvider(pi: ProviderApi, builtin: Builtin, deps: ConsumeDeps): void {
  const streamSimple = (model: ModelLike, context: unknown, options: Record<string, unknown> = {}) => {
      const output = deps.createStream();
      void (async () => {
        let sent: () => string[] = () => [];
        let pushed = 0;
        try {
          deps.onDecision?.({ accountId: CSWAP_ACTIVE_ID, provider: "anthropic", model: model.id });
          // Re-checked on every request: disabling consume or acquiring QLB
          // ownership mid-session stops serving cswap-active immediately.
          if (deps.ownerState() !== "absent") throw new Error(CONSUME_ERRORS.conflict);
          const journal = await deps.consumeJournal();
          if (journal === "unknown") throw new Error(CONSUME_ERRORS.stateUnknown);
          if (journal !== "CONSUMED") throw new Error(CONSUME_ERRORS.disabled);

          const source = consumeAccessSource(deps.readAccess);
          sent = source.sent;
          const callerOnPayload = options?.onPayload as
            | ((payload: unknown, model: unknown) => unknown)
            | undefined;
          const onPayload = async (payload: unknown, payloadModel: unknown) => {
            const upstream = callerOnPayload
              ? ((await callerOnPayload(payload, payloadModel)) ?? payload)
              : payload;
            return deps.shapePayload(upstream);
          };
          const result = await streamWithAuthRetry({
            readAccess: source.readAccess,
            startStream: (access) =>
              builtin(model, context, { ...options, apiKey: access, onPayload }),
            resync: source.resync,
            onEvent: (event) => {
              pushed += 1;
              output.push(redactEvent(event, source.sent()));
            },
            onResync: (resync) => {
              deps.recordOutcome({
                kind: "consume_reread",
                accountId: CSWAP_ACTIVE_ID,
                provider: "anthropic",
                model: model.id,
                resynced: resync.resynced,
                reason: resync.reason,
              });
            },
          });
          deps.recordOutcome({
            accountId: CSWAP_ACTIVE_ID,
            provider: "anthropic",
            model: model.id,
            outcome: result.outcome,
            ...(result.outcome === "failed" && result.error
              ? {
                  error: KNOWN_MESSAGES.has(result.error)
                    ? result.error
                    : redactSecrets(result.error, source.sent()),
                }
              : {}),
            ...(result.retried ? { retriedAfterConsumeReread: true } : {}),
          });
          if (result.outcome === "failed" && pushed === 0) {
            // e.g. the Keychain read failed before any upstream stream existed.
            output.push(errorEvent(model, safeMessage(new Error(result.error ?? ""))));
          }
        } catch (err) {
          const message = safeMessage(err);
          deps.recordOutcome({
            accountId: CSWAP_ACTIVE_ID,
            provider: "anthropic",
            model: model.id,
            outcome: "failed",
            error: redactSecrets(message, sent()),
          });
          output.push(errorEvent(model, message));
        } finally {
          output.end();
        }
      })();
      return output;
  };
  pi.unregisterProvider("anthropic");
  pi.registerProvider({
    id: "anthropic",
    name: "Anthropic (QLB consume)",
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    auth: qlbManagedAuth(),
    getModels: () => deps.models ?? [],
    stream: streamSimple,
    streamSimple,
  });
}
