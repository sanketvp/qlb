// Compact 2-line QLB footer helpers. Keep this file free of Pi TUI imports so
// unit tests can load it without the coding-agent package graph.
//
// Line 1 = this session's most recently selected account + usage buckets.
// Line 2 = QLB_OWNED / native-sync health (doctor data is merged in by the
// caller on a slower timer — this module only formats and does cheap SQLite).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const ACCOUNT_COLORS = [46, 213, 208, 75]; // green, pink, orange, blue

export function accountFg(index: number, text: string): string {
  const len = ACCOUNT_COLORS.length;
  const code = ACCOUNT_COLORS[((index % len) + len) % len];
  return `\x1b[38;5;${code}m${text}\x1b[0m`;
}

export function accountColorIndex(accountId: string, orderedIds: string[] = []): number {
  const numbered = /^account-(\d+)$/.exec(accountId);
  if (numbered) return Math.max(0, Number(numbered[1]) - 1);
  const found = orderedIds.indexOf(accountId);
  return found >= 0 ? found : 0;
}

export function shortLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return label;
  return trimmed.split("@")[0] || trimmed;
}

export function formatPct(usedPct: number | null | undefined): string {
  if (usedPct == null || !Number.isFinite(usedPct)) return "—";
  return `${Math.round(usedPct)}%`;
}

const PREFERRED_BUCKETS = ["5h", "7d", "weekly", "credits", "requests"];

export interface UsageBucket {
  key: string;
  usedPct: number | null;
}

export function pickBuckets(buckets: UsageBucket[], limit = 2): UsageBucket[] {
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  const picked: UsageBucket[] = [];
  for (const key of PREFERRED_BUCKETS) {
    const hit = byKey.get(key);
    if (hit) picked.push(hit);
    if (picked.length >= limit) return picked;
  }
  for (const bucket of buckets) {
    if (picked.some((p) => p.key === bucket.key)) continue;
    picked.push(bucket);
    if (picked.length >= limit) break;
  }
  return picked;
}

export function formatUsage(buckets: UsageBucket[]): string {
  return pickBuckets(buckets)
    .map((b) => `${b.key} ${formatPct(b.usedPct)}`)
    .join(" · ");
}

export interface AccountFooterData {
  accountId: string;
  label: string;
  model: string;
  index: number;
  buckets: UsageBucket[];
}

export interface HealthFooterData {
  ownedStores: number;
  accountCount: number;
  nativeSyncPass: number;
  nativeSyncWarn: number;
  nativeSyncFail: number;
  overall: "PASS" | "WARN" | "FAIL" | "unknown";
  driftMessage?: string;
}

export const EMPTY_HEALTH: HealthFooterData = {
  ownedStores: 0,
  accountCount: 0,
  nativeSyncPass: 0,
  nativeSyncWarn: 0,
  nativeSyncFail: 0,
  overall: "unknown",
};

export function qlbDbPath(): string {
  if (process.env.QLB_DB_PATH) return process.env.QLB_DB_PATH;
  try {
    const raw = readFileSync(join(homedir(), ".qlb", "config.json"), "utf8");
    const parsed = JSON.parse(raw) as { dbPath?: unknown };
    if (typeof parsed.dbPath === "string" && parsed.dbPath.length > 0) {
      return parsed.dbPath;
    }
  } catch {
    // fall through to default
  }
  return join(homedir(), ".qlb", "qlb.db");
}

function withQlbDb<T>(fn: (db: DatabaseSync) => T, fallback: T): T {
  const path = qlbDbPath();
  if (!existsSync(path)) return fallback;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 200 });
    return fn(db);
  } catch {
    return fallback;
  } finally {
    try {
      db?.close();
    } catch {
      // already unusable
    }
  }
}

function fallbackAccount(
  lastDecision: { accountId?: string; model?: string } | null,
  currentModel?: string,
): AccountFooterData | null {
  if (!lastDecision?.accountId) return null;
  return {
    accountId: lastDecision.accountId,
    label: lastDecision.accountId,
    model: lastDecision.model || currentModel || "",
    index: accountColorIndex(lastDecision.accountId),
    buckets: [],
  };
}

export function readAccountFooterData(opts: {
  lastDecision: { accountId?: string; model?: string } | null;
  currentModel?: string;
}): AccountFooterData | null {
  try {
    const fromDb = withQlbDb((db) => {
      const fromDecision = opts.lastDecision?.accountId;
      let accountId = fromDecision;
      let model =
        opts.lastDecision?.model || opts.currentModel || "";
      if (!accountId) {
        const row = db
          .prepare(
            `SELECT account_id, requested_model, served_model
             FROM decisions
             WHERE harness = 'pi' AND account_id IS NOT NULL
             ORDER BY id DESC
             LIMIT 1`,
          )
          .get() as
          | {
              account_id?: string;
              requested_model?: string;
              served_model?: string;
            }
          | undefined;
        accountId = row?.account_id;
        if (!model) {
          model = row?.served_model || row?.requested_model || "";
        }
      }
      if (!accountId) return null;

      const accounts = db
        .prepare("SELECT id, label FROM accounts ORDER BY created_at ASC, id ASC")
        .all() as Array<{ id: string; label: string }>;
      const ids = accounts.map((a) => a.id);
      const match = accounts.find((a) => a.id === accountId);
      const snaps = db
        .prepare("SELECT bucket, used_pct FROM snapshots WHERE account_id = ?")
        .all(accountId) as Array<{ bucket: string; used_pct: number | null }>;

      return {
        accountId,
        label: match?.label || accountId,
        model: model || opts.currentModel || "",
        index: accountColorIndex(accountId, ids),
        buckets: snaps.map((s) => ({
          key: s.bucket,
          usedPct: s.used_pct,
        })),
      };
    }, null);
    return fromDb ?? fallbackAccount(opts.lastDecision, opts.currentModel);
  } catch {
    return fallbackAccount(opts.lastDecision, opts.currentModel);
  }
}

export function readCheapHealth(): HealthFooterData {
  try {
    return withQlbDb((db) => {
      const ownedRow = db
        .prepare(
          `SELECT COUNT(*) AS n FROM migrations
           WHERE state IN ('QLB_OWNED', 'RETIRED')`,
        )
        .get() as { n?: number } | undefined;
      const acctRow = db
        .prepare("SELECT COUNT(*) AS n FROM accounts")
        .get() as { n?: number } | undefined;
      return {
        ...EMPTY_HEALTH,
        ownedStores: Number(ownedRow?.n ?? 0),
        accountCount: Number(acctRow?.n ?? 0),
      };
    }, { ...EMPTY_HEALTH });
  } catch {
    return { ...EMPTY_HEALTH };
  }
}

export function parseDoctorJson(stdout: string): Pick<
  HealthFooterData,
  "nativeSyncPass" | "nativeSyncWarn" | "nativeSyncFail" | "overall" | "driftMessage"
> {
  const empty = {
    nativeSyncPass: 0,
    nativeSyncWarn: 0,
    nativeSyncFail: 0,
    overall: "unknown" as const,
    driftMessage: undefined as string | undefined,
  };
  try {
    const parsed = JSON.parse(stdout) as {
      overall?: unknown;
      checks?: Array<{ name?: unknown; level?: unknown; message?: unknown }>;
    };
    const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
    const sync = checks.filter(
      (c) => typeof c.name === "string" && c.name.startsWith("native-sync:"),
    );
    let nativeSyncPass = 0;
    let nativeSyncWarn = 0;
    let nativeSyncFail = 0;
    let driftMessage: string | undefined;
    for (const check of sync) {
      if (check.level === "FAIL") {
        nativeSyncFail += 1;
        if (!driftMessage && typeof check.message === "string") {
          driftMessage = check.message;
        }
      } else if (check.level === "WARN") {
        nativeSyncWarn += 1;
        if (!driftMessage && typeof check.message === "string") {
          driftMessage = check.message;
        }
      } else {
        nativeSyncPass += 1;
      }
    }
    const drift = nativeSyncWarn + nativeSyncFail;
    const overall: HealthFooterData["overall"] =
      nativeSyncFail > 0 ? "FAIL" : drift > 0 ? "WARN" : "PASS";
    return { nativeSyncPass, nativeSyncWarn, nativeSyncFail, overall, driftMessage };
  } catch {
    return empty;
  }
}

export function formatHealthText(health: HealthFooterData): {
  text: string;
  warn: boolean;
} {
  const owned = `${health.ownedStores} owned`;
  const accts = `${health.accountCount} accts`;
  const drift = health.nativeSyncWarn + health.nativeSyncFail;
  if (drift > 0) {
    return {
      text: `qlb · ${owned} · ${accts} · ${drift} drift`,
      warn: true,
    };
  }
  if (health.overall === "FAIL") {
    return { text: `qlb · ${owned} · ${accts} · FAIL`, warn: true };
  }
  if (health.overall === "PASS") {
    return { text: `qlb · ${owned} · ${accts} · sync ok`, warn: false };
  }
  return { text: `qlb · ${owned} · ${accts}`, warn: false };
}

function joinFitting(
  parts: string[],
  width: number,
  visible: (text: string) => number,
  sep = " · ",
): string {
  const present = parts.filter((p) => p.length > 0);
  while (present.length > 1 && visible(present.join(sep)) > width) {
    present.pop();
  }
  return present.join(sep);
}

export function buildFooterLines(opts: {
  width: number;
  account: AccountFooterData | null;
  health: HealthFooterData;
  model: string;
  paintAccount: (text: string) => string;
  paintDim: (text: string) => string;
  paintWarn: (text: string) => string;
  truncate: (text: string, width: number) => string;
  visible: (text: string) => number;
}): [string, string] {
  const width = Number.isFinite(opts.width) && opts.width > 0 ? Math.floor(opts.width) : 0;
  if (width <= 0) return ["", ""];

  const model = opts.model || opts.account?.model || "no-model";
  let line1: string;
  if (!opts.account) {
    line1 = joinFitting(
      [opts.paintDim("qlb"), opts.paintDim("no selection"), opts.paintDim(model)],
      width,
      opts.visible,
    );
  } else {
    const label = `★ ${shortLabel(opts.account.label)}`;
    const usage = formatUsage(opts.account.buckets);
    line1 = joinFitting(
      [
        opts.paintAccount(label),
        opts.paintDim(model),
        usage ? opts.paintAccount(usage) : "",
      ],
      width,
      opts.visible,
    );
  }

  const health = formatHealthText(opts.health);
  const painted = health.warn
    ? opts.paintWarn(health.text)
    : opts.paintDim(health.text);
  const line2 = joinFitting([painted], width, opts.visible);

  return [opts.truncate(line1, width), opts.truncate(line2, width)];
}
