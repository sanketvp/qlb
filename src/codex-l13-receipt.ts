/** Returns a non-negative safe integer, or null for an absent or malformed value. */
export function safeNonNegativeInt(value: string | null): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

/** Returns the recorded C9 receipt time, or null for an absent, malformed, or unprintable value. */
export function codexL13ReceiptAt(value: string | null): number | null {
  const timestamp = safeNonNegativeInt(value);
  return timestamp !== null && timestamp <= 8_640_000_000_000_000 ? timestamp : null;
}
