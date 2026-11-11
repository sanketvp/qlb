import type { AnthropicPoolTransport } from '../../src/anthropic-rehearsal-proof';

/** Fake profile/usage transport for pool fixtures whose identity is `accountUuid`. */
export function uuidPoolTransport(
  pairs: ReadonlyArray<{ access: string; uuid: string }>,
  log?: string[],
): AnthropicPoolTransport {
  const byToken = new Map(pairs.map((pair) => [pair.access, pair.uuid]));
  return {
    async getProfile(accessToken) {
      log?.push(`profile:${accessToken}`);
      return { status: 200, body: { account: { uuid: byToken.get(accessToken) ?? '' } } };
    },
    async getUsage(accessToken) {
      log?.push(`usage:${accessToken}`);
      return { status: 200, body: { five_hour: { utilization: 1 }, seven_day: { utilization: 2 } } };
    },
  };
}
