import { ClaudeSlots } from '../cc-slots';
import { check } from './_check';
import type { HealthCheck } from './claude-slots';
import { isLifecycleState } from './lifecycle-phase';

export default check('claude:unclaimed');

const APPLICABLE_PHASES = new Set(['cutover', 'retired']);
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Read-only visibility for retained Claude successor stashes. The index holds
 * metadata only; this check never opens a Keychain item or fallback body. An
 * unavailable or malformed index deliberately blocks S64 retirement.
 */
export async function claudeUnclaimedCheck(
  stashDir: string,
  phase: string,
  now = Date.now(),
): Promise<HealthCheck> {
  if (phase === 'unknown') {
    return { name: 'claude:unclaimed', level: 'WARN', message: 'lifecycle phase unavailable; unclaimed Claude stashes cannot be evaluated' };
  }
  if (!isLifecycleState(phase)) {
    return { name: 'claude:unclaimed', level: 'WARN', message: 'cannot evaluate: unknown lifecycle state' };
  }
  if (!APPLICABLE_PHASES.has(phase)) {
    return { name: 'claude:unclaimed', level: 'N/A', message: `not applicable in phase=${phase}` };
  }

  let entries: Awaited<ReturnType<typeof ClaudeSlots.listUnclaimedStashIndex>>;
  try {
    entries = await ClaudeSlots.listUnclaimedStashIndex(stashDir);
  } catch (error) {
    const message = error instanceof Error && error.message === 'unclaimed index entry is malformed'
      ? 'unclaimed stash index contains malformed metadata'
      : 'unclaimed stash index unavailable';
    return { name: 'claude:unclaimed', level: 'FAIL', message };
  }

  const stale = entries.filter((entry) => entry.createdAt < now - STALE_AFTER_MS);
  if (stale.length > 0) {
    const restore = stale.map((entry) =>
      `qlb claude restore-unclaimed ${entry.stashId} ${entry.accountId ?? '<slot>'}`).join('; ');
    return {
      name: 'claude:unclaimed', level: 'WARN',
      message: `${stale.length} unclaimed Claude stash(es) older than 30 days: ${restore}`,
    };
  }
  if (entries.length > 0) {
    return { name: 'claude:unclaimed', level: 'INFO', message: `${entries.length} unclaimed Claude stash(es) younger than 30 days` };
  }
  return { name: 'claude:unclaimed', level: 'PASS', message: 'no unclaimed Claude stashes' };
}
