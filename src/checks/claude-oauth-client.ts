import { openStoreConnection } from '../store';
import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';
import { lifecyclePhase, type LifecyclePhaseResult } from './lifecycle-phase';

export default check('claude:oauth-client');

/**
 * C-swap v0.28.0 oauth.py:219-225 separates invalid_client from invalid_grant:
 * it is a systemic OAuth-client failure, never evidence that a slot is dead.
 */
export function claudeOauthClientCheck(dbPath: string, lifecycle?: LifecyclePhaseResult): HealthCheck {
  const unavailable = (): HealthCheck => ({
    name: 'claude:oauth-client',
    level: 'WARN',
    message: 'store not initialised / not yet v5; Claude OAuth client cannot be evaluated',
  });
  if (!(lifecycle ??= lifecyclePhase(dbPath)).available) return unavailable();

  return guardCheck('claude:oauth-client', () => {
    const db = openStoreConnection(dbPath, true);
    try {
      const rows = db.prepare(`
        SELECT account_id AS accountId FROM usage_polls
        WHERE provider = 'anthropic' AND last_status = 'invalid_client' ORDER BY account_id
      `).all() as Array<{ accountId: string }>;
      return rows.length === 0
        ? { name: 'claude:oauth-client', level: 'PASS', message: 'Claude OAuth client is healthy' }
        : {
          name: 'claude:oauth-client',
          level: 'WARN',
          message: 'Claude OAuth client was rejected; this is systemic, not a dead-slot verdict',
          detail: rows,
        };
    } finally {
      db.close();
    }
  }, (error) => error instanceof Error && /no such table: usage_polls\b/i.test(error.message) ? unavailable() : undefined);
}
