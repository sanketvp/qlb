/*
 * Ported from claude-swap 0.28.0.
 * Upstream file(s): src/claude_swap/switcher.py:2199-2614,2641.
 * License: MIT.
 * Modified for QLB. See NOTICE.
 */

// The inactive-Claude refresh consume gate (§4.2.2, N8). Network, locks,
// clock, warning sink, and credential storage are injected at the boundary.

import {
  buildRefreshRequest,
  classifyRefreshResponse,
  credentialFingerprint,
  extractAccessToken,
  isOAuthTokenExpired,
  parseCredentialBlob,
  serializeCredentialBlob,
  type HttpRequestDescription,
} from './anthropic-oauth';
import { withClaudeConsumeLock, withClaudeSwitchLock } from './cc-locks';
import { ClaudeSlots, type ReadClaudeSlot } from './cc-slots';

export interface RefreshHttpResponse {
  status: number;
  body: string;
}

export type ConsumeGateKind =
  | 'refreshed'
  | 'current'
  | 'busy'
  | 'transient'
  | 'stash-unreadable'
  | 'slot-removed'
  | 'dead'
  | 'systemic'
  | 'consume-gate-unpersisted';

/** No credential bytes are included in diagnostics; the value is internal to callers. */
export interface ConsumeGateResult {
  kind: ConsumeGateKind;
  credential?: string;
  consumedFp?: string;
  stashed?: boolean;
}

type GateLock = <T>(fn: () => Promise<T>) => Promise<T>;

export interface ConsumeGateDeps {
  slots: ClaudeSlots;
  /** HTTP is mandatory and injected: this module never calls global fetch. */
  postRefresh: (request: HttpRequestDescription) => Promise<RefreshHttpResponse>;
  /** Clock is injected so expiry and stash IDs are deterministic in tests. */
  now: () => number;
  withConsumeLock?: GateLock;
  withSwitchLock?: GateLock;
  /** A testable, collision-free stash identifier supplied by a host when needed. */
  stashTimestamp?: () => string;
  warn?: (message: string) => void;
}

export interface ConsumeClaudeSlotInput {
  accountId: string;
  /** Credential read by the caller before it entered the consume gate. */
  snapshot: string;
}

function slotMissing(error: unknown): boolean {
  return error instanceof Error && /item not found|slot not found/i.test(error.message);
}

function refreshedCredential(current: string, response: Extract<ReturnType<typeof classifyRefreshResponse>, { kind: 'success' }>, now: number): string | null {
  const blob = parseCredentialBlob(current);
  if (!blob?.oauth) return null;
  const oauth = blob.oauth;
  oauth.accessToken = response.accessToken;
  oauth.expiresAt = now + response.expiresInMs;
  if (response.refreshToken) oauth.refreshToken = response.refreshToken;
  if (response.scopes) oauth.scopes = response.scopes;
  return serializeCredentialBlob(blob);
}

let nextStashSequence = 0;

function defaultStashTimestamp(now: number): string {
  // Different slots can consume concurrently, so timestamps must not collide.
  // The suffix remains a non-secret, manually-addressable S36 identifier.
  nextStashSequence += 1;
  return `${new Date(now).toISOString()}-${nextStashSequence}`;
}

/**
 * Spend an inactive slot's refresh token exactly once: locked re-read, unlocked
 * POST, then locked CAS/persist (or S36 stash). This is an exact N8 port:
 * only a *changed and non-expired* access token skips the POST.
 */
export async function consumeClaudeSlot(deps: ConsumeGateDeps, input: ConsumeClaudeSlotInput): Promise<ConsumeGateResult> {
  const now = deps.now;
  const consumeLock = deps.withConsumeLock ?? ((fn) => withClaudeConsumeLock(input.accountId, fn));
  const switchLock = deps.withSwitchLock ?? ((fn) => withClaudeSwitchLock(fn));

  try {
    return await consumeLock(async () => {
      let reread: ReadClaudeSlot;
      try {
        const preAdopt = await switchLock(async () => {
          try {
            await deps.slots.adoptStashedSuccessor(input.accountId);
            return null;
          } catch (error) {
            if (error instanceof Error && /unclaimed credential unavailable/.test(error.message)) return 'stash-unreadable' as const;
            if (slotMissing(error)) return 'slot-removed' as const;
            return 'transient' as const;
          }
        });
        if (preAdopt) return { kind: preAdopt };
        const underLock = await switchLock(async () => {
          try { return await deps.slots.readSlot(input.accountId, { fresh: true }); } catch (error) {
            return slotMissing(error) ? 'slot-removed' as const : 'transient' as const;
          }
        });
        if (typeof underLock === 'string') return { kind: underLock };
        reread = underLock;
      } catch {
        return { kind: 'transient' };
      }

      const freshAccess = extractAccessToken(reread.credential);
      const snapshotAccess = extractAccessToken(input.snapshot);
      if (freshAccess && snapshotAccess && freshAccess !== snapshotAccess) {
        const expiresAt = parseCredentialBlob(reread.credential)?.oauth?.expiresAt;
        if (!isOAuthTokenExpired(expiresAt, now())) return { kind: 'current', credential: reread.credential, consumedFp: reread.fingerprint };
      }

      const consumedFp = credentialFingerprint(reread.credential) ?? reread.fingerprint;
      const request = buildRefreshRequest(reread.credential);
      if (request.kind === 'no_refresh_token') return { kind: 'dead', consumedFp };
      if (request.kind !== 'request') return { kind: 'transient', consumedFp };

      let response: RefreshHttpResponse;
      try { response = await deps.postRefresh(request.request); } catch { return { kind: 'transient', consumedFp }; }
      const classified = classifyRefreshResponse(response.status, response.body);
      if (classified.kind === 'dead') return { kind: 'dead', consumedFp };
      if (classified.kind === 'invalid_client') return { kind: 'systemic', consumedFp };
      if (classified.kind !== 'success') return { kind: 'transient', consumedFp };
      const issued = refreshedCredential(reread.credential, classified, now());
      if (!issued) return { kind: 'transient', consumedFp };

      const stash = async (reason: string): Promise<ConsumeGateResult> => {
        try {
          await deps.slots.stashUnclaimed(deps.stashTimestamp?.() ?? defaultStashTimestamp(now()), issued, consumedFp);
          deps.warn?.(`Claude refresh successor stashed after ${reason}`);
          return { kind: reason === 'consume-gate-cas-conflict' ? 'current' : 'transient', credential: issued, consumedFp, stashed: true };
        } catch {
          deps.warn?.('Claude refresh successor could not be persisted or stashed');
          return { kind: 'consume-gate-unpersisted', credential: issued, consumedFp, stashed: false };
        }
      };

      try {
        return await switchLock(async () => {
          let current: ReadClaudeSlot;
          try { current = await deps.slots.readSlot(input.accountId, { fresh: true }); } catch (error) {
            return slotMissing(error) ? stash('consume-gate-slot-removed') : stash('consume-gate-store-unreadable');
          }
          if (current.fingerprint !== consumedFp) {
            const stashed = await stash('consume-gate-cas-conflict');
            return { ...stashed, credential: current.credential, kind: 'current' };
          }
          try {
            await deps.slots.writeSlot(input.accountId, issued, { cause: 'post', evidence: 'post' });
            return { kind: 'refreshed', credential: issued, consumedFp };
          } catch {
            return stash('consume-gate-persist-failed');
          }
        });
      } catch {
        return stash('consume-gate-persist-lock-failed');
      }
    });
  } catch {
    // The outer lock is solely local serialization; no remote grant was spent.
    return { kind: 'busy' };
  }
}
