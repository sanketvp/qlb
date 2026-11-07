// Consume Option B for Pi replaces Anthropic with an unavailable provider when
// the cache cannot establish provider-attributable capacity.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isPiProvider, type PiProvider } from "./active-access.js";

export const CSWAP_ACTIVE_ID = "cswap-active";

// Shared redaction is intentionally imported from src/: in a package install it
// resolves within QLB, and in a copied install pi:extension supplies agent/src/redact.ts.
// The closure test pins this as the extension's sole src dependency.
export { redactEvent, redactSecrets } from "../../src/redact.js";

// Stable, value-free messages for every consume failure sink (audit, Pi error
// event, console). Raw diagnostics never cross these boundaries.
export const CONSUME_ERRORS = {
  quotaUnavailable:
    "QLB Anthropic consume unavailable: no fresh provider-attributable quota reading",
  disabled:
    "QLB cswap consume is no longer enabled; restart Pi to return to its own Anthropic provider",
  conflict:
    "QLB ownership conflict: Pi's Anthropic accounts are QLB-owned (or unknown) while cswap consume is enabled. " +
    "Run `qlb consume disable --provider anthropic` or `qlb migrate rollback --provider anthropic`, then restart Pi.",
  stateUnknown:
    "QLB could not read its consume state (`qlb consume status` failed or timed out); Anthropic is disabled " +
    "rather than risk the wrong account. Check that `qlb` runs from Pi's environment, then restart Pi.",
  stateInconsistent:
    "QLB consume state is mid-change or inconsistent (consume marker present but consume not enabled). " +
    "Re-run `qlb consume enable --provider anthropic` or `qlb consume disable --provider anthropic`, then restart Pi.",
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Where `qlb consume enable` writes its marker: beside the QLB database, resolved
 * exactly as src/config.ts resolveConfig does from the environment and config
 * file (QLB_DB_PATH, then config.json `dbPath`, then ~/.qlb/qlb.db). Pi cannot
 * see per-invocation CLI flags; test/qlb-pi-consume.test.ts pins the parity.
 */
export function qlbDbPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const expand = (value: string): string => {
    if (value === "~") return home;
    if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
    return isAbsolute(value) ? value : resolve(value);
  };
  const defaultDb = join(home, ".qlb", "qlb.db");
  const configPath = expand(env.QLB_CONFIG_PATH ?? join(home, ".qlb", "config.json"));
  let fileDb: unknown;
  if (existsSync(configPath)) {
    try {
      fileDb = asRecord(JSON.parse(readFileSync(configPath, "utf8")))?.dbPath;
    } catch {
      fileDb = undefined; // the CLI ignores an invalid config file too
    }
  }
  const raw = env.QLB_DB_PATH ?? fileDb ?? defaultDb;
  return typeof raw === "string" && raw.length > 0 ? expand(raw) : defaultDb;
}

/** Marker beside the QLB database (see qlbDbPath). */
export function consumeMarkerPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(dirname(qlbDbPath(env, home)), "consume-anthropic.json");
}

export type OwnerFileState = "absent" | "valid" | "malformed";
export type ConsumeJournal = "CONSUMED" | "NATIVE" | "unknown";
export type PiMode = "inert" | "owned" | "consume" | "conflict";

export interface PiOwnerProvider {
  mode: "qlb";
  since: number;
}

/**
 * v1 was a single Anthropic owner document. v2 scopes ownership to named
 * providers so an unmigrated Pi provider always remains untouched.
 */
export type PiOwnerFile =
  | { kind: "absent" }
  | { kind: "malformed" }
  | { kind: "v1" }
  | { kind: "v2"; providers: Partial<Record<PiProvider, PiOwnerProvider>> };

function parsePiOwnerRecord(value: unknown): PiOwnerFile {
  const record = asRecord(value);
  if (!record) return { kind: "malformed" };
  if (!("providers" in record)) return { kind: "v1" };
  const rawProviders = asRecord(record.providers);
  if (!rawProviders) return { kind: "malformed" };
  const providers: Partial<Record<PiProvider, PiOwnerProvider>> = {};
  for (const [name, entry] of Object.entries(rawProviders)) {
    if (!isPiProvider(name)) return { kind: "malformed" };
    const config = asRecord(entry);
    if (
      !config ||
      config.mode !== "qlb" ||
      typeof config.since !== "number" ||
      !Number.isFinite(config.since) ||
      config.since < 0
    ) {
      return { kind: "malformed" };
    }
    providers[name] = { mode: "qlb", since: config.since };
  }
  return { kind: "v2", providers };
}

/** Parse a v1/v2 owner document without exposing its raw contents to callers. */
export function parsePiOwnerFile(text: string): PiOwnerFile {
  try {
    return parsePiOwnerRecord(JSON.parse(text));
  } catch {
    return { kind: "malformed" };
  }
}

/** Read an owner document; ENOENT is the sole non-error absence state. */
export function readPiOwnerFile(path: string): PiOwnerFile {
  try {
    return parsePiOwnerFile(readFileSync(path, "utf8"));
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "malformed" };
  }
}

/** Return the ownership state for exactly one provider. */
export function ownerStateForProvider(owner: PiOwnerFile, provider: PiProvider): OwnerFileState {
  if (owner.kind === "absent") return "absent";
  if (owner.kind === "malformed") return "malformed";
  if (owner.kind === "v1") return provider === "anthropic" ? "valid" : "absent";
  return owner.providers[provider] ? "valid" : "absent";
}

/** Legacy Anthropic helper retained for the existing consume path. */
export function readOwnerFileState(path: string): OwnerFileState {
  return ownerStateForProvider(readPiOwnerFile(path), "anthropic");
}

/** Parse `qlb consume status --provider anthropic --json`. Anything unexpected is `unknown`. */
export function parseConsumeStatus(code: number, stdout: string): ConsumeJournal {
  if (code !== 0) return "unknown";
  try {
    const state = asRecord(JSON.parse(stdout))?.state;
    if (state === "CONSUMED") return "CONSUMED";
    if (state === "NATIVE") return "NATIVE";
  } catch {
    // fall through
  }
  return "unknown";
}

export interface PiModeInput {
  rehearsal: string | undefined;
  owner: OwnerFileState;
  /** Only Anthropic's legacy cswap consume mode needs this journal. */
  journal?: ConsumeJournal;
  /** The consume marker (consumeMarkerPath) exists — written by `qlb consume enable`. */
  marker?: boolean;
}

/**
 * Choose how qlb-pi registers Anthropic at load. Fail-closed rules:
 * - QLB_PI_REHEARSAL=0 always inert (rollback verification).
 * - Any claim of QLB ownership (owner file, even malformed, or Anthropic rehearsal=1)
 *   is `owned` only when the consume journal is provably NATIVE; CONSUMED or an
 *   unreadable journal alongside ownership is `conflict`.
 * - No ownership claim: CONSUMED → `consume`; the consume marker present with
 *   any other journal (unreadable, or NATIVE mid-enable/disable) → `conflict`
 *   (never hand Anthropic back to a pool that refreshes its own copies);
 *   otherwise inert (nothing taken over).
 */
export function decidePiMode(input: PiModeInput): PiMode;
export function decidePiMode(provider: PiProvider, input: PiModeInput): PiMode;
export function decidePiMode(
  providerOrInput: PiProvider | PiModeInput,
  maybeInput?: PiModeInput,
): PiMode {
  // The one-argument form preserves the original Anthropic consume boundary.
  const provider = typeof providerOrInput === "string" ? providerOrInput : "anthropic";
  const input = typeof providerOrInput === "string" ? maybeInput! : providerOrInput;
  if (input.rehearsal === "0") return "inert";
  if (input.owner === "malformed") return "conflict";
  // Rehearsal is Anthropic-only until later provider slices opt in.
  const claimsOwnership = input.owner === "valid" || (provider === "anthropic" && input.rehearsal === "1");

  // v2 providers have no cswap consume fallback. A provider omitted from the
  // owner document must leave Pi's own login completely untouched.
  if (provider !== "anthropic") return claimsOwnership ? "owned" : "inert";

  const journal = input.journal ?? "unknown";
  if (claimsOwnership) return journal === "NATIVE" ? "owned" : "conflict";
  if (journal === "CONSUMED") return "consume";
  return input.marker ? "conflict" : "inert";
}

/**
 * Startup fast path for machines where QLB was never used: with no rehearsal, no
 * owner file, no consume marker AND no QLB database, the journal cannot be CONSUMED
 * (that state lives in the database), so the `qlb consume status` spawn is skipped.
 * Whenever the database exists the journal is always consulted, so a missing marker
 * can never hide a CONSUMED journal.
 */
export function canSkipJournal(input: Omit<PiModeInput, "journal"> & { dbExists: boolean }): boolean {
  return input.rehearsal !== "0" && input.rehearsal !== "1" && input.owner === "absent"
    && !input.marker && !input.dbExists;
}

/** User-facing reason for a `conflict` decision. */
// TODO(P2): make this provider-aware before any v2 provider uses this remediation text.
export function conflictMessage(input: PiModeInput): string {
  if (input.owner === "malformed") return CONSUME_ERRORS.conflict; // the owner file is the problem
  if ((input.journal ?? "unknown") === "unknown") return CONSUME_ERRORS.stateUnknown;
  const claimsOwnership = input.rehearsal === "1" || input.owner !== "absent";
  return claimsOwnership ? CONSUME_ERRORS.conflict : CONSUME_ERRORS.stateInconsistent;
}
