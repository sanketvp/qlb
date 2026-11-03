import { SqliteClaudeSlotRepository } from '../cc-slots';
import { config } from '../config';
import { loadCswapUsageSnapshots } from '../cswap-usage';
import { anthropicStoreSnapshots } from '../anthropic-usage-view';
import { openStore } from '../store';
import type { AccountSnapshot, Adapter } from '../types';

function shortReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const trimmed = message.replace(/\s+/g, ' ').trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed || 'request failed';
}

export const anthropicAdapter: Adapter = {
  id: 'anthropic',
  displayName: 'Claude (Anthropic)',
  async fetchSnapshots(): Promise<AccountSnapshot[]> {
    try {
      const store = openStore(config.dbPath);
      const repository = SqliteClaudeSlotRepository.open(config.dbPath);
      try {
        const stored = anthropicStoreSnapshots(repository.listSlots(), store, Math.floor(Date.now() / 1000));
        // Legacy C-swap data is only a migration fallback. A persisted poll row
        // means QLB owns the current status, including unavailable accounts.
        if (stored.hasPolls) return stored.snapshots;
      } finally {
        repository.close();
        store.close();
      }
      return loadCswapUsageSnapshots();
    } catch (err) {
      return [
        {
          accountId: 'anthropic',
          provider: 'anthropic',
          label: 'Claude (Anthropic)',
          buckets: {},
          error: shortReason(err),
        },
      ];
    }
  },
};
