// Pure audit-outcome classification for qlb-pi.
// Vocabulary matches QLB retire.ts (`ok` | `failed`).

export type AuditOutcome = "ok" | "failed";

export function classifyHttpStatus(status: unknown): AuditOutcome {
  return typeof status === "number" && status >= 200 && status < 300
    ? "ok"
    : "failed";
}

export function isAuthHttpStatus(status: unknown): boolean {
  return status === 401;
}

/** True for 401 / revoked-token / invalid_grant messages. Not generic failures. */
export function isAuthFailureText(error: string | undefined): boolean {
  if (!error) return false;
  return (
    /(?:^|[^0-9])401(?:[^0-9]|$)/.test(error) ||
    /unauthorized/i.test(error) ||
    /access token has been revoked/i.test(error) ||
    /invalid_grant/i.test(error)
  );
}

function readErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.errorMessage === "string" && rec.errorMessage.length > 0) {
    return rec.errorMessage;
  }
  if (typeof rec.message === "string" && rec.message.length > 0) {
    return rec.message;
  }
  if (typeof rec.error === "string" && rec.error.length > 0) {
    return rec.error;
  }
  if (rec.error && typeof rec.error === "object") {
    return readErrorMessage(rec.error);
  }
  return undefined;
}

function isErrorStopReason(value: unknown): boolean {
  return value === "error" || value === "aborted";
}

/**
 * Map one provider stream event to an audit outcome.
 * Returns null for intermediate events that should not change the recorded result.
 */
export function classifyProviderStreamEvent(
  event: unknown,
): { outcome: AuditOutcome; error?: string } | null {
  if (!event || typeof event !== "object") return null;
  const rec = event as Record<string, unknown>;
  const nestedMessage =
    rec.message && typeof rec.message === "object"
      ? (rec.message as Record<string, unknown>)
      : undefined;
  const errorMessage =
    readErrorMessage(rec) ??
    readErrorMessage(rec.error) ??
    readErrorMessage(nestedMessage);

  if (rec.type === "error" || isErrorStopReason(rec.reason) || isErrorStopReason(rec.stopReason)) {
    return { outcome: "failed", error: errorMessage };
  }

  const nestedStop = nestedMessage?.stopReason;
  if (isErrorStopReason(nestedStop) || (typeof errorMessage === "string" && rec.type === "done")) {
    return { outcome: "failed", error: errorMessage };
  }

  if (rec.type === "done") {
    return { outcome: "ok" };
  }

  return null;
}

export const STREAM_ENDED_WITHOUT_SUCCESS =
  "stream ended without a successful done event";
