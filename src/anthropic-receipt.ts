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
import { assessAnthropicForwardAdmission } from './anthropic-forward-admission';
import { identityMismatchRefusal, identityProofBuckets } from './anthropic-rehearsal-proof';
import { distinctAnthropicStageAccounts, stagingOwnerPath } from './migration';

export const RECEIPT_SCHEMA_VERSION = 1;

export const RECEIPT_PHASES = ['stage', 'rehearse', 'commit', 'failure'] as const;

export type AnthropicReceiptPhase = (typeof RECEIPT_PHASES)[number];

/** Codes this slice can put on a receipt. Later slices add the other fixed public codes. */
export type AnthropicReceiptCode =
  | 'source-membership-invalid'
  | 'proof-unavailable'
  | 'identity-mismatch'
  | 'source-witness-unavailable'
  | 'proof-stale';

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

export function isReceiptPhase(value: string | undefined): value is AnthropicReceiptPhase {
  return !!value && (RECEIPT_PHASES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    if (buckets) {
      return {
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        phase: 'rehearse',
        disposition: 'success',
        membership: 'complete',
        count: journal.memberCount,
        aliases: journal.aliases.slice(),
        buckets,
      };
    }
    if (identityMismatchRefusal(sources.journalDetail)) {
      return { schemaVersion: RECEIPT_SCHEMA_VERSION, phase, disposition: 'refused', code: 'identity-mismatch' };
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
    now: Date.now(),
  };
}

/** Allowlisted object. Callers serialize this value and never a journal or staging document. */
export function anthropicReceiptBody(receipt: AnthropicReceipt): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    phase: receipt.phase,
    disposition: receipt.disposition,
  };
  if (receipt.disposition === 'refused') {
    if (
      receipt.code === 'source-membership-invalid'
      || receipt.code === ANTHROPIC_PROOF_UNAVAILABLE
      || receipt.code === 'identity-mismatch'
      || receipt.code === 'source-witness-unavailable'
      || receipt.code === 'proof-stale'
    ) body.code = receipt.code;
    return body;
  }
  body.membership = 'complete';
  body.count = receipt.count;
  body.aliases = receipt.aliases.map((alias) => alias);
  if (receipt.phase === 'rehearse') {
    body.buckets = receipt.buckets.map((bucket) => ({ '5h': bucket['5h'], '7d': bucket['7d'] }));
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
