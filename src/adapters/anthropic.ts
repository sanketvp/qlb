import { loadCswapUsageSnapshots } from '../cswap-usage';
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
