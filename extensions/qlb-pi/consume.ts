// Consume Option B for Pi: serve cswap's currently-active Claude Code access as
// the unattributed `cswap-active` identity. Read-only Keychain GET only — never
// refreshes, never writes, never binds a QLB account slot.
//
// The reader duplicates src/cswap-native-read.ts (same allowlisted argv, same
// parse and expiry rules) because Pi's jiti loader cannot import from QLB's src/
// tree. test/qlb-pi-consume.test.ts pins the two copies to identical behavior.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";

export const CSWAP_ACTIVE_ID = "cswap-active";
export const ACTIVE_CC_SERVICE = "Claude Code-credentials";
export const SECURITY_BIN = "/usr/bin/security";
const FALLBACK_ACCOUNT = "claude-code-user";

// Stable, value-free messages for every consume failure sink (audit, Pi error
// event, console). Raw diagnostics never cross these boundaries.
export const CONSUME_ERRORS = {
  unreadable: "cswap-active credential unavailable (Claude Code login unreadable)",
  expired: "cswap-active credential expired; switch or re-login in Claude Code/cswap",
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

export type SecurityRunner = (executable: string, args: readonly string[]) => string;

export interface ActiveAccess {
  access: string;
  fingerprint: string;
}

export function fingerprintAccess(access: string): string {
  return createHash("sha256").update(access, "utf8").digest("hex");
}

export function activeKeychainAccount(env: NodeJS.ProcessEnv = process.env): string {
  if (typeof env.USER === "string" && env.USER.length > 0) return env.USER;
  try {
    const name = userInfo().username;
    if (typeof name === "string" && name.length > 0) return name;
  } catch {
    // fall through
  }
  return FALLBACK_ACCOUNT;
}

export function activeCcSecurityArgs(account: string): string[] {
  return ["find-generic-password", "-a", account, "-w", "-s", ACTIVE_CC_SERVICE];
}

function defaultRunner(executable: string, args: readonly string[]): string {
  return execFileSync(executable, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Read-only GET of the active Claude Code login; returns only the access token. */
export function readActiveClaudeAccess(opts: {
  runner?: SecurityRunner;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
} = {}): ActiveAccess {
  const runner = opts.runner ?? defaultRunner;
  let raw: string;
  try {
    raw = String(runner(SECURITY_BIN, activeCcSecurityArgs(activeKeychainAccount(opts.env))));
  } catch {
    throw new Error(CONSUME_ERRORS.unreadable);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/\n$/, ""));
  } catch {
    throw new Error(CONSUME_ERRORS.unreadable);
  }
  const oauth = asRecord(asRecord(parsed)?.claudeAiOauth);
  const access = oauth?.accessToken;
  const expiresAt = oauth?.expiresAt;
  if (typeof access !== "string" || access.length === 0) {
    throw new Error(CONSUME_ERRORS.unreadable);
  }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new Error(CONSUME_ERRORS.unreadable);
  }
  if (expiresAt < (opts.nowMs ?? Date.now())) {
    throw new Error(CONSUME_ERRORS.expired);
  }
  return { access, fingerprint: fingerprintAccess(access) };
}

export type OwnerFileState = "absent" | "valid" | "malformed";
export type ConsumeJournal = "CONSUMED" | "NATIVE" | "unknown";
export type PiMode = "inert" | "owned" | "consume" | "conflict";

export function readOwnerFileState(path: string): OwnerFileState {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "malformed";
  }
  try {
    return asRecord(JSON.parse(text)) ? "valid" : "malformed";
  } catch {
    return "malformed";
  }
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
  journal: ConsumeJournal;
  /** `~/.qlb/consume-anthropic.json` exists (written by `qlb consume enable`). */
  marker: boolean;
}

/**
 * Choose how qlb-pi registers Anthropic at load. Fail-closed rules:
 * - QLB_PI_REHEARSAL=0 always inert (rollback verification).
 * - Any claim of QLB ownership (owner file, even malformed, or rehearsal=1)
 *   is `owned` only when the consume journal is provably NATIVE; CONSUMED or an
 *   unreadable journal alongside ownership is `conflict`.
 * - No ownership claim: CONSUMED → `consume`; the consume marker present with
 *   any other journal (unreadable, or NATIVE mid-enable/disable) → `conflict`
 *   (never hand Anthropic back to a pool that refreshes its own copies);
 *   otherwise inert (nothing taken over).
 */
export function decidePiMode(input: PiModeInput): PiMode {
  if (input.rehearsal === "0") return "inert";
  const claimsOwnership = input.rehearsal === "1" || input.owner !== "absent";
  if (claimsOwnership) {
    if (input.owner === "malformed") return "conflict";
    return input.journal === "NATIVE" ? "owned" : "conflict";
  }
  if (input.journal === "CONSUMED") return "consume";
  return input.marker ? "conflict" : "inert";
}

/** User-facing reason for a `conflict` decision. */
export function conflictMessage(input: PiModeInput): string {
  if (input.journal === "unknown") return CONSUME_ERRORS.stateUnknown;
  const claimsOwnership = input.rehearsal === "1" || input.owner !== "absent";
  return claimsOwnership ? CONSUME_ERRORS.conflict : CONSUME_ERRORS.stateInconsistent;
}

/**
 * Adapter for streamWithAuthRetry: at most two reads per request. The first
 * stream uses read #1; a 401 triggers exactly one reread, and the retry sends
 * exactly that reread value — only if its fingerprint changed.
 */
export function consumeAccessSource(read: () => ActiveAccess): {
  readAccess: () => string;
  resync: () => Promise<{ resynced: boolean; reason: string }>;
  sent: () => string[];
} {
  let current: ActiveAccess | undefined;
  const sent: string[] = [];
  return {
    readAccess: () => {
      current ??= read();
      sent.push(current.access);
      return current.access;
    },
    resync: async () => {
      let next: ActiveAccess;
      try {
        next = read();
      } catch {
        return { resynced: false, reason: "cswap-active reread failed" };
      }
      if (current && next.fingerprint === current.fingerprint) {
        return { resynced: false, reason: "cswap-active access fingerprint unchanged" };
      }
      current = next;
      return { resynced: true, reason: "cswap-active access fingerprint changed" };
    },
    sent: () => [...sent],
  };
}

/** Replace every known access value and its fingerprint with a placeholder. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[redacted]").split(fingerprintAccess(secret)).join("[redacted]");
  }
  return out;
}

/**
 * Independent deep copy of a Pi stream event with every string redacted (any
 * shape: arrays, message.*, bare strings, shared or cyclic references).
 * Fails closed: anything nested beyond MAX_REDACT_DEPTH becomes "[redacted]".
 */
const MAX_REDACT_DEPTH = 64;
export function redactEvent(event: unknown, secrets: readonly string[]): unknown {
  if (secrets.length === 0) return event;
  const clones = new WeakMap<object, unknown>();
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return redactSecrets(value, secrets);
    if (!value || typeof value !== "object") return value;
    if (depth > MAX_REDACT_DEPTH) return "[redacted]";
    const existing = clones.get(value);
    if (existing !== undefined) return existing;
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      clones.set(value, out);
      for (const item of value) out.push(walk(item, depth + 1));
      return out;
    }
    const out: Record<string, unknown> = {};
    clones.set(value, out);
    for (const [key, item] of Object.entries(value)) out[key] = walk(item, depth + 1);
    return out;
  };
  return walk(event, 0);
}
