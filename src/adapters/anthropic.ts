import { config } from '../config';
import { loadCswapUsageSnapshots } from '../cswap-usage';
import { qlbOwnsAnthropicUsage, readAnthropicStoreSnapshots } from '../anthropic-usage-view';
import { lifecyclePhase } from '../lifecycle-read';
import type { AccountSnapshot, Adapter } from '../types';

function shortReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const trimmed = message.replace(/\s+/g, ' ').trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed || 'request failed';
}

function errorSnap(reason: string): AccountSnapshot[] {
  return [{
    accountId: 'anthropic',
    provider: 'anthropic',
    label: 'Claude (Anthropic)',
    buckets: {},
    error: reason,
  }];
}

export const anthropicAdapter: Adapter = {
  id: 'anthropic',
  displayName: 'Claude (Anthropic)',
  async fetchSnapshots(): Promise<AccountSnapshot[]> {
    try {
      // Match status's read-only lifecycle gate: after the Claude hand-back,
      // retained QLB rows must not override C-swap's cache.
      const lifecycle = lifecyclePhase(config.dbPath);
      if (lifecycle.available && qlbOwnsAnthropicUsage(lifecycle.phase)) {
        const stored = readAnthropicStoreSnapshots(config.dbPath, Math.floor(Date.now() / 1000));
        // QLB owns this phase, so an unreadable store is a status error rather
        // than permission to serve stale C-swap data.
        return stored ? stored.snapshots : errorSnap('QLB usage store unavailable');
      }
      return loadCswapUsageSnapshots();
    } catch (err) {
      return errorSnap(shortReason(err));
    }
  },
};
