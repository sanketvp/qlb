import type { AnthropicIdentityKind } from './anthropic-complete-set';
import { parseProfileResponse, parseUsageResponse } from './anthropic-oauth';

/**
 * Provider UUID comparison uses `parseProfileResponse`, which trims the UUID.
 * Source identities are compared exactly and are not trimmed or case-folded.
 * A normal profile has `account.uuid` plus, for an email member, `account.email`.
 * A second declared identity is `account.accountUuid` on an email member, or a
 * string `account.email` on a UUID member.
 */
export interface AnthropicHttpResult {
  status: number;
  body: unknown;
}

export interface AnthropicPoolTransport {
  getProfile(accessToken: string): Promise<AnthropicHttpResult>;
  getUsage(accessToken: string): Promise<AnthropicHttpResult>;
}

export interface UsageBuckets {
  '5h': number;
  '7d': number;
}

export interface IdentityProofMember {
  alias: string;
  identityKind: AnthropicIdentityKind;
  hasProviderUuid: true;
  buckets: UsageBuckets;
}

export interface IdentityProof {
  version: 1;
  cycle: string;
  provedAt: number;
  memberCount: number;
  aliases: string[];
  members: IdentityProofMember[];
}

export interface ProofBindingView {
  cycle: string;
  memberCount: number;
  aliases: readonly string[];
  identityKinds: readonly AnthropicIdentityKind[];
}

type ProfileRead =
  | { ok: true; providerUuid: string }
  | { ok: false; code: 'identity-mismatch' | 'proof-unavailable' };

type UsageRead =
  | { ok: true; buckets: UsageBuckets }
  | { ok: false; code: 'proof-unavailable' };

const PROOF_KEYS = ['version', 'cycle', 'provedAt', 'memberCount', 'aliases', 'members'];
const MEMBER_KEYS = ['alias', 'identityKind', 'hasProviderUuid', 'buckets'];
const BUCKET_KEYS = ['5h', '7d'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function httpOk(response: AnthropicHttpResult): boolean {
  return Number.isInteger(response.status) && response.status >= 200 && response.status < 300;
}

function finiteUtilization(value: unknown): number | null {
  if (!isRecord(value) || typeof value.utilization !== 'number' || !Number.isFinite(value.utilization)) return null;
  return value.utilization;
}

export function readProfileIdentity(
  identityKind: AnthropicIdentityKind,
  declaredIdentity: string,
  response: AnthropicHttpResult,
): ProfileRead {
  if (!httpOk(response) || !isRecord(response.body)) return { ok: false, code: 'proof-unavailable' };
  const account = response.body.account;
  if (!isRecord(account)) return { ok: false, code: 'proof-unavailable' };
  const parsed = parseProfileResponse(response.body);
  if (!parsed || parsed.uuid.length === 0) return { ok: false, code: 'identity-mismatch' };
  const email = typeof account.email === 'string' && account.email.length > 0 ? account.email : null;
  const declaredUuid = typeof account.accountUuid === 'string' && account.accountUuid.length > 0;
  if (identityKind === 'email') {
    if (declaredUuid || email === null || email !== declaredIdentity) return { ok: false, code: 'identity-mismatch' };
    return { ok: true, providerUuid: parsed.uuid };
  }
  if (email !== null || parsed.uuid !== declaredIdentity) return { ok: false, code: 'identity-mismatch' };
  return { ok: true, providerUuid: parsed.uuid };
}

export function readUsageBuckets(response: AnthropicHttpResult): UsageRead {
  if (!httpOk(response) || !isRecord(response.body)) return { ok: false, code: 'proof-unavailable' };
  const five = finiteUtilization(response.body.five_hour);
  const seven = finiteUtilization(response.body.seven_day);
  if (five === null || seven === null) return { ok: false, code: 'proof-unavailable' };
  try {
    const parsed = parseUsageResponse(response.body);
    const parsedFive = parsed.buckets['5h']?.usedPct;
    const parsedSeven = parsed.buckets['7d']?.usedPct;
    if ((five !== 0 && parsedFive !== five) || (seven !== 0 && parsedSeven !== seven)) {
      return { ok: false, code: 'proof-unavailable' };
    }
  } catch {
    return { ok: false, code: 'proof-unavailable' };
  }
  return { ok: true, buckets: { '5h': five, '7d': seven } };
}

export function assembleIdentityProof(input: {
  cycle: string;
  provedAt: number;
  aliases: readonly string[];
  identityKinds: readonly AnthropicIdentityKind[];
  readings: readonly { providerUuid: string; buckets: UsageBuckets }[];
}): { ok: true; proof: IdentityProof } | { ok: false; code: 'identity-mismatch' } {
  if (
    !Number.isSafeInteger(input.provedAt)
    || input.provedAt < 0
    || input.readings.length !== input.aliases.length
    || input.identityKinds.length !== input.aliases.length
  ) {
    return { ok: false, code: 'identity-mismatch' };
  }
  const seen = new Set<string>();
  const members: IdentityProofMember[] = [];
  for (let index = 0; index < input.readings.length; index += 1) {
    const reading = input.readings[index];
    const alias = input.aliases[index];
    const identityKind = input.identityKinds[index];
    if (
      !reading
      || alias === undefined
      || identityKind === undefined
      || reading.providerUuid.length === 0
      || seen.has(reading.providerUuid)
    ) {
      return { ok: false, code: 'identity-mismatch' };
    }
    seen.add(reading.providerUuid);
    const buckets = reading.buckets;
    members.push({
      alias,
      identityKind,
      hasProviderUuid: true,
      buckets: { '5h': buckets['5h'], '7d': buckets['7d'] },
    });
  }
  return {
    ok: true,
    proof: {
      version: 1,
      cycle: input.cycle,
      provedAt: input.provedAt,
      memberCount: input.aliases.length,
      aliases: input.aliases.slice(),
      members,
    },
  };
}

function finiteBucket(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Allowlisted `5h` / `7d` readings, or null when the journal proof is not complete for this cycle. */
export function identityProofBuckets(proof: unknown, binding: ProofBindingView): UsageBuckets[] | null {
  if (!isRecord(proof) || !sameKeys(proof, PROOF_KEYS) || proof.version !== 1) return null;
  if (proof.cycle !== binding.cycle || proof.memberCount !== binding.memberCount) return null;
  if (typeof proof.provedAt !== 'number' || !Number.isSafeInteger(proof.provedAt) || proof.provedAt < 0) return null;
  if (!Array.isArray(proof.aliases) || !Array.isArray(proof.members) || !Array.isArray(binding.aliases)) return null;
  if (proof.aliases.length !== binding.memberCount || proof.members.length !== binding.memberCount) return null;
  const buckets: UsageBuckets[] = [];
  for (let index = 0; index < binding.memberCount; index += 1) {
    const alias = binding.aliases[index];
    const member = proof.members[index];
    if (proof.aliases[index] !== alias || !isRecord(member) || !sameKeys(member, MEMBER_KEYS)) return null;
    if (member.alias !== alias || member.identityKind !== binding.identityKinds[index] || member.hasProviderUuid !== true) return null;
    const raw = member.buckets;
    if (!isRecord(raw) || !sameKeys(raw, BUCKET_KEYS)) return null;
    const five = finiteBucket(raw['5h']);
    const seven = finiteBucket(raw['7d']);
    if (five === null || seven === null) return null;
    buckets.push({ '5h': five, '7d': seven });
  }
  return buckets;
}

export function identityMismatchRefusal(detail: unknown): boolean {
  if (!isRecord(detail)) return false;
  const refusal = detail.rehearseRefusal;
  return isRecord(refusal) && sameKeys(refusal, ['code']) && refusal.code === 'identity-mismatch';
}
