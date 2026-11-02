import { resolveCswapCheck } from '../cc-resync';
import type { CswapProcess } from '../cswap-processes';
import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';
import { isLifecycleState, type LifecyclePhaseResult } from './lifecycle-phase';

export default check('cswap:processes');

export interface CswapProcessesCheckOptions {
  /** Injected in tests so doctor never reads a real process table. */
  list?: () => CswapProcess[];
  env?: NodeJS.ProcessEnv;
}

/** H2: after cutover, any C-swap process is a blocking split-brain condition. */
export function cswapProcessesCheck(
  lifecycle: LifecyclePhaseResult,
  options: CswapProcessesCheckOptions = {},
): HealthCheck {
  if (!lifecycle.available) {
    return { name: 'cswap:processes', level: 'WARN', message: 'lifecycle phase unavailable; C-swap processes cannot be evaluated' };
  }
  if (!isLifecycleState(lifecycle.phase)) {
    return { name: 'cswap:processes', level: 'WARN', message: 'cannot evaluate: unknown lifecycle state' };
  }
  if (lifecycle.phase !== 'cutover') {
    return { name: 'cswap:processes', level: 'N/A', message: `not applicable in phase=${lifecycle.phase}` };
  }

  return guardCheck('cswap:processes', () => {
    // Use the exact S24 resolver as the auto loop and refresh paths. In test
    // mode it is hermetic unless the caller supplies this explicit fixture.
    const processes = resolveCswapCheck(options.list, options.env ?? process.env)();
    return processes.length === 0
      ? { name: 'cswap:processes', level: 'PASS', message: 'no C-swap processes are running' }
      : {
        name: 'cswap:processes',
        level: 'FAIL',
        message: `${processes.length} C-swap process${processes.length === 1 ? '' : 'es'} still running`,
        detail: processes.map(({ pid }) => ({ pid })),
      };
  });
}
