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
  provider: 'anthropic' | 'openai-codex' | 'xai' | 'kimi-coding';
  label: string;
  buckets: Record<string, BucketReading>;
  error?: string;
}

export interface Adapter {
  id: 'anthropic' | 'openai-codex' | 'xai' | 'kimi-coding';
  displayName: string;
  /** Read-only: fetch current usage for all accounts this adapter knows about. Must NEVER throw — catch internally and return an AccountSnapshot with `error` set instead. Must NEVER write/mutate any credential or config file (Phase 0 is read-only). */
  fetchSnapshots(): Promise<AccountSnapshot[]>;
}
