import { openStoreConnection } from '../store';
import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';
import { lifecyclePhase, type LifecyclePhaseResult } from './lifecycle-phase';

export default check('auto', 'auto');

/** S14: an unexpired suspension is a doctor failure and is never extended by doctor. */
export function autoBreakerCheck(dbPath: string, provider: string, now?: number): HealthCheck;
export function autoBreakerCheck(dbPath: string, provider: string, lifecycle: LifecyclePhaseResult, now?: number): HealthCheck;
export function autoBreakerCheck(
  dbPath: string,
  provider: string,
  lifecycleOrNow: LifecyclePhaseResult | number = Date.now(),
  suppliedNow?: number,
): HealthCheck {
  const lifecycle = typeof lifecycleOrNow === 'number' ? lifecyclePhase(dbPath) : lifecycleOrNow;
  const now = typeof lifecycleOrNow === 'number' ? lifecycleOrNow : suppliedNow ?? Date.now();
  const unavailable = (): HealthCheck => ({
    name: `auto:${provider}:breaker`,
    level: 'WARN',
    message: `store not initialised / not yet v5; automatic ${provider} breaker cannot be evaluated`,
  });
  if (!lifecycle.available) return unavailable();

  return guardCheck(`auto:${provider}:breaker`, () => {
    const db = openStoreConnection(dbPath, true);
    try {
      const row = db.prepare('SELECT value FROM config WHERE key = ?').get(`auto.${provider}.suspendedUntil`) as
        | { value: string }
        | undefined;
      const until = row == null ? NaN : Number(row.value);
      const open = Number.isFinite(until) && until > now;
      return open
        ? {
          name: `auto:${provider}:breaker`,
          level: 'FAIL',
          message: `automatic ${provider} switching is suspended until ${new Date(until).toISOString()}`,
          detail: { suspendedUntil: until },
        }
        : { name: `auto:${provider}:breaker`, level: 'PASS', message: `automatic ${provider} breaker is closed` };
    } finally {
      db.close();
    }
  }, (error) => error instanceof Error && /no such table: config\b/i.test(error.message) ? unavailable() : undefined);
}
