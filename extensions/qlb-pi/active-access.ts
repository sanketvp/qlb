// Shared fail-closed boundary for qlb-pi provider sources (§4.7.2).
// A provider source obtains its ephemeral request access from QLB; it never
// falls back to Pi's stored credential when that read is unavailable.

export const PI_PROVIDERS = [
  "anthropic",
  "openai-codex",
  "xai",
  "kimi-coding",
  "openrouter",
] as const;

export type PiProvider = (typeof PI_PROVIDERS)[number];

export function isPiProvider(value: string): value is PiProvider {
  return (PI_PROVIDERS as readonly string[]).includes(value);
}

/** An access value returned by `qlb gate <provider> --json`. Never log `token`. */
export interface ActiveAccess {
  token: string;
  accountId: string;
  chatgptAccountId?: string;
  expiresAt?: number;
  source: string;
}

/** Provider-specific readers are installed by P2–P5. */
export interface ActiveAccessSource {
  provider: PiProvider;
  read(): Promise<ActiveAccess>;
}

export interface ActiveAccessRegistry {
  register(source: ActiveAccessSource): void;
  get(provider: PiProvider): ActiveAccessSource | undefined;
  read(provider: PiProvider): Promise<ActiveAccess>;
}

/**
 * A registry is deliberately instance-scoped: each extension load gets exactly
 * the sources it registers, preventing a stale provider from leaking across a
 * test or a reload.
 */
export function createActiveAccessRegistry(
  initial: readonly ActiveAccessSource[] = [],
): ActiveAccessRegistry {
  const sources = new Map<PiProvider, ActiveAccessSource>();
  const register = (source: ActiveAccessSource): void => {
    if (sources.has(source.provider)) {
      throw new Error(`active access source already registered for ${source.provider}`);
    }
    sources.set(source.provider, source);
  };
  for (const source of initial) register(source);
  return {
    register,
    get: (provider) => sources.get(provider),
    async read(provider) {
      const source = sources.get(provider);
      if (!source) throw new Error(`no active access source for ${provider}`);
      return source.read();
    },
  };
}

export interface UnavailableModel {
  id: string;
  api?: unknown;
  provider?: unknown;
}

export interface QlbUnavailableEvent {
  type: "error";
  reason: "error";
  error: {
    role: "assistant";
    content: [];
    api: unknown;
    provider: PiProvider;
    model: string;
    usage: {
      input: 0;
      output: 0;
      cacheRead: 0;
      cacheWrite: 0;
      totalTokens: 0;
      cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0; total: 0 };
    };
    stopReason: "error";
    errorMessage: string;
    timestamp: number;
  };
}

/**
 * Cause codes are data, never diagnostics. Keep this explicit allowlist small:
 * adding a new gate cause requires deciding that its value is safe to display.
 */
const FIXED_CAUSE_CODES = new Set([
  "missing-binary",
  "store-open-failed",
  "owner-file-malformed",
  "identity-mismatch",
  "auth-json-unstable",
  "refresh-failed",
  "undo-in-progress",
  "codex-token-expired-renewer-idle",
  "provider-not-applicable",
]);
const REFUSED_LIFECYCLE_PHASES = new Set(["pre-cutover", "undoing", "rolled-back", "aborted"]);

function safeCause(cause: string): string {
  if (FIXED_CAUSE_CODES.has(cause)) return cause;
  const phase = cause.match(/^phase=([a-z-]{1,40})$/)?.[1];
  return phase && REFUSED_LIFECYCLE_PHASES.has(phase) ? cause : "unknown";
}

/** A single error event used when a QLB-managed provider cannot be served. */
export function qlbUnavailable(
  provider: PiProvider,
  cause: string,
  model: UnavailableModel = { id: provider },
): QlbUnavailableEvent {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: model.api,
      provider,
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
      errorMessage: `QLB unavailable for ${provider} — run qlb doctor (${safeCause(cause)})`,
      timestamp: Date.now(),
    },
  };
}
