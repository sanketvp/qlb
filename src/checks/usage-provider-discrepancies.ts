import { check } from './_check';
import type { HealthCheck } from './claude-slots';

export default check('usage:provider-discrepancies');

/** Read-only doctor projection of store-owned in-window discrepancy counts. */
export function usageProviderDiscrepanciesCheck(counts: { discrepancies: number; anomalies: number } | null | undefined): HealthCheck {
  if (counts === undefined) {
    return { name: 'usage:provider-discrepancies', level: 'N/A', message: 'database does not exist yet' };
  }
  if (counts === null) {
    return { name: 'usage:provider-discrepancies', level: 'WARN', message: 'could not read discrepancy records' };
  }
  if (counts.discrepancies > 0 || counts.anomalies > 0) {
    return {
      name: 'usage:provider-discrepancies',
      level: 'WARN',
      message: `${counts.discrepancies} provider-wins ${counts.discrepancies === 1 ? 'discrepancy' : 'discrepancies'}; ${counts.anomalies} provider ${counts.anomalies === 1 ? 'anomaly' : 'anomalies'} (provider values remain canonical)`,
    };
  }
  return { name: 'usage:provider-discrepancies', level: 'PASS', message: 'no provider usage discrepancies or anomalies recorded' };
}
