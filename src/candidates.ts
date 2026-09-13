import { providerForModel, snapshotsFromStore } from './resolve';
import type { Store } from './store';
import type { AccountSnapshot, Adapter } from './types';

export type ObservationSource = 'resolve' | 'refresh' | 'status';

export interface ObservationSummary {
  provider: string;
  at: string | null;
  source: ObservationSource | null;
  generation: number | null;
  status: 'ok' | 'unavailable' | 'store-fallback';
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
  accounts: AccountSnapshot[];
}

const OBSERVATION_SOURCES: readonly ObservationSource[] = ['resolve', 'refresh', 'status'];

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
  return out;
}

function isObservationSource(value: unknown): value is ObservationSource {
  return typeof value === 'string' && (OBSERVATION_SOURCES as readonly string[]).includes(value);
}

function parseObservation(raw: string | null): StoredObservation | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const v = parsed as Record<string, unknown>;
    if (typeof v.at !== 'string' || v.at.length === 0) return null;
    if (!isObservationSource(v.source)) return null;
    if (typeof v.generation !== 'number' || !Number.isFinite(v.generation)) return null;
    if (typeof v.persisted !== 'boolean') return null;
    if (!Array.isArray(v.accounts)) return null;
    const accounts: AccountSnapshot[] = [];
    for (const item of v.accounts) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const a = item as Record<string, unknown>;
      if (typeof a.accountId !== 'string' || a.accountId.length === 0) return null;
      if (typeof a.provider !== 'string' || a.provider.length === 0) return null;
      if (typeof a.label !== 'string') return null;
      if (!a.buckets || typeof a.buckets !== 'object' || Array.isArray(a.buckets)) return null;
      const snap: AccountSnapshot = {
        accountId: a.accountId,
        provider: a.provider,
        label: a.label,
        buckets: a.buckets as AccountSnapshot['buckets'],
      };
      if (typeof a.error === 'string' && a.error.length > 0) snap.error = a.error;
      accounts.push(snap);
    }
    return {
      at: v.at,
      source: v.source,
      generation: v.generation,
      persisted: v.persisted,
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
): void {
  try {
    const key = observationConfigKey(input.provider);
    const prev = parseObservation(store.getConfig(key));
    const payload: StoredObservation = {
      at: new Date().toISOString(),
      source,
      generation: (prev?.generation ?? 0) + 1,
      persisted: input.persistsSnapshots !== false,
      accounts: snapshots.map(normalizeAccount),
    };
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
      const recorded = parseObservation(opts.store.getConfig(observationConfigKey(adapter.id)));
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

    const stored = parseObservation(raw);
    if (!stored || stored.persisted === false || adapter.persistsSnapshots === false) {
      if (stored && (stored.persisted === false || adapter.persistsSnapshots === false)) {
        snapshots.push(...unavailableSnapshots(stored, adapter.id));
      }
      observations.push({
        provider: adapter.id,
        at: stored?.at ?? null,
        source: stored?.source ?? null,
        generation: stored?.generation ?? null,
        status: 'unavailable',
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
