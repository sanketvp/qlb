// Read-only planning for the Claude C-swap hand-back. Credential bytes remain
// inside injected readers; plans expose only refresh-token fingerprint prefixes.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { credentialFingerprint } from './anthropic-oauth';
import type { ClaudeSlotBackend } from './cc-slots';
import { isCredentialNotFound } from './credential-backends';

const FINGERPRINT_PREFIX_LENGTH = 'sha256:'.length + 12;

export interface HandBackSlot {
  accountId: string;
  slotNum: number | null;
  email: string | null;
  fingerprint: string | null;
  source: string | null;
}

export type HandBackAction = 'update' | 'noop';

export interface HandBackSlotPlan {
  accountId: string;
  accountNumber: number;
  email: string;
  item: string;
  action: HandBackAction;
  fingerprint: string;
}

export interface HandBackPlan {
  slots: HandBackSlotPlan[];
  deleteEnc: string[];
  activeAccountNumber: number | null;
}

export interface PlanHandBackDependencies {
  slots: () => HandBackSlot[];
  activeAccountId: () => string | null;
  migratedPiProviders: () => string[];
  backupDir: string;
  keychain: Pick<ClaudeSlotBackend, 'get'>;
  encExists?: (path: string) => boolean;
}

export class CswapUndoRefusalError extends Error {
  constructor(
    readonly code: 'qlb-add-slot' | 'pi-migrated' | 'active-slot-missing',
    readonly provider?: string,
  ) {
    super(code);
    this.name = 'CswapUndoRefusalError';
  }
}

function requireSlotCoordinate(slot: HandBackSlot): { accountNumber: number; email: string } {
  if (!Number.isSafeInteger(slot.slotNum) || slot.slotNum == null || slot.slotNum < 1 || !slot.email || /[\\/\0:]/.test(slot.email)) {
    throw new Error('Claude hand-back slot coordinates are invalid');
  }
  return { accountNumber: slot.slotNum, email: slot.email };
}

function credentialLineage(credential: string, accountNumber: number): string {
  const value = credentialFingerprint(credential);
  if (!value) throw new Error(`Claude hand-back credential is invalid for slot ${accountNumber}`);
  return value;
}

function slotLineage(slot: HandBackSlot, accountNumber: number): string {
  if (!slot.fingerprint || !/^sha256(?:-full)?:[0-9a-f]{64}$/.test(slot.fingerprint)) {
    throw new Error(`Claude hand-back lineage is invalid for slot ${accountNumber}`);
  }
  return slot.fingerprint;
}

function fingerprintPrefix(value: string): string {
  return value.slice(0, FINGERPRINT_PREFIX_LENGTH);
}

async function optionalCswapCredential(
  keychain: Pick<ClaudeSlotBackend, 'get'>,
  item: string,
): Promise<string | null> {
  try {
    return await keychain.get('claude-swap', item);
  } catch (error) {
    if (isCredentialNotFound(error)) return null;
    throw error;
  }
}

/**
 * Builds the read-only G16 hand-back plan. `update` means C-swap does not
 * currently hold the slot's persisted refresh-token lineage; access-token-only
 * changes remain a `noop` because `credentialFingerprint` hashes the refresh token.
 */
export async function planHandBack(deps: PlanHandBackDependencies): Promise<HandBackPlan> {
  const allSlots = deps.slots();
  const slots = allSlots.filter((slot) => slot.source !== 'qlb-add');
  const qlbAdd = allSlots.find((slot) => slot.source === 'qlb-add');
  if (qlbAdd) throw new CswapUndoRefusalError('qlb-add-slot');

  const migrated = deps.migratedPiProviders().sort();
  if (migrated.length > 0) throw new CswapUndoRefusalError('pi-migrated', migrated[0]);

  const activeAccountId = deps.activeAccountId();
  const active = activeAccountId === null ? null : slots.find((slot) => slot.accountId === activeAccountId);
  if ((slots.length > 0 && activeAccountId === null) || (activeAccountId !== null && !active)) {
    throw new CswapUndoRefusalError('active-slot-missing');
  }

  const encExists = deps.encExists ?? existsSync;
  const plans: HandBackSlotPlan[] = [];
  const deleteEnc: string[] = [];
  for (const slot of [...slots].sort((left, right) => (left.slotNum ?? Number.MAX_SAFE_INTEGER) - (right.slotNum ?? Number.MAX_SAFE_INTEGER))) {
    const { accountNumber, email } = requireSlotCoordinate(slot);
    const item = `account-${accountNumber}-${email}`;
    const sourceFingerprint = slotLineage(slot, accountNumber);
    const destination = await optionalCswapCredential(deps.keychain, item);
    const action: HandBackAction = destination !== null && credentialLineage(destination, accountNumber) === sourceFingerprint
      ? 'noop'
      : 'update';
    plans.push({
      accountId: slot.accountId,
      accountNumber,
      email,
      item,
      action,
      fingerprint: fingerprintPrefix(sourceFingerprint),
    });
    const enc = join(deps.backupDir, 'credentials', `.creds-${accountNumber}-${email}.enc`);
    if (encExists(enc)) deleteEnc.push(enc);
  }

  return {
    slots: plans,
    deleteEnc,
    activeAccountNumber: active == null ? null : requireSlotCoordinate(active).accountNumber,
  };
}
