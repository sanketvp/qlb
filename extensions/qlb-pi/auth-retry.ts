// Retry-once on 401 after native-credential resync for qlb-pi.
// Kept in the extension directory because Pi's jiti loader cannot import
// from qlb's src/ tree. The protocol matches src/native-resync.ts:
//   auth failure → resync once → if resynced, retry the stream once.
//   a second auth failure does not resync again.

import {
  classifyProviderStreamEvent,
  isAuthFailureText,
  STREAM_ENDED_WITHOUT_SUCCESS,
  type AuditOutcome,
} from "./outcome.js";

export interface StreamAuthRetryResult {
  outcome: AuditOutcome;
  error?: string;
  retried: boolean;
}

export interface ResyncSignal {
  resynced: boolean;
  reason: string;
}

async function collectStream(stream: AsyncIterable<unknown>): Promise<{
  events: unknown[];
  outcome: AuditOutcome;
  error?: string;
}> {
  const events: unknown[] = [];
  let outcome: AuditOutcome = "failed";
  let error: string | undefined = STREAM_ENDED_WITHOUT_SUCCESS;
  for await (const event of stream) {
    events.push(event);
    const classified = classifyProviderStreamEvent(event);
    if (classified) {
      outcome = classified.outcome;
      error = classified.error;
    }
  }
  return { events, outcome, error };
}

export function shouldResyncAfterAuthFailure(
  outcome: AuditOutcome,
  error: string | undefined,
  alreadyRetried: boolean,
): boolean {
  return !alreadyRetried && outcome === "failed" && isAuthFailureText(error);
}

/**
 * Run a provider stream. On a 401/auth-error, call `resync` exactly once.
 * If it reports `resynced: true`, start a fresh stream (caller re-reads the
 * access token via `readAccess`). Buffered first-attempt events are discarded
 * on a successful resync so the user does not see the recovered 401.
 */
export async function streamWithAuthRetry(opts: {
  readAccess: () => string;
  startStream: (access: string) => AsyncIterable<unknown>;
  resync: () => Promise<ResyncSignal>;
  onEvent: (event: unknown) => void;
  onResync: (result: ResyncSignal) => void;
}): Promise<StreamAuthRetryResult> {
  const runOnce = async (): Promise<{
    events: unknown[];
    outcome: AuditOutcome;
    error?: string;
  }> => {
    try {
      const access = opts.readAccess();
      return await collectStream(opts.startStream(access));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { events: [], outcome: "failed", error: message };
    }
  };

  const first = await runOnce();
  if (!shouldResyncAfterAuthFailure(first.outcome, first.error, false)) {
    for (const event of first.events) opts.onEvent(event);
    return { outcome: first.outcome, error: first.error, retried: false };
  }

  let resync: ResyncSignal;
  try {
    resync = await opts.resync();
  } catch (err) {
    resync = {
      resynced: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    opts.onResync(resync);
  } catch {
    // audit must never break the request path
  }
  if (!resync.resynced) {
    for (const event of first.events) opts.onEvent(event);
    return { outcome: first.outcome, error: first.error, retried: false };
  }

  const second = await runOnce();
  for (const event of second.events) opts.onEvent(event);
  return { outcome: second.outcome, error: second.error, retried: true };
}
