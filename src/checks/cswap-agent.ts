import { execFileSync } from 'node:child_process';

import { inspectCswapAgent, type CswapAgentStatus } from '../cswap-agent';
import { check } from './_check';
import type { HealthCheck } from './claude-slots';
import { isLifecycleState, type LifecyclePhaseResult } from './lifecycle-phase';

export default check('cswap:agent');

export interface CswapAgentCheckOptions {
  /** Tests inject this seam; production inspects `launchctl print` only. */
  status?: () => CswapAgentStatus;
  testMode?: boolean;
}

function productionStatus(): CswapAgentStatus {
  return inspectCswapAgent({
    exec: (file, args) => String(execFileSync(file, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 })),
    uid: () => process.getuid?.() ?? 0,
  });
}

/** H2: after cutover the former C-swap LaunchAgent must no longer be loaded. */
export function cswapAgentCheck(
  lifecycle: LifecyclePhaseResult,
  options: CswapAgentCheckOptions = {},
): HealthCheck {
  if (!lifecycle.available) {
    return { name: 'cswap:agent', level: 'WARN', message: 'lifecycle phase unavailable; C-swap agent cannot be evaluated' };
  }
  if (!isLifecycleState(lifecycle.phase)) {
    return { name: 'cswap:agent', level: 'WARN', message: 'cannot evaluate: unknown lifecycle state' };
  }
  if (lifecycle.phase !== 'cutover' && lifecycle.phase !== 'retired') {
    return { name: 'cswap:agent', level: 'N/A', message: `not applicable in phase=${lifecycle.phase}` };
  }

  const status = options.status?.() ?? (options.testMode ?? process.env.QLB_TEST_MODE === '1' ? 'unknown' : productionStatus());
  switch (status) {
    case 'loaded':
      return { name: 'cswap:agent', level: 'FAIL', message: 'C-swap LaunchAgent is still loaded' };
    case 'not-loaded':
      return { name: 'cswap:agent', level: 'PASS', message: 'C-swap LaunchAgent is not loaded' };
    case 'unknown':
      return { name: 'cswap:agent', level: 'WARN', message: 'C-swap LaunchAgent state could not be determined' };
  }
}
