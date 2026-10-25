/**
 * K13 seam for the destructive C-swap LaunchAgent operations. K13b replaces
 * this fail-closed stub with the cooperative process/lock drain; callers pass
 * a fake in tests and production cannot accidentally execute launchctl here.
 */
export interface CswapAgentResult {
  ok: boolean;
  code?: string;
}

export interface CswapAgent {
  bootout(): CswapAgentResult | Promise<CswapAgentResult>;
  disable(): CswapAgentResult | Promise<CswapAgentResult>;
  movePlist(): CswapAgentResult | Promise<CswapAgentResult>;
  restorePlist(): CswapAgentResult | Promise<CswapAgentResult>;
}

const unavailable = (): CswapAgentResult => ({ ok: false, code: 'cswap-agent-not-yet-available' });

export const unavailableCswapAgent: CswapAgent = {
  bootout: unavailable,
  disable: unavailable,
  movePlist: unavailable,
  restorePlist: unavailable,
};
