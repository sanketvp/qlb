// Data-only allow-lists for journal decoding. No imports.
// Drift-tested against writer constants after full module init.

export const PI_TRANSFER_STORES = [
  'pi-pool',
  'pi-openai-codex',
  'pi-xai',
  'pi-kimi-coding',
  'pi-openrouter',
] as const;

export const NATIVE_RETIREMENT_STORES = ['claude-code', 'codex-cli'] as const;

export const KNOWN_STATES = ['NATIVE', 'MIRRORED', 'VALIDATED', 'QLB_OWNED', 'RETIRED'] as const;

/** Absent schemaVersion = supported legacy. No writer emits a version yet. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [];

export type PiTransferStore = (typeof PI_TRANSFER_STORES)[number];
export type NativeRetirementStore = (typeof NATIVE_RETIREMENT_STORES)[number];
export type KnownState = (typeof KNOWN_STATES)[number];
export type JournalKind = 'pi-transfer' | 'native-retirement';
