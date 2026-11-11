import { createHash } from 'node:crypto';

export class SourceMembershipInvalidError extends Error {
  readonly code = 'source-membership-invalid' as const;

  constructor() {
    super('source-membership-invalid');
    this.name = 'SourceMembershipInvalidError';
  }
}

export type AnthropicIdentityKind = 'email' | 'accountUuid';

export interface CompleteSetMemberInput {
  ordinal: number;
  expires: number;
  identityKind: AnthropicIdentityKind;
  identity: string;
}

export interface CompleteSetCommitment {
  version: 1;
  memberCount: number;
  digest: string;
}

export interface AnthropicStageBinding {
  version: 1;
  cycle: string;
  stagedAt: number;
  memberCount: number;
  aliases: string[];
  identityKinds: AnthropicIdentityKind[];
  completeSetCommitment: CompleteSetCommitment;
}

export interface AdmittedAnthropicMember extends CompleteSetMemberInput {
  access: string;
  refresh: string;
  source: Record<string, unknown>;
}

export interface AdmittedAnthropicPool {
  memberCount: number;
  members: AdmittedAnthropicMember[];
  aliases: string[];
  identityKinds: AnthropicIdentityKind[];
  commitment: CompleteSetCommitment;
}

const IDENTITY_TAG: Record<AnthropicIdentityKind, number> = {
  email: 0x01,
  accountUuid: 0x02,
};

function reject(): never {
  throw new SourceMembershipInvalidError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertUnicodeScalars(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) reject();
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) reject();
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) reject();
  }
}

function scalarString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) reject();
  assertUnicodeScalars(value);
  return value;
}

function u8(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 255) reject();
  return Buffer.from([value]);
}

function u32be(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) reject();
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function u64be(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) reject();
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function bytes32(value: Buffer): Buffer {
  return Buffer.concat([u32be(value.length), value]);
}

function utf8_32(value: string): Buffer {
  assertUnicodeScalars(value);
  return bytes32(Buffer.from(value, 'utf8'));
}

const DOMAIN_COMPLETE = utf8_32('qlb:anthropic:pool-complete-set:v1\u0000');

export function memberAlias(ordinal: number): string {
  return `member-${String(ordinal + 1).padStart(4, '0')}`;
}

export function encodeCompleteSetPreimage(members: readonly CompleteSetMemberInput[]): Buffer {
  if (!Number.isSafeInteger(members.length) || members.length < 1 || members.length > 0xffffffff) reject();
  const parts: Buffer[] = [DOMAIN_COMPLETE, u32be(members.length)];
  members.forEach((member, index) => {
    if (member.ordinal !== index) reject();
    const tag = IDENTITY_TAG[member.identityKind];
    if (tag === undefined) reject();
    parts.push(
      u32be(member.ordinal),
      u8(0x01),
      u8(0x01),
      u8(0x01),
      u64be(member.expires),
      u8(tag),
      utf8_32(scalarString(member.identity)),
    );
  });
  return Buffer.concat(parts);
}

function sha256Base64Url(preimage: Buffer): string {
  return createHash('sha256').update(preimage).digest('base64url');
}

function declaredIdentity(member: Record<string, unknown>): { identityKind: AnthropicIdentityKind; identity: string } {
  const hasEmail = Object.hasOwn(member, 'email');
  const hasUuid = Object.hasOwn(member, 'accountUuid');
  if (hasEmail === hasUuid) reject();
  return hasEmail
    ? { identityKind: 'email', identity: scalarString(member.email) }
    : { identityKind: 'accountUuid', identity: scalarString(member.accountUuid) };
}

function memberCredentials(member: Record<string, unknown>): { access: string; refresh: string; expires: number } {
  const credentials = member.credentials;
  if (!isRecord(credentials) || credentials.type !== 'oauth') reject();
  const expires = credentials.expires;
  if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires < 0) reject();
  return {
    access: scalarString(credentials.access),
    refresh: scalarString(credentials.refresh),
    expires,
  };
}

export function admitAnthropicCompleteSet(raw: string): AdmittedAnthropicPool {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reject();
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.accounts) || parsed.accounts.length < 1) reject();
  const seen = new Set<string>();
  const members: AdmittedAnthropicMember[] = parsed.accounts.map((entry, ordinal) => {
    if (!isRecord(entry)) reject();
    const identity = declaredIdentity(entry);
    const credentials = memberCredentials(entry);
    const utf8 = Buffer.from(identity.identity, 'utf8').toString('hex');
    const unique = `${identity.identityKind}\0${utf8}`;
    if (seen.has(unique)) reject();
    seen.add(unique);
    return { ordinal, ...identity, ...credentials, source: entry };
  });
  const preimage = encodeCompleteSetPreimage(members);
  return {
    memberCount: members.length,
    members,
    aliases: members.map((member) => memberAlias(member.ordinal)),
    identityKinds: members.map((member) => member.identityKind),
    commitment: {
      version: 1,
      memberCount: members.length,
      digest: sha256Base64Url(preimage),
    },
  };
}
