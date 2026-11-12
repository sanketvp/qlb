import { memberAlias, type AdmittedAnthropicPool, type AnthropicIdentityKind } from './anthropic-complete-set';

/** More than this remaining lifetime is `fresh`. Exactly this, or less, is `under-2h`. */
export const ADOPTION_FRESH_MS = 2 * 60 * 60 * 1000;

export type AdoptionSlotClass = 'matched' | 'missing' | 'ambiguous' | 'dead-or-archived';

export type AdoptionExpiry = 'fresh' | 'under-2h' | 'expired' | 'none';

export type AdoptionRefusalCode =
  | 'adoption-ambiguous'
  | 'adoption-slot-missing'
  | 'adoption-slot-unusable';

export interface AdoptionSlotView {
  accountId: string;
  email: string | null;
  dead: boolean;
  archivedAt: number | null;
}

export interface PlannedAdoptionMember {
  alias: string;
  identityKind: AnthropicIdentityKind;
  slot: AdoptionSlotClass;
  expiry: AdoptionExpiry;
  active: boolean;
  /** Unambiguous match only. Receipts and status must not print this. */
  slotAccountId: string | null;
}

export interface AdoptionPlan {
  members: PlannedAdoptionMember[];
  code?: AdoptionRefusalCode;
}

export function classifyPoolExpiry(expires: number, now: number): AdoptionExpiry {
  if (expires === 0) return 'none';
  if (expires <= now) return 'expired';
  if (expires - now <= ADOPTION_FRESH_MS) return 'under-2h';
  return 'fresh';
}

function slotMatches(
  identityKind: AnthropicIdentityKind,
  identity: string,
  slot: AdoptionSlotView,
): boolean {
  if (identityKind === 'accountUuid') return identity === slot.accountId;
  return slot.email !== null && identity === slot.email;
}

/**
 * Match each admitted member to existing slots. Ambiguous covers both
 * directions: one member matching two or more rows, and two or more members
 * matching one row. Dead and archived rows count as candidates.
 */
export function planAnthropicAdoption(
  admitted: AdmittedAnthropicPool,
  slots: readonly AdoptionSlotView[],
  activeAccountId: string | null,
  now: number,
): AdoptionPlan {
  const matches = admitted.members.map((member) => slots.filter((slot) => slotMatches(
    member.identityKind,
    member.identity,
    slot,
  )));
  const claimants = new Map<string, number>();
  for (const rows of matches) {
    for (const accountId of new Set(rows.map((slot) => slot.accountId))) {
      claimants.set(accountId, (claimants.get(accountId) ?? 0) + 1);
    }
  }
  const members = admitted.members.map((member, index): PlannedAdoptionMember => {
    const rows = matches[index] ?? [];
    const shared = rows.some((slot) => (claimants.get(slot.accountId) ?? 0) >= 2);
    let slot: AdoptionSlotClass;
    let slotAccountId: string | null = null;
    if (rows.length === 0) slot = 'missing';
    else if (rows.length >= 2 || shared) slot = 'ambiguous';
    else {
      const only = rows[0]!;
      slotAccountId = only.accountId;
      slot = only.dead || only.archivedAt !== null ? 'dead-or-archived' : 'matched';
    }
    return {
      alias: admitted.aliases[index] ?? memberAlias(member.ordinal),
      identityKind: member.identityKind,
      slot,
      expiry: classifyPoolExpiry(member.expires, now),
      active: slotAccountId !== null && slotAccountId === activeAccountId,
      slotAccountId,
    };
  });
  let code: AdoptionRefusalCode | undefined;
  if (members.some((member) => member.slot === 'ambiguous')) code = 'adoption-ambiguous';
  else if (members.some((member) => member.slot === 'missing')) code = 'adoption-slot-missing';
  else if (members.some((member) => member.slot === 'dead-or-archived')) code = 'adoption-slot-unusable';
  return code === undefined ? { members } : { members, code };
}

const BINDING_KEYS = ['version', 'cycle', 'members', 'initialActiveAlias'];
const MEMBER_KEYS = ['alias', 'slotAccountId'];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export interface ParsedAdoptionBinding {
  cycle: string;
  initialActiveAlias: string;
  members: Array<{ alias: string; slotAccountId: string }>;
}

export function readAdoptionBinding(value: unknown): ParsedAdoptionBinding | null {
  const binding = record(value);
  if (!binding || !sameKeys(binding, BINDING_KEYS) || binding.version !== 1) return null;
  if (typeof binding.cycle !== 'string' || binding.cycle.length === 0) return null;
  if (typeof binding.initialActiveAlias !== 'string') return null;
  if (!Array.isArray(binding.members) || binding.members.length === 0) return null;
  const members: Array<{ alias: string; slotAccountId: string }> = [];
  for (const member of binding.members) {
    const row = record(member);
    if (!row || !sameKeys(row, MEMBER_KEYS)) return null;
    if (typeof row.alias !== 'string' || typeof row.slotAccountId !== 'string' || row.slotAccountId.length === 0) return null;
    members.push({ alias: row.alias, slotAccountId: row.slotAccountId });
  }
  if (!members.some((member) => member.alias === binding.initialActiveAlias)) return null;
  return { cycle: binding.cycle, initialActiveAlias: binding.initialActiveAlias, members };
}

/**
 * Re-check a rehearsed binding against the live slots. The admitted pool is
 * required so a new row with the same email is ambiguous instead of ignored.
 */
export function assessAnthropicAdoption(
  adoptionBinding: unknown,
  admitted: AdmittedAnthropicPool,
  slots: readonly AdoptionSlotView[],
  activeAccountId: string | null,
  cycle: string,
  now: number,
): 'ok' | 'adoption-mismatch' {
  const binding = readAdoptionBinding(adoptionBinding);
  if (!binding || binding.cycle !== cycle || binding.members.length !== admitted.memberCount) return 'adoption-mismatch';
  if (!binding.members.every((member, index) => member.alias === admitted.aliases[index])) return 'adoption-mismatch';
  const plan = planAnthropicAdoption(admitted, slots, activeAccountId, now);
  if (plan.code) return 'adoption-mismatch';
  const stillBound = plan.members.every((member, index) => (
    member.slot === 'matched' && member.slotAccountId === binding.members[index]?.slotAccountId
  ));
  const initial = plan.members.find((member) => member.alias === binding.initialActiveAlias);
  if (!stillBound || !initial || initial.slotAccountId !== activeAccountId) return 'adoption-mismatch';
  return 'ok';
}
