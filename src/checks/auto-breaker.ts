import { DatabaseSync } from 'node:sqlite';

import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';

export default check('auto', 'auto');

/** S14: an unexpired suspension is a doctor failure and is never extended by doctor. */
export function autoBreakerCheck(dbPath: string, provider: string, now: number = Date.now()): HealthCheck {
  return guardCheck(`auto:${provider}:breaker`, () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
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
  });
}
