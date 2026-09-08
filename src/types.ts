export type Confidence = 'authoritative' | 'advisory' | 'stale' | 'unknown';

export interface BucketReading {
  usedPct: number | null;
  used?: number;
  limit?: number;
  remaining?: number;
  resetAt?: number;            // epoch ms, if known
  windowMin?: number;          // window size in minutes, if known
  source: 'poll' | 'headers' | 'error';
  confidence: Confidence;
  fetchedAt: number;           // epoch ms when this reading was obtained
  detail?: string;             // free-text note, e.g. "advisory: token-bucket, not proven to match in-app meter"
}

export interface AccountSnapshot {
  accountId: string;
  provider: 'anthropic' | 'openai-codex' | 'xai' | 'kimi-coding' | 'openrouter';
  label: string;
  buckets: Record<string, BucketReading>;
  error?: string;
}

export interface Adapter {
  id: 'anthropic' | 'openai-codex' | 'xai' | 'kimi-coding' | 'openrouter';
  displayName: string;
  /** Read-only: fetch current usage for all accounts this adapter knows about. Must NEVER throw — catch internally and return an AccountSnapshot with `error` set instead. Must NEVER write/mutate any credential or config file (Phase 0 is read-only). */
  fetchSnapshots(): Promise<AccountSnapshot[]>;
}

/**
 * OAuth grant stored in the Keychain payload (§4.8.1 / §4.8.2).
 * `expires` is epoch milliseconds. `generation` is the fencing token and
 * travels with the data so a Keychain write can be verified against it.
 */
export interface Grant {
  access: string;
  refresh: string;
  expires: number;
  generation: number;
  writtenBy?: string;
  extra?: Record<string, unknown>;
}

export class QlbError extends Error {
  readonly kind: string;
  readonly store?: string;
  readonly detail?: string;

  constructor(init: {
    kind: string;
    store?: string;
    detail?: string;
    message?: string;
  }) {
    super(
      init.message ??
        [init.kind, init.store, init.detail].filter(Boolean).join(': '),
    );
    this.name = 'QlbError';
    this.kind = init.kind;
    if (init.store !== undefined) this.store = init.store;
    if (init.detail !== undefined) this.detail = init.detail;
  }
}
