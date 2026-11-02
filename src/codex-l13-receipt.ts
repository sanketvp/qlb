/** Returns the recorded C9 receipt time, or null for an absent or malformed value. */
export function codexL13ReceiptAt(value: string | null): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}
