// Journal evidence decoder for `qlb doctor` and `accounts prune`.
// Dependency leaf: imports ONLY ./journal-kinds. No filesystem, no writers.

import {
  KNOWN_STATES,
  NATIVE_RETIREMENT_STORES,
  PI_TRANSFER_STORES,
  SUPPORTED_SCHEMA_VERSIONS,
  type JournalKind,
  type KnownState,
} from './journal-kinds';

export type UntrustedReason =
  | 'unknown_store'
  | 'unknown_state'
  | 'state_not_allowed_for_kind'
  | 'missing_detail'
  | 'malformed_json'
  | 'not_object'
  | 'unsupported_version'
  | 'kind_mismatch'
  | `bad_shape:${string}`
  | 'missing_inventory'
  | 'empty_inventory'
  | 'bad_id'
  | 'bad_entry'
  | 'provider_conflict'
  | 'inventory_mismatch';

export type TrustedJournalEvidence = {
  trusted: true;
  kind: JournalKind;
  state: KnownState;
  participants: Set<string>;
  providers: Map<string, string>;
};

export type UntrustedJournalEvidence = {
  trusted: false;
  reason: UntrustedReason;
};

export type JournalEvidence = TrustedJournalEvidence | UntrustedJournalEvidence;

export type ParseAccountIdsResult =
  | { ok: true; ids: Set<string> }
  | { ok: false };

const PI_SET = new Set<string>(PI_TRANSFER_STORES);
const NATIVE_SET = new Set<string>(NATIVE_RETIREMENT_STORES);
const STATE_SET = new Set<string>(KNOWN_STATES);
const HEX64 = /^[0-9a-fA-F]{64}$/;

function kindForStore(store: string): JournalKind | null {
  if (PI_SET.has(store)) return 'pi-transfer';
  if (NATIVE_SET.has(store)) return 'native-retirement';
  return null;
}

function untrusted(reason: UntrustedReason): UntrustedJournalEvidence {
  return { trusted: false, reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsolutePath(value: string): boolean {
  if (value.length === 0) return false;
  if (value.startsWith('/')) return true;
  if (value.startsWith('\\\\')) return true;
  return /^[A-Za-z]:[\\/]/.test(value);
}

function readDetail(
  state: string,
  raw: string | null | undefined,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: UntrustedReason } {
  if (state === 'NATIVE' && (raw == null || raw === '' || raw === '{}')) {
    return { ok: true, value: {} };
  }
  if (raw == null || raw === '') {
    return { ok: false, reason: 'missing_detail' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'malformed_json' };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: 'not_object' };
  }
  return { ok: true, value: parsed };
}

function checkControlFields(
  detail: Record<string, unknown>,
  derivedKind: JournalKind,
): { ok: true } | { ok: false; reason: UntrustedReason } {
  if (Object.prototype.hasOwnProperty.call(detail, 'schemaVersion')) {
    const version = detail.schemaVersion;
    if (typeof version !== 'number' || !Number.isInteger(version) || !SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
      return { ok: false, reason: 'unsupported_version' };
    }
  }
  if (Object.prototype.hasOwnProperty.call(detail, 'kind')) {
    if (detail.kind !== derivedKind) {
      return { ok: false, reason: 'kind_mismatch' };
    }
  }
  return { ok: true };
}

function checkShape(
  kind: JournalKind,
  state: string,
  detail: Record<string, unknown>,
): { ok: true } | { ok: false; reason: UntrustedReason } {
  if (kind === 'native-retirement' && state === 'RETIRED') {
    if (typeof detail.retiredAt !== 'number' || !Number.isFinite(detail.retiredAt)) {
      return { ok: false, reason: 'bad_shape:retiredAt' };
    }
    for (const field of ['retiredPath', 'backupPath', 'sidecarPath'] as const) {
      const value = detail[field];
      if (typeof value !== 'string' || !isAbsolutePath(value)) {
        return { ok: false, reason: `bad_shape:${field}` };
      }
    }
    if (typeof detail.fingerprint !== 'string' || !HEX64.test(detail.fingerprint)) {
      return { ok: false, reason: 'bad_shape:fingerprint' };
    }
  }
  if (kind === 'native-retirement' && state === 'QLB_OWNED') {
    if (Object.prototype.hasOwnProperty.call(detail, 'committedAt')) {
      if (typeof detail.committedAt !== 'number' || !Number.isFinite(detail.committedAt)) {
        return { ok: false, reason: 'bad_shape:committedAt' };
      }
    }
  }
  if (kind === 'pi-transfer' && Object.prototype.hasOwnProperty.call(detail, 'ownerFilePath')) {
    if (typeof detail.ownerFilePath !== 'string' || detail.ownerFilePath.length === 0) {
      return { ok: false, reason: 'bad_shape:ownerFilePath' };
    }
  }
  return { ok: true };
}

function decodeInventory(
  detail: Record<string, unknown>,
  opts: { required: boolean; allowEmpty: boolean },
):
  | { ok: true; ids: Set<string>; providers: Map<string, string> }
  | { ok: false; reason: UntrustedReason } {
  const hasQlb = Object.prototype.hasOwnProperty.call(detail, 'qlbAccountIds');
  const hasAccounts = Object.prototype.hasOwnProperty.call(detail, 'accounts');
  if (opts.required && !hasQlb && !hasAccounts) {
    return { ok: false, reason: 'missing_inventory' };
  }

  const qlbIds: string[] = [];
  if (hasQlb) {
    if (!Array.isArray(detail.qlbAccountIds)) return { ok: false, reason: 'bad_id' };
    if (!opts.allowEmpty && detail.qlbAccountIds.length === 0) {
      return { ok: false, reason: 'empty_inventory' };
    }
    for (const id of detail.qlbAccountIds) {
      if (typeof id !== 'string' || id.length === 0) return { ok: false, reason: 'bad_id' };
      qlbIds.push(id);
    }
  }

  const accountEntries: Array<{ id: string; provider?: string }> = [];
  if (hasAccounts) {
    if (!Array.isArray(detail.accounts)) return { ok: false, reason: 'bad_entry' };
    if (!opts.allowEmpty && detail.accounts.length === 0) {
      return { ok: false, reason: 'empty_inventory' };
    }
    for (const entry of detail.accounts) {
      if (!isPlainObject(entry)) return { ok: false, reason: 'bad_entry' };
      const id = entry.id;
      if (typeof id !== 'string' || id.length === 0) return { ok: false, reason: 'bad_id' };
      let provider: string | undefined;
      if (Object.prototype.hasOwnProperty.call(entry, 'provider')) {
        if (typeof entry.provider !== 'string' || entry.provider.length === 0) {
          return { ok: false, reason: 'bad_entry' };
        }
        provider = entry.provider;
      }
      accountEntries.push(provider ? { id, provider } : { id });
    }
  }

  const explicit = new Map<string, string>();
  const recordProvider = (id: string, provider: string): UntrustedReason | null => {
    const prev = explicit.get(id);
    if (prev !== undefined && prev !== provider) return 'provider_conflict';
    explicit.set(id, provider);
    return null;
  };
  for (const entry of accountEntries) {
    if (entry.provider) {
      const conflict = recordProvider(entry.id, entry.provider);
      if (conflict) return { ok: false, reason: conflict };
    }
  }

  const qlbSet = new Set(qlbIds);
  const accountSet = new Set(accountEntries.map((entry) => entry.id));
  if (hasQlb && hasAccounts) {
    if (qlbSet.size !== accountSet.size) return { ok: false, reason: 'inventory_mismatch' };
    for (const id of qlbSet) {
      if (!accountSet.has(id)) return { ok: false, reason: 'inventory_mismatch' };
    }
  }

  const ids = new Set<string>([...qlbSet, ...accountSet]);
  return { ok: true, ids, providers: explicit };
}

export function decodeJournalEvidence(row: {
  store: string;
  state: string;
  detail_json?: string | null;
}): JournalEvidence {
  const kind = kindForStore(row.store);
  if (!kind) return untrusted('unknown_store');
  if (!STATE_SET.has(row.state)) return untrusted('unknown_state');
  const state = row.state as KnownState;
  if (kind === 'native-retirement' && (state === 'MIRRORED' || state === 'VALIDATED')) {
    return untrusted('state_not_allowed_for_kind');
  }
  const detail = readDetail(state, row.detail_json);
  if (!detail.ok) return untrusted(detail.reason);
  const ctl = checkControlFields(detail.value, kind);
  if (!ctl.ok) return untrusted(ctl.reason);
  const shape = checkShape(kind, state, detail.value);
  if (!shape.ok) return untrusted(shape.reason);
  const required = kind === 'pi-transfer' && state !== 'NATIVE';
  const inv = decodeInventory(detail.value, { required, allowEmpty: !required });
  if (!inv.ok) return untrusted(inv.reason);
  return {
    trusted: true,
    kind,
    state,
    participants: inv.ids,
    providers: inv.providers,
  };
}

/**
 * @deprecated Prefer decodeJournalEvidence. Thin wrapper that decodes a
 * pi-pool QLB_OWNED row from detail JSON only (existing test compatibility).
 */
export function parseAccountIds(detailJson: string | null | undefined): ParseAccountIdsResult {
  const ev = decodeJournalEvidence({
    store: 'pi-pool',
    state: 'QLB_OWNED',
    detail_json: detailJson,
  });
  if (!ev.trusted) return { ok: false };
  return { ok: true, ids: ev.participants };
}

/** Doctor WARN predicate: untrusted, or trusted MIRRORED/VALIDATED. */
export function isStuckMigration(migration: {
  store: string;
  state: string;
  detail_json?: string | null;
}): boolean {
  const ev = decodeJournalEvidence(migration);
  if (!ev.trusted) return true;
  return ev.state === 'MIRRORED' || ev.state === 'VALIDATED';
}

export function validatedAdvisoryMessage(store: string, accountCount: number): string {
  return (
    `${store}=VALIDATED — advisory: QLB holds imported grants for ${accountCount} account(s); ` +
    'pre-switch and completed rollback are not distinguished at this version; ' +
    'these accounts are prune-protected; see qlb migrate status'
  );
}

export function untrustedAdvisoryMessage(store: string, state: string, reason: UntrustedReason): string {
  return `${store}=${state} — journal evidence untrusted (${reason}); destructive maintenance refused`;
}
