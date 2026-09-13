import { providerForModel, snapshotsFromStore } from './resolve';
import type { Store } from './store';
import type { AccountSnapshot, Adapter, BucketReading, Confidence } from './types';

export type ObservationSource = 'resolve' | 'refresh' | 'status';
export type ObservationOutcome = 'ok' | 'failed';

export interface ObservationSummary {
  provider: string;
  at: string | null;
  source: ObservationSource | null;
  generation: number | null;
  status: 'ok' | 'unavailable' | 'store-fallback' | 'failed';
  error?: string;
  detail?: string;
}

export interface CollectCandidatesOpts {
  adapters: readonly Adapter[];
  store: Store;
  models: string[];
  probe: boolean;
  recordAs?: ObservationSource;
}

export interface CollectCandidatesResult {
  snapshots: AccountSnapshot[];
  observations: ObservationSummary[];
}

interface StoredObservation {
  at: string;
  source: ObservationSource;
  generation: number;
  persisted: boolean;
  outcome: ObservationOutcome;
  error?: string;
  accounts: AccountSnapshot[];
}

const OBSERVATION_SOURCES: readonly ObservationSource[] = ['resolve', 'refresh', 'status'];
const BUCKET_SOURCES = ['poll', 'headers', 'error'] as const;
const CONFIDENCES: readonly Confidence[] = ['authoritative', 'advisory', 'stale', 'unknown'];

let observationWarnOnce = false;

export function observationConfigKey(provider: string): string {
  return `observed:${provider}`;
}

export async function safeFetch(adapter: Adapter): Promise<AccountSnapshot[]> {
  try {
    return await adapter.fetchSnapshots();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      {
        accountId: adapter.id,
        provider: adapter.id,
        label: adapter.displayName,
        buckets: {},
        error: message,
      },
    ];
  }
}

function normalizeAccount(snapshot: AccountSnapshot): AccountSnapshot {
  const out: AccountSnapshot = {
    accountId: snapshot.accountId,
    provider: snapshot.provider,
    label: snapshot.label,
    buckets: snapshot.buckets ?? {},
  };
  if (typeof snapshot.error === 'string' && snapshot.error.length > 0) {
    out.error = snapshot.error;
  }
  if (snapshot.failed === true) {
    out.failed = true;
    if (!out.error) out.error = 'failed';
  }
  return out;
}

function isObservationSource(value: unknown): value is ObservationSource {
  return typeof value === 'string' && (OBSERVATION_SOURCES as readonly string[]).includes(value);
}

function isIso8601(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseBucketReading(value: unknown): BucketReading | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.usedPct !== null && !isFiniteNumber(r.usedPct)) return null;
  if (!(BUCKET_SOURCES as readonly string[]).includes(r.source as string)) return null;
  if (!(CONFIDENCES as readonly string[]).includes(r.confidence as string)) return null;
  if (!isFiniteNumber(r.fetchedAt)) return null;
  if (r.resetAt !== undefined && r.resetAt !== null && !isFiniteNumber(r.resetAt)) return null;
  if (r.used !== undefined && !isFiniteNumber(r.used)) return null;
  if (r.limit !== undefined && !isFiniteNumber(r.limit)) return null;
  if (r.remaining !== undefined && !isFiniteNumber(r.remaining)) return null;
  if (r.windowMin !== undefined && !isFiniteNumber(r.windowMin)) return null;
  if (r.detail !== undefined && typeof r.detail !== 'string') return null;
  const reading: BucketReading = {
    usedPct: r.usedPct as number | null,
    source: r.source as BucketReading['source'],
    confidence: r.confidence as Confidence,
    fetchedAt: r.fetchedAt,
  };
  if (r.resetAt === null) {
    // explicit null is allowed and omitted
  } else if (isFiniteNumber(r.resetAt)) {
    reading.resetAt = r.resetAt;
  }
  if (isFiniteNumber(r.used)) reading.used = r.used;
  if (isFiniteNumber(r.limit)) reading.limit = r.limit;
  if (isFiniteNumber(r.remaining)) reading.remaining = r.remaining;
  if (isFiniteNumber(r.windowMin)) reading.windowMin = r.windowMin;
  if (typeof r.detail === 'string') reading.detail = r.detail;
  return reading;
}

function parseAccount(value: unknown, expectedProvider: string): AccountSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  if (typeof a.accountId !== 'string' || a.accountId.length === 0) return null;
  if (typeof a.provider !== 'string' || a.provider !== expectedProvider) return null;
  if (typeof a.label !== 'string') return null;
  if (!a.buckets || typeof a.buckets !== 'object' || Array.isArray(a.buckets)) return null;
  const buckets: Record<string, BucketReading> = {};
  for (const [key, raw] of Object.entries(a.buckets as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0) return null;
    const reading = parseBucketReading(raw);
    if (!reading) return null;
    buckets[key] = reading;
  }
  const snap: AccountSnapshot = {
    accountId: a.accountId,
    provider: a.provider,
    label: a.label,
    buckets,
  };
  if (a.error !== undefined) {
    if (typeof a.error !== 'string' || a.error.length === 0) return null;
    snap.error = a.error;
  }
  if (a.failed !== undefined) {
    if (typeof a.failed !== 'boolean') return null;
    if (a.failed) {
      snap.failed = true;
      if (!snap.error) snap.error = 'failed';
    }
  }
  return snap;
}

function parseObservation(raw: string | null, expectedProvider: string): StoredObservation | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const v = parsed as Record<string, unknown>;
    if (typeof v.at !== 'string' || !isIso8601(v.at)) return null;
    if (!isObservationSource(v.source)) return null;
    if (!Number.isSafeInteger(v.generation) || (v.generation as number) < 1) return null;
    if (typeof v.persisted !== 'boolean') return null;
    let outcome: ObservationOutcome;
    if (v.outcome === 'failed') outcome = 'failed';
    else if (v.outcome === 'ok' || v.outcome === undefined) outcome = 'ok';
    else return null;
    if (!Array.isArray(v.accounts)) return null;

    if (outcome === 'failed') {
      if (typeof v.error !== 'string' || v.error.length === 0) return null;
      return {
        at: v.at,
        source: v.source,
        generation: v.generation as number,
        persisted: v.persisted,
        outcome: 'failed',
        error: v.error,
        accounts: [],
      };
    }

    const accounts: AccountSnapshot[] = [];
    for (const item of v.accounts) {
      const snap = parseAccount(item, expectedProvider);
      if (!snap) return null;
      accounts.push(snap);
    }
    return {
      at: v.at,
      source: v.source,
      generation: v.generation as number,
      persisted: v.persisted,
      outcome: 'ok',
      accounts,
    };
  } catch {
    return null;
  }
}

export function recordObservation(
  store: Store,
  input: { provider: string; persistsSnapshots?: boolean },
  snapshots: AccountSnapshot[],
  source: ObservationSource,
  opts?: { outcome?: ObservationOutcome; error?: string },
): void {
  try {
    const key = observationConfigKey(input.provider);
    const prev = parseObservation(store.getConfig(key), input.provider);
    const outcome: ObservationOutcome = opts?.outcome ?? 'ok';
    const payload: StoredObservation = {
      at: new Date().toISOString(),
      source,
      generation: (prev?.generation ?? 0) + 1,
      persisted: input.persistsSnapshots !== false,
      outcome,
      accounts: outcome === 'failed' ? [] : snapshots.map(normalizeAccount),
    };
    if (outcome === 'failed') {
      payload.error = opts?.error && opts.error.length > 0 ? opts.error : 'probe failed';
    }
    store.setConfig(key, JSON.stringify(payload));
  } catch (err) {
    if (!observationWarnOnce) {
      observationWarnOnce = true;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`qlb: failed to record observation: ${reason}`);
    }
  }
}

function providersForModels(models: string[]): Set<string> {
  const providers = new Set<string>();
  for (const model of models) {
    const provider = providerForModel(model);
    if (provider) providers.add(provider);
  }
  return providers;
}

function unavailableSnapshots(stored: StoredObservation, provider: string): AccountSnapshot[] {
  if (stored.accounts.length === 0) {
    return [
      {
        accountId: provider,
        provider,
        label: provider,
        buckets: {},
        error: 'observation: unavailable',
      },
    ];
  }
  return stored.accounts.map((snap) => ({
    ...normalizeAccount(snap),
    error: 'observation: unavailable',
  }));
}

export async function collectCandidates(
  opts: CollectCandidatesOpts,
): Promise<CollectCandidatesResult> {
  const providers = providersForModels(opts.models);
  const snapshots: AccountSnapshot[] = [];
  const observations: ObservationSummary[] = [];

  for (const adapter of opts.adapters) {
    if (!providers.has(adapter.id)) continue;

    if (opts.probe) {
      const snaps = await safeFetch(adapter);
      if (opts.recordAs) {
        recordObservation(
          opts.store,
          { provider: adapter.id, persistsSnapshots: adapter.persistsSnapshots },
          snaps,
          opts.recordAs,
        );
      }
      snapshots.push(...snaps);
      const recorded = parseObservation(
        opts.store.getConfig(observationConfigKey(adapter.id)),
        adapter.id,
      );
      observations.push({
        provider: adapter.id,
        at: recorded?.at ?? new Date().toISOString(),
        source: opts.recordAs ?? 'resolve',
        generation: recorded?.generation ?? null,
        status: adapter.persistsSnapshots === false ? 'unavailable' : 'ok',
      });
      continue;
    }

    const raw = opts.store.getConfig(observationConfigKey(adapter.id));
    if (raw == null) {
      const fromStore = snapshotsFromStore(opts.store, adapter.id);
      snapshots.push(...fromStore);
      observations.push({
        provider: adapter.id,
        at: null,
        source: null,
        generation: null,
        status: 'store-fallback',
      });
      continue;
    }

    const stored = parseObservation(raw, adapter.id);
    if (!stored) {
      observations.push({
        provider: adapter.id,
        at: null,
        source: null,
        generation: null,
        status: 'unavailable',
        detail: '? via ? gen ? (unavailable)',
      });
      continue;
    }

    if (stored.outcome === 'failed') {
      observations.push({
        provider: adapter.id,
        at: stored.at,
        source: stored.source,
        generation: stored.generation,
        status: 'failed',
        error: stored.error,
        detail: `last observation FAILED at ${stored.at} (gen ${stored.generation}): ${stored.error}`,
      });
      continue;
    }

    if (stored.persisted === false || adapter.persistsSnapshots === false) {
      snapshots.push(...unavailableSnapshots(stored, adapter.id));
      observations.push({
        provider: adapter.id,
        at: stored.at,
        source: stored.source,
        generation: stored.generation,
        status: 'unavailable',
        detail: `${stored.at} via ${stored.source} gen ${stored.generation} (unavailable)`,
      });
      continue;
    }

    snapshots.push(...stored.accounts.map(normalizeAccount));
    observations.push({
      provider: adapter.id,
      at: stored.at,
      source: stored.source,
      generation: stored.generation,
      status: 'ok',
    });
  }

  return { snapshots, observations };
}
