import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  admitAnthropicCompleteSet,
  memberAlias,
  sourceWitnessForMembers,
  SourceMembershipInvalidError,
  type AdmittedAnthropicPool,
  type AnthropicIdentityKind,
} from './anthropic-complete-set';
import { assessAnthropicAdoption, readAdoptionBinding } from './anthropic-adoption';
import { assessAnthropicForwardAdmission } from './anthropic-forward-admission';
import { identityMismatchRefusal, identityProofBuckets } from './anthropic-rehearsal-proof';
import { distinctAnthropicStageAccounts, stagingOwnerPath } from './migration';

export const RECEIPT_SCHEMA_VERSION = 1;

export const RECEIPT_PHASES = ['stage', 'rehearse', 'commit', 'failure'] as const;

export type AnthropicReceiptPhase = (typeof RECEIPT_PHASES)[number];

export function receiptPhaseList(): string {
  return [...RECEIPT_PHASES, 'preflight', 'smoke'].join('|');
}

/** Codes this slice can put on a receipt. Later slices add the other fixed public codes. */
export type AnthropicReceiptCode =
  | 'source-membership-invalid'
  | 'proof-unavailable'
  | 'identity-mismatch'
  | 'source-witness-unavailable'
  | 'proof-stale'
  | 'token-expired'
  | 'adoption-slot-missing'
  | 'adoption-ambiguous'
  | 'adoption-slot-unusable'
  | 'initial-active-invalid'
  | 'adoption-mismatch';

const REHEARSE_REFUSAL_CODES = [
  'identity-mismatch',
  'token-expired',
  'adoption-slot-missing',
  'adoption-ambiguous',
  'adoption-slot-unusable',
  'initial-active-invalid',
] as const satisfies readonly AnthropicReceiptCode[];

/**
 * `proof-unavailable` is the no-forward plan's fixed code for a phase that
 * cannot succeed before proof exists. Commit, resume, and status guards stay
 * in the activation PR; this projection only reports the code.
 */
export const ANTHROPIC_PROOF_UNAVAILABLE = 'proof-unavailable' as const;

export interface ReceiptBuckets {
  '5h': number;
  '7d': number;
}

export type AnthropicReceipt =
  | {
      schemaVersion: 1;
      phase: 'stage';
      disposition: 'success';
      membership: 'complete';
      count: number;
      aliases: string[];
    }
  | {
      schemaVersion: 1;
      phase: 'rehearse';
      disposition: 'success';
      membership: 'complete';
      count: number;
      aliases: string[];
      buckets: ReceiptBuckets[];
      adoption: 'verified';
      initialActive: string;
    }
  | {
      schemaVersion: 1;
      phase: 'commit';
      disposition: 'success';
      membership: 'complete';
      count: number;
      aliases: string[];
    }
  | {
      schemaVersion: 1;
      phase: AnthropicReceiptPhase;
      disposition: 'refused';
      code?: AnthropicReceiptCode;
    };

export interface AnthropicReceiptSources {
  poolText: string | null;
  journalDetail: unknown;
  stagingDocument: unknown;
  ownerDocument?: unknown;
  adoptionSlots?: Array<{ accountId: string; email: string | null; dead: boolean; archivedAt: number | null }>;
  activeAccountId?: string | null;
  now?: number;
}

interface PrivateBinding {
  cycle: string;
  stagedAt: number;
  memberCount: number;
  aliases: string[];
  identityKinds: AnthropicIdentityKind[];
  commitmentDigest: string;
}

const BINDING_KEYS = ['version', 'cycle', 'stagedAt', 'memberCount', 'aliases', 'identityKinds', 'completeSetCommitment'];
const COMMITMENT_KEYS = ['version', 'memberCount', 'digest'];
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function isReceiptPhase(value: string | undefined): value is AnthropicReceiptPhase | 'preflight' | 'smoke' {
  return value === 'preflight' || value === 'smoke' || (!!value && (RECEIPT_PHASES as readonly string[]).includes(value));
}

export interface AnthropicSmokeReceipt {
  schemaVersion: 1;
  phase: 'smoke';
  disposition: 'success' | 'refused';
  servedAlias?: string;
  matchesInitialActive?: boolean;
  servedAfterCommit?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Alias only. The served account id is used for matching and is not copied out. */
export function projectAnthropicSmoke(input: {
  journalDetail: unknown;
  servedAccountId: string | null;
  state: string | null;
}): AnthropicSmokeReceipt {
  const detail = isRecord(input.journalDetail) ? input.journalDetail : null;
  const binding = readAdoptionBinding(detail?.adoptionBinding);
  const served = binding?.members.find((member) => member.slotAccountId === input.servedAccountId);
  if (!binding || !served || !input.servedAccountId) {
    return { schemaVersion: RECEIPT_SCHEMA_VERSION, phase: 'smoke', disposition: 'refused' };
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    phase: 'smoke',
    disposition: 'success',
    servedAlias: served.alias,
    matchesInitialActive: served.alias === binding.initialActiveAlias,
    servedAfterCommit: input.state === 'QLB_OWNED',
  };
}

export function formatAnthropicSmoke(receipt: AnthropicSmokeReceipt, json: boolean): string {
  const body: Record<string, unknown> = {
    schemaVersion: receipt.schemaVersion,
    phase: receipt.phase,
    disposition: receipt.disposition,
  };
  if (receipt.servedAlias !== undefined) body.servedAlias = receipt.servedAlias;
  if (receipt.matchesInitialActive !== undefined) body.matchesInitialActive = receipt.matchesInitialActive;
  if (receipt.servedAfterCommit !== undefined) body.servedAfterCommit = receipt.servedAfterCommit;
  if (json) return JSON.stringify(body, null, 2);
  return [
    `schema: ${body.schemaVersion}`,
    `phase: ${body.phase}`,
    `disposition: ${body.disposition}`,
    ...(typeof body.servedAlias === 'string' ? [`servedAlias: ${body.servedAlias}`] : []),
    ...(typeof body.matchesInitialActive === 'boolean' ? [`matchesInitialActive: ${body.matchesInitialActive}`] : []),
    ...(typeof body.servedAfterCommit === 'boolean' ? [`servedAfterCommit: ${body.servedAfterCommit}`] : []),
  ].join('\n');
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isAliasList(value: unknown, memberCount: number): value is string[] {
  return Array.isArray(value)
    && value.length === memberCount
    && value.every((alias, index) => alias === memberAlias(index));
}

function isIdentityList(value: unknown, memberCount: number): value is AnthropicIdentityKind[] {
  return Array.isArray(value)
    && value.length === memberCount
    && value.every((kind) => kind === 'email' || kind === 'accountUuid');
}

function readPrivateBinding(value: unknown): PrivateBinding | null {
  if (!isRecord(value) || !sameKeys(value, BINDING_KEYS) || value.version !== 1) return null;
  if (typeof value.cycle !== 'string' || value.cycle.length === 0) return null;
  if (typeof value.stagedAt !== 'number' || !Number.isSafeInteger(value.stagedAt) || value.stagedAt < 0) return null;
  if (typeof value.memberCount !== 'number' || !Number.isSafeInteger(value.memberCount) || value.memberCount < 1) return null;
  if (!isAliasList(value.aliases, value.memberCount) || !isIdentityList(value.identityKinds, value.memberCount)) return null;
  const commitment = value.completeSetCommitment;
  if (!isRecord(commitment) || !sameKeys(commitment, COMMITMENT_KEYS)) return null;
  if (commitment.version !== 1 || commitment.memberCount !== value.memberCount) return null;
  if (typeof commitment.digest !== 'string' || !BASE64URL.test(commitment.digest)) return null;
  return {
    cycle: value.cycle,
    stagedAt: value.stagedAt,
    memberCount: value.memberCount,
    aliases: value.aliases.slice(),
    identityKinds: value.identityKinds.slice(),
    commitmentDigest: commitment.digest,
  };
}

function sameBinding(left: PrivateBinding, right: PrivateBinding): boolean {
  return left.cycle === right.cycle
    && left.stagedAt === right.stagedAt
    && left.memberCount === right.memberCount
    && left.commitmentDigest === right.commitmentDigest
    && left.aliases.every((alias, index) => alias === right.aliases[index])
    && left.identityKinds.every((kind, index) => kind === right.identityKinds[index]);
}

function sourceMatches(admitted: AdmittedAnthropicPool, binding: PrivateBinding): boolean {
  return admitted.memberCount === binding.memberCount
    && admitted.commitment.version === 1
    && admitted.commitment.memberCount === binding.memberCount
    && admitted.commitment.digest === binding.commitmentDigest
    && admitted.aliases.every((alias, index) => alias === binding.aliases[index])
    && admitted.identityKinds.every((kind, index) => kind === binding.identityKinds[index]);
}

function admitPool(poolText: string | null): { admitted: AdmittedAnthropicPool | null; invalid: boolean } {
  if (poolText === null) return { admitted: null, invalid: false };
  try {
    const admitted = admitAnthropicCompleteSet(poolText);
    distinctAnthropicStageAccounts(admitted.members);
    return { admitted, invalid: false };
  } catch (error) {
    return {
      admitted: null,
      invalid: error instanceof SourceMembershipInvalidError && error.code === 'source-membership-invalid',
    };
  }
}

function bindingField(document: unknown): unknown {
  return isRecord(document) ? document.binding : null;
}

export function persistedRehearseRefusal(detail: unknown): AnthropicReceiptCode | null {
  if (!isRecord(detail)) return null;
  const refusal = detail.rehearseRefusal;
  if (!isRecord(refusal) || !sameKeys(refusal, ['code']) || typeof refusal.code !== 'string') return null;
  return (REHEARSE_REFUSAL_CODES as readonly string[]).includes(refusal.code)
    ? refusal.code as AnthropicReceiptCode
    : null;
}

function adoptionReceipt(detail: unknown, binding: PrivateBinding): string | null {
  if (!isRecord(detail) || !isRecord(detail.adoptionBinding)) return null;
  const adoption = detail.adoptionBinding;
  if (adoption.version !== 1 || adoption.cycle !== binding.cycle) return null;
  const members = adoption.members;
  if (!Array.isArray(members) || members.length !== binding.memberCount) return null;
  const aliasesMatch = binding.aliases.every((alias, index) => {
    const member = members[index];
    return isRecord(member) && member.alias === alias && typeof member.slotAccountId === 'string' && member.slotAccountId.length > 0;
  });
  if (!aliasesMatch) return null;
  return typeof adoption.initialActiveAlias === 'string'
    && binding.aliases.includes(adoption.initialActiveAlias)
    ? adoption.initialActiveAlias
    : null;
}

export function projectAnthropicReceipt(
  phase: AnthropicReceiptPhase,
  sources: AnthropicReceiptSources,
): AnthropicReceipt {
  const admission = admitPool(sources.poolText);
  const journal = readPrivateBinding(bindingField(sources.journalDetail));
  const staging = readPrivateBinding(bindingField(sources.stagingDocument));
  const matched = journal !== null
    && staging !== null
    && sameBinding(journal, staging)
    && admission.admitted !== null
    && sourceMatches(admission.admitted, journal);
  if (phase === 'stage' && matched && journal) {
    return {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      phase: 'stage',
      disposition: 'success',
      membership: 'complete',
      count: journal.memberCount,
      aliases: journal.aliases.slice(),
    };
  }
  if (admission.invalid) {
    return { schemaVersion: RECEIPT_SCHEMA_VERSION, phase, disposition: 'refused', code: 'source-membership-invalid' };
  }
  if (phase === 'rehearse' && matched && journal) {
    const buckets = identityProofBuckets(
      isRecord(sources.journalDetail) ? sources.journalDetail.identityProof : null,
      journal,
    );
    const initialActive = adoptionReceipt(sources.journalDetail, journal);
    if (buckets && initialActive) {
      return {
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        phase: 'rehearse',
        disposition: 'success',
        membership: 'complete',
        count: journal.memberCount,
        aliases: journal.aliases.slice(),
        buckets,
        adoption: 'verified',
        initialActive,
      };
    }
    const refusal = persistedRehearseRefusal(sources.journalDetail);
    if (refusal) {
      return { schemaVersion: RECEIPT_SCHEMA_VERSION, phase, disposition: 'refused', code: refusal };
    }
  }
  if (phase === 'commit' || phase === 'failure') {
    const decision = assessAnthropicForwardAdmission(commitEvidence(sources, journal), 'receipt');
    if (phase === 'commit' && decision === 'PUBLISHED' && journal) {
      return {
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        phase: 'commit',
        disposition: 'success',
        membership: 'complete',
        count: journal.memberCount,
        aliases: journal.aliases.slice(),
      };
    }
    if (
      decision === 'source-witness-unavailable'
      || decision === 'proof-stale'
      || decision === 'identity-mismatch'
      || decision === 'proof-unavailable'
      || decision === 'adoption-mismatch'
    ) {
      return { schemaVersion: RECEIPT_SCHEMA_VERSION, phase, disposition: 'refused', code: decision };
    }
  }
  if (phase !== 'stage') {
    return { schemaVersion: RECEIPT_SCHEMA_VERSION, phase, disposition: 'refused', code: ANTHROPIC_PROOF_UNAVAILABLE };
  }
  return { schemaVersion: RECEIPT_SCHEMA_VERSION, phase, disposition: 'refused' };
}

function canonicalOwnerEntry(document: unknown): boolean {
  if (!isRecord(document) || !isRecord(document.providers) || !isRecord(document.providers.anthropic)) return false;
  return document.providers.anthropic.mode === 'qlb';
}

function postOwnerCycle(detail: unknown): string | null {
  if (!isRecord(detail) || !isRecord(detail.postOwnerAdmission)) return null;
  const marker = detail.postOwnerAdmission;
  return marker.version === 1 && typeof marker.cycle === 'string' && marker.cycle.length > 0 ? marker.cycle : null;
}

function commitEvidence(sources: AnthropicReceiptSources, journal: PrivateBinding | null) {
  const sourcePresent = sources.poolText !== null;
  let recomputedWitnessDigest: string | null = null;
  let recomputedCommitmentDigest: string | null = null;
  if (sources.poolText !== null) {
    const admission = admitPool(sources.poolText);
    if (admission.admitted) {
      recomputedWitnessDigest = sourceWitnessForMembers(admission.admitted.members).digest;
      recomputedCommitmentDigest = admission.admitted.commitment.digest;
    }
  }
  return {
    canonicalOwnerEntry: canonicalOwnerEntry(sources.ownerDocument),
    postOwnerCycle: postOwnerCycle(sources.journalDetail),
    binding: journal
      ? {
          cycle: journal.cycle,
          memberCount: journal.memberCount,
          aliases: journal.aliases,
          identityKinds: journal.identityKinds,
          commitmentDigest: journal.commitmentDigest,
        }
      : null,
    storedWitness: isRecord(sources.journalDetail) ? sources.journalDetail.sourceWitness : null,
    recomputedWitnessDigest,
    recomputedCommitmentDigest,
    sourcePresent,
    identityProof: isRecord(sources.journalDetail) ? sources.journalDetail.identityProof : null,
    identityMismatch: identityMismatchRefusal(sources.journalDetail),
    adoptionMismatch: adoptionMismatch(sources, journal),
    adoptionMarkerCycle: adoptionMarkerCycle(sources.journalDetail),
    now: sources.now ?? Date.now(),
  };
}

function adoptionMarkerCycle(detail: unknown): string | null {
  if (!isRecord(detail) || !isRecord(detail.adoption)) return null;
  const marker = detail.adoption;
  return marker.version === 1 && typeof marker.cycle === 'string' && marker.cycle.length > 0 ? marker.cycle : null;
}

function adoptionMismatch(sources: AnthropicReceiptSources, journal: PrivateBinding | null): boolean {
  if (!journal || sources.adoptionSlots === undefined || sources.poolText === null) return false;
  try {
    const admitted = admitAnthropicCompleteSet(sources.poolText);
    return assessAnthropicAdoption(
      isRecord(sources.journalDetail) ? sources.journalDetail.adoptionBinding : null,
      admitted,
      sources.adoptionSlots,
      sources.activeAccountId ?? null,
      journal.cycle,
      sources.now ?? Date.now(),
    ) !== 'ok';
  } catch {
    return false;
  }
}

/** Allowlisted object. Callers serialize this value and never a journal or staging document. */
export function anthropicReceiptBody(receipt: AnthropicReceipt): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    phase: receipt.phase,
    disposition: receipt.disposition,
  };
  if (receipt.disposition === 'refused') {
    if (receipt.code && (REHEARSE_REFUSAL_CODES as readonly string[]).includes(receipt.code)
      || receipt.code === 'source-membership-invalid'
      || receipt.code === ANTHROPIC_PROOF_UNAVAILABLE
      || receipt.code === 'source-witness-unavailable'
      || receipt.code === 'proof-stale'
      || receipt.code === 'adoption-mismatch') {
      if (receipt.code) body.code = receipt.code;
    }
    return body;
  }
  body.membership = 'complete';
  body.count = receipt.count;
  body.aliases = receipt.aliases.map((alias) => alias);
  if (receipt.phase === 'rehearse') {
    body.buckets = receipt.buckets.map((bucket) => ({ '5h': bucket['5h'], '7d': bucket['7d'] }));
    body.adoption = receipt.adoption;
    body.initialActive = receipt.initialActive;
  }
  return body;
}

export function formatAnthropicReceipt(receipt: AnthropicReceipt, json: boolean): string {
  const body = anthropicReceiptBody(receipt);
  if (json) return JSON.stringify(body, null, 2);
  const lines = [
    `schema: ${body.schemaVersion}`,
    `phase: ${body.phase}`,
    `disposition: ${body.disposition}`,
  ];
  if (typeof body.code === 'string') lines.push(`code: ${body.code}`);
  if (body.membership === 'complete') lines.push('membership: complete');
  if (typeof body.count === 'number') lines.push(`count: ${body.count}`);
  if (Array.isArray(body.aliases)) lines.push(`aliases: ${body.aliases.join(',')}`);
  if (Array.isArray(body.buckets)) {
    const rendered = body.buckets.map((entry) => {
      const bucket = entry as ReceiptBuckets;
      return `5h=${bucket['5h']},7d=${bucket['7d']}`;
    });
    lines.push(`buckets: ${rendered.join(';')}`);
  }
  if (body.adoption === 'verified') lines.push('adoption: verified');
  if (typeof body.initialActive === 'string') lines.push(`initialActive: ${body.initialActive}`);
  return lines.join('\n');
}

function readUtf8(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Read pool text, journal detail, and the staging document. Does not create or update any of them. */
export function readAnthropicReceiptSources(
  poolFile: string,
  ownerFile: string,
  journalDetailJson: string | null | undefined,
): AnthropicReceiptSources {
  const ownerDocument = parseJson(readUtf8(ownerFile));
  return {
    poolText: readUtf8(poolFile),
    journalDetail: parseJson(journalDetailJson),
    stagingDocument: parseJson(readUtf8(stagingOwnerPath(join(dirname(ownerFile), 'qlb-owner.json')))),
    ownerDocument: canonicalOwnerEntry(ownerDocument)
      ? ownerDocument
      : parseJson(readUtf8(join(dirname(ownerFile), 'qlb-owner.json'))),
  };
}
