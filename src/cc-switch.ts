/*
 * Claude switch Phase A (§4.1). This module deliberately performs no switch
 * transaction writes; K5-5 adds Phase B after the journal and store seams land.
 */

import {
  needsFreshenBeforeSwitch,
  parseCredentialBlob,
  type JsonObject,
  type OAuthAccount,
} from './anthropic-oauth';
import {
  prefetchLiveIdentity,
  type ClassifyClaudeSlot,
  type PrefetchedLiveIdentity,
} from './cc-classify';
import {
  readLiveClaudeCredentials,
  type ClaudeCredentialsOptions,
} from './cc-credentials';
import { claudePaths } from './cc-paths';
import { consumeClaudeSlot, type ConsumeGateDeps } from './cc-consume';
import { resolveCswapCheck } from './cc-resync';
import { ClaudeSlots, type ClaudeSlot } from './cc-slots';
import { isCredentialNotFound } from './credential-backends';
import type { CswapProcess } from './cswap-processes';
import type { Store } from './store';

export type ClaudeSwitchPreconditionReason =
  | 'active-login-unset'
  | 'target-missing'
  | 'target-dead'
  | 'target-archived'
  | 'breaker-open'
  | 'cswap-process-alive'
  | 'cswap-process-check-failed';

export type ClaudeSwitchPhaseAReason =
  | ClaudeSwitchPreconditionReason
  | 'claude:config-file'
  | 'live-credential-empty'
  | 'live-credential-unreadable'
  | 'target-unreadable'
  | `freshen-${string}`;

export interface ClaudeSwitchDeps {
  /** K5-5 widens this to the transaction and refusal primitives. */
  store: Pick<Store, 'getActiveLogin' | 'getConfig'>;
  slots: ClaudeSlots;
  live: ClaudeCredentialsOptions;
  /** Config parsing is injected so Phase A has no filesystem policy of its own. */
  readConfig: (path: string) => JsonObject;
  resolveProfile: (accessToken: string) => Promise<OAuthAccount | null>;
  consume: Pick<ConsumeGateDeps, 'postRefresh' | 'withConsumeLock' | 'withSwitchLock' | 'stashTimestamp'>;
  cswapProcesses?: () => CswapProcess[];
  env: NodeJS.ProcessEnv;
  home?: string;
  now: () => number;
  by: 'qlb-cli' | 'qlb-auto';
  warn?: (message: string) => void;
}

export interface SwitchClaudeInput {
  to: string;
  trigger: string;
  decision?: { leftHeadroom: number | null; leftRecoveryAt: number | null; leftTrigger: string | null };
  bindingJson?: string;
  republish?: boolean;
  injected?: boolean;
  /** K7's memoized collect-pass oracle result; Phase B consumes it unchanged. */
  probeVerdict?: boolean;
}

export type ClaudeSwitchPreconditionsResult =
  | { kind: 'go' }
  | { kind: 'refused'; reason: ClaudeSwitchPreconditionReason };

export interface ClaudeSwitchPhaseA {
  active: string;
  outgoingSlot: ClaudeSlot;
  targetSlot: ClaudeSlot;
  liveCredential: string;
  config: JsonObject;
  prefetch: PrefetchedLiveIdentity;
  targetCredential: string;
  slots: ClassifyClaudeSlot[];
}

export type PrepareClaudeSwitchResult =
  | ClaudeSwitchPhaseA
  | { kind: 'refused'; reason: ClaudeSwitchPhaseAReason }
  | { kind: 'failed'; reason: ClaudeSwitchPhaseAReason };

function refused(reason: ClaudeSwitchPreconditionReason): Extract<ClaudeSwitchPreconditionsResult, { kind: 'refused' }> {
  return { kind: 'refused', reason };
}

function activeAccount(deps: ClaudeSwitchDeps): string | null {
  const accountId = deps.store.getActiveLogin('anthropic')?.accountId;
  return accountId && deps.slots.getSlot(accountId) ? accountId : null;
}

/**
 * Read-only admission checks. This function intentionally records no refusal:
 * K5-5 is the sole owner of the switch_log effect.
 */
export function checkClaudeSwitchPreconditions(
  deps: ClaudeSwitchDeps,
  input: SwitchClaudeInput,
): ClaudeSwitchPreconditionsResult {
  if (activeAccount(deps) === null) return refused('active-login-unset');

  const target = deps.slots.getSlot(input.to);
  if (target === null) return refused('target-missing');
  if (target.dead) return refused('target-dead');
  if (target.archivedAt != null) return refused('target-archived');

  if (input.trigger !== 'manual') {
    const suspendedUntil = deps.store.getConfig('auto.anthropic.suspendedUntil');
    if (suspendedUntil !== null) {
      const timestamp = Number(suspendedUntil);
      if (!Number.isFinite(timestamp) || timestamp > deps.now()) return refused('breaker-open');
    }
  }

  try {
    if (resolveCswapCheck(deps.cswapProcesses, deps.env)().length > 0) return refused('cswap-process-alive');
  } catch {
    return refused('cswap-process-check-failed');
  }
  return { kind: 'go' };
}

function warn(deps: ClaudeSwitchDeps, message: string): void {
  try { deps.warn?.(message); } catch { /* diagnostics do not change switch safety */ }
}

async function readSlotOrNull(deps: ClaudeSwitchDeps, accountId: string): Promise<string | null> {
  try {
    return (await deps.slots.readSlot(accountId, { fresh: true })).credential;
  } catch {
    return null;
  }
}

/**
 * Build the lock-free, network-permitted Phase-A snapshot. It only reads slot
 * and live state; freshening is delegated to the consume gate, whose own
 * short switch-lock holds are released before this function returns.
 */
export async function prepareClaudeSwitch(
  deps: ClaudeSwitchDeps,
  input: SwitchClaudeInput,
): Promise<PrepareClaudeSwitchResult> {
  const checked = checkClaudeSwitchPreconditions(deps, input);
  if (checked.kind === 'refused') return checked;

  const active = activeAccount(deps);
  // `checked` makes this unreachable, but retain the narrow fail-closed guard
  // against a test double changing between its two synchronous reads.
  if (active === null) return { kind: 'refused', reason: 'active-login-unset' };
  const outgoingSlot = deps.slots.getSlot(active);
  const targetSlot = deps.slots.getSlot(input.to);
  if (outgoingSlot === null) return { kind: 'refused', reason: 'active-login-unset' };
  if (targetSlot === null) return { kind: 'refused', reason: 'target-missing' };

  const paths = deps.live.paths ?? claudePaths({ home: deps.home, env: deps.env });
  const live = deps.live.paths ? deps.live : { ...deps.live, paths };
  let config: JsonObject;
  try {
    config = deps.readConfig(paths.globalConfigPath);
  } catch {
    return { kind: 'failed', reason: 'claude:config-file' };
  }

  let liveCredential: string;
  try {
    liveCredential = await readLiveClaudeCredentials(live);
  } catch (error) {
    return isCredentialNotFound(error)
      ? { kind: 'refused', reason: 'live-credential-empty' }
      : { kind: 'refused', reason: 'live-credential-unreadable' };
  }
  if (!liveCredential) return { kind: 'refused', reason: 'live-credential-empty' };

  let targetCredential: string;
  try {
    targetCredential = (await deps.slots.readSlot(input.to, { fresh: true })).credential;
  } catch {
    return { kind: 'failed', reason: 'target-unreadable' };
  }

  const outgoingCredential = await readSlotOrNull(deps, active);
  const classifiedSlots: ClassifyClaudeSlot[] = [{
    accountId: outgoingSlot.accountId,
    email: outgoingSlot.email ?? null,
    orgUuid: outgoingSlot.orgUuid ?? null,
    credential: outgoingCredential,
  }];
  for (const slot of deps.slots.listSlots()) {
    if (slot.accountId === active) continue;
    let credential: string;
    if (slot.accountId === input.to) {
      credential = targetCredential;
    } else {
      try {
        credential = (await deps.slots.readSlot(slot.accountId, { fresh: true })).credential;
      } catch {
        warn(deps, `Claude slot ${slot.accountId} could not be read during switch preparation`);
        continue;
      }
    }
    classifiedSlots.push({
      accountId: slot.accountId,
      email: slot.email ?? null,
      orgUuid: slot.orgUuid ?? null,
      credential,
    });
  }

  const outgoing: ClassifyClaudeSlot = classifiedSlots[0];
  const prefetch = await prefetchLiveIdentity({
    outgoing,
    readLive: async () => {
      try { return await readLiveClaudeCredentials(live); } catch { return null; }
    },
    resolveProfile: deps.resolveProfile,
  });

  if (!input.republish && needsFreshenBeforeSwitch(parseCredentialBlob(targetCredential)?.oauth?.expiresAt, deps.now())) {
    let consumed;
    try {
      consumed = await consumeClaudeSlot({
        slots: deps.slots,
        postRefresh: deps.consume.postRefresh,
        now: deps.now,
        withConsumeLock: deps.consume.withConsumeLock,
        withSwitchLock: deps.consume.withSwitchLock,
        stashTimestamp: deps.consume.stashTimestamp,
        warn: deps.warn,
      }, { accountId: input.to, snapshot: targetCredential });
    } catch {
      return { kind: 'refused', reason: 'freshen-transient' };
    }
    if (consumed.kind !== 'refreshed' && consumed.kind !== 'current') {
      return { kind: 'refused', reason: `freshen-${consumed.kind}` };
    }
    targetCredential = consumed.credential ?? targetCredential;
    const target = classifiedSlots.find((slot) => slot.accountId === input.to);
    if (target) target.credential = targetCredential;
  }

  return {
    active,
    outgoingSlot,
    targetSlot,
    liveCredential,
    config,
    prefetch,
    targetCredential,
    slots: classifiedSlots,
  };
}
