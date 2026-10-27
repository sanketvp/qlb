/*
 * Ported from claude-swap 0.28.0.
 * Upstream file(s): src/claude_swap/switcher.py:2199-2614,2641.
 * License: MIT.
 * Modified for QLB. See NOTICE.
 */

// The inactive-Claude refresh consume gate (§4.2.2, N8). Network, locks,
// clock, warning sink, and credential storage are injected at the boundary.

import { randomBytes } from 'node:crypto';
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
  /** A non-secret typed explanation when an issued successor could not be stashed. */
  successorFailure?: { kind: 'successor-unpersisted'; stashFailure: string };
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

/** Collision-free across processes while remaining a non-secret S36 identifier. */
export function defaultStashTimestamp(now: number): string {
  return `${new Date(now).toISOString().replace(/:/g, '-')}-${process.pid}-${randomBytes(12).toString('hex')}`;
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

  let issuedSuccessor: string | undefined;
  let issuedConsumedFp: string | undefined;
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
      // Lineage remains refresh-token based, but the CAS must guard all bytes:
      // a concurrent access-token/expiry update may retain the refresh token.
      const consumedContentFingerprint = reread.contentFingerprint;
      const request = buildRefreshRequest(reread.credential);
      if (request.kind === 'no_refresh_token') return { kind: 'dead', consumedFp };
      if (request.kind !== 'request') return { kind: 'transient', consumedFp };

      let response: RefreshHttpResponse;
      // Keep a pre-POST clock fallback so a faulty injected clock cannot
      // lose a successfully-issued successor after the POST.
      let issuedAt: number;
      try {
        issuedAt = now();
        response = await deps.postRefresh(request.request);
      } catch { return { kind: 'transient', consumedFp }; }
      try { issuedAt = now(); } catch { /* Preserve the safe pre-POST fallback. */ }
      const classified = classifyRefreshResponse(response.status, response.body);
      if (classified.kind === 'dead') return { kind: 'dead', consumedFp };
      if (classified.kind === 'invalid_client') return { kind: 'systemic', consumedFp };
      if (classified.kind !== 'success') return { kind: 'transient', consumedFp };
      const issued = refreshedCredential(reread.credential, classified, issuedAt);
      if (!issued) return { kind: 'transient', consumedFp };
      issuedSuccessor = issued;
      issuedConsumedFp = consumedFp;

      const warn = (message: string): void => {
        try { deps.warn?.(message); } catch { /* A diagnostic sink cannot lose a successor. */ }
      };
      const stash = async (reason: string, successor = issued): Promise<ConsumeGateResult> => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          let stashId: string;
          try {
            // Keep every potentially-throwing injected callback in this
            // attempt: after the POST, failures must return the successor.
            stashId = deps.stashTimestamp?.() ?? defaultStashTimestamp(now());
          } catch {
            const stashFailure = 'unclaimed stash id unavailable';
            warn('Claude refresh successor could not be persisted or stashed');
            return {
              kind: 'consume-gate-unpersisted', credential: successor, consumedFp, stashed: false,
              successorFailure: { kind: 'successor-unpersisted', stashFailure },
            };
          }
          try {
            await deps.slots.stashUnclaimed(stashId, successor, consumedFp, input.accountId);
            warn(`Claude refresh successor stashed after ${reason}`);
            return { kind: reason === 'consume-gate-cas-conflict' ? 'current' : 'transient', credential: successor, consumedFp, stashed: true };
          } catch (error) {
            // A collision reservation is never overwritten. Host-supplied ids
            // are intentional and should surface their failure; generated ids
            // get a fresh cross-process-safe retry.
            if (!deps.stashTimestamp && error instanceof Error && /already exists/.test(error.message) && attempt < 2) continue;
            const stashFailure = 'unable to persist unclaimed credential';
            warn('Claude refresh successor could not be persisted or stashed');
            return {
              kind: 'consume-gate-unpersisted', credential: successor, consumedFp, stashed: false,
              successorFailure: { kind: 'successor-unpersisted', stashFailure },
            };
          }
        }
        return {
          kind: 'consume-gate-unpersisted', credential: successor, consumedFp, stashed: false,
          successorFailure: { kind: 'successor-unpersisted', stashFailure: 'unclaimed stash id collision' },
        };
      };

      try {
        return await switchLock(async () => {
          let current: ReadClaudeSlot;
          try { current = await deps.slots.readSlot(input.accountId, { fresh: true }); } catch (error) {
            return slotMissing(error) ? stash('consume-gate-slot-removed') : stash('consume-gate-store-unreadable');
          }
          if (current.contentFingerprint !== consumedContentFingerprint) {
            // A content-only racer retained the refresh token just spent by
            // this POST. Preserve its concurrent fields while installing the
            // response token set; its refresh token is no longer safe.
            if (credentialFingerprint(current.credential) === consumedFp) {
              const successor = refreshedCredential(current.credential, classified, issuedAt);
              if (!successor) return stash('consume-gate-persist-failed');
              try {
                await deps.slots.writeSlot(input.accountId, successor, { cause: 'post', evidence: 'post' });
                return { kind: 'refreshed', credential: successor, consumedFp };
              } catch {
                return stash('consume-gate-persist-failed', successor);
              }
            }
            const stashed = await stash('consume-gate-cas-conflict');
            // A failed stash leaves the issued successor only in this result;
            // never relabel it as current or replace it with the racer's bytes.
            if (!stashed.stashed) return stashed;
            return { kind: 'current', credential: current.credential, consumedFp, stashed: true };
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
    if (issuedSuccessor) {
      return {
        kind: 'consume-gate-unpersisted', credential: issuedSuccessor, consumedFp: issuedConsumedFp, stashed: false,
        successorFailure: { kind: 'successor-unpersisted', stashFailure: 'consume gate failed after refresh POST' },
      };
    }
    // The outer lock is solely local serialization before a successor exists.
    return { kind: 'busy' };
  }
}
