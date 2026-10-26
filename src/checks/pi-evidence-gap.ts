import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { DoctorCheck } from '../diagnostics';
import { check } from './_check';

export default check('pi:evidence-gap');

/** S54: evidence failures are durable value-free log lines, never retry writes to a busy DB. */
export function piEvidenceGapCheck(dbPath: string): DoctorCheck {
  const path = join(dirname(dbPath), 'auto.log');
  if (!existsSync(path)) return { name: 'pi:evidence-gap', level: 'PASS', message: 'no Pi gate evidence gaps recorded' };
  try {
    const gaps = readFileSync(path, 'utf8').split(/\r?\n/)
      .filter((line) => /^pi:evidence-gap provider=[a-z0-9-]+ at=\d+$/.test(line)).length;
    return gaps === 0
      ? { name: 'pi:evidence-gap', level: 'PASS', message: 'no Pi gate evidence gaps recorded' }
      : { name: 'pi:evidence-gap', level: 'WARN', message: `${gaps} Pi gate evidence gap${gaps === 1 ? '' : 's'} recorded; credentials were served`, detail: { gaps } };
  } catch {
    return { name: 'pi:evidence-gap', level: 'WARN', message: 'unable to read Pi gate evidence log' };
  }
}
