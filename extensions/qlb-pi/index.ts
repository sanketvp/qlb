// qlb-pi — Pi extension that selects accounts via `qlb resolve` (§4.9.1 / §4.8.3a).
//
// Request-shaping is intentionally duplicated from anthropic-pool
// (request-shaping.ts / system-prompt-shaping.ts / constants.ts). A live
// 2026-09-08 verification showed that sending an OAuth token without that
// shaping is rejected as a third-party app (HTTP 400: "Third-party apps now
// draw from your extra usage"). This copy is kept because Pi's jiti loader
// loads each extension from its own directory; qlb-pi must not depend on
// anthropic-pool remaining installed.
//
// Verified live 2026-09-08 against a real Pi runtime: real Anthropic
// requests were sent through this extension's streamSimple/onPayload path
// and succeeded (HTTP 200, correct completions), and the audit log recorded
// accurate outcomes for those requests, after two bug fixes (request-shaping
// and audit-log accuracy — see repo history for details).
//
// The extension remains INERT by default. Activation is gated on
// ~/.pi/agent/qlb-owner.json (or QLB_PI_REHEARSAL=1); that file is only
// created by QLB's own `qlb migrate ... --confirm-real-cutover` flow. This
// means installing the package via `pi install` (which just registers the
// extension file per package.json's "pi" manifest) does NOT by itself
// activate anything, touch credentials, or affect anthropic-pool's
// registration — a separate, explicit migration step is required first.
//
// Known structural risk: for any account in QLB_OWNED state, the native
// provider's own credential store can drift out of sync with QLB's copy
// (native-credential-drift). This is mitigated by the native-resync
// mechanism added in src/native-resync.ts as of today, but the risk is
// structural to the QLB_OWNED model, not fully eliminated — see
// docs/CREDENTIAL-SAFETY.md.
//
// When active:
//   - unregisters the built-in anthropic provider (same hook anthropic-pool
//     uses at index.ts:55-60) and re-registers with a streamSimple that asks
//     `qlb resolve` for the account, injects that account's Keychain access
//     token, and applies anthropic-pool's OAuth payload shaping via onPayload;
//   - records each decision's outcome for audit (jsonl) from the real stream
//     events / HTTP status — never assumed "ok";
//   - adds `/qlb` (status / migrate status).
//
// QLB_PI_REHEARSAL=1  → force-active (forward rehearsal, S3), even with no owner file.
// QLB_PI_REHEARSAL=0  → force-inert (rollback verification, R3), even with an owner file.
// unset               → owner file decides.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamWithAuthRetry } from "./auth-retry.js";
import { classifyHttpStatus } from "./outcome.js";
import { shapeAnthropicOAuthPayload } from "./request-shaping.js";

const OWNER_FILE = join(homedir(), ".pi", "agent", "qlb-owner.json");
const AUDIT_DIR = join(homedir(), ".qlb");
const AUDIT_FILE = join(AUDIT_DIR, "outcomes.jsonl");

function shouldActivate(): boolean {
  const rehearsal = process.env.QLB_PI_REHEARSAL;
  if (rehearsal === "0") return false;
  if (rehearsal === "1") return true;
  return existsSync(OWNER_FILE);
}

function findQlbCli(): { cmd: string; prefix: string[] } {
  if (process.env.QLB_CLI) {
    return { cmd: process.execPath, prefix: [process.env.QLB_CLI] };
  }
  const repoCli = join(__dirname, "..", "..", "dist", "cli.js");
  if (existsSync(repoCli)) {
    return { cmd: process.execPath, prefix: [repoCli] };
  }
  return { cmd: "qlb", prefix: [] };
}

function runQlb(
  args: string[],
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const { cmd, prefix } = findQlbCli();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...prefix, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`qlb ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

interface ResolveOk {
  decisionId?: number;
  provider?: string;
  accountId?: string;
  model?: string;
  reason?: string;
  mode?: string;
}

async function qlbResolve(model: string, effort?: string): Promise<ResolveOk> {
  const args = ["resolve", "--model", model, "--json", "--harness", "pi"];
  if (effort) args.push("--effort", effort);
  const result = await runQlb(args);
  if (result.code !== 0) {
    throw new Error(
      `qlb resolve failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    );
  }
  return JSON.parse(result.stdout) as ResolveOk;
}

async function qlbNativeResync(
  provider: string,
  accountId: string,
): Promise<{ resynced: boolean; reason: string }> {
  try {
    const result = await runQlb(
      ["native-resync", "--provider", provider, "--account", accountId, "--json"],
    );
    if (result.code !== 0) {
      return {
        resynced: false,
        reason: result.stderr || result.stdout || `exit ${result.code}`,
      };
    }
    const parsed = JSON.parse(result.stdout) as { resynced?: unknown; reason?: unknown };
    return {
      resynced: parsed.resynced === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "native-resync",
    };
  } catch (err) {
    return {
      resynced: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function recordOutcome(entry: Record<string, unknown>): void {
  try {
    if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: Date.now(), ...entry }) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (err) {
    console.error("[qlb-pi] failed to record outcome:", err);
  }
}

function readKeychainGrant(
  provider: string,
  accountId: string,
  label: string,
): { access: string } {
  const service = `qlb:${provider}:${accountId}`;
  const stdout = execFileSync(
    "security",
    ["find-generic-password", "-a", label || accountId, "-s", service, "-w"],
    { encoding: "utf8" },
  );
  const grant = JSON.parse(stdout.replace(/\n$/, "")) as { access?: string };
  if (!grant.access) throw new Error(`qlb-pi: empty access token for ${service}`);
  return { access: grant.access };
}

function ownerAccountLabel(accountId: string): string {
  try {
    const owner = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as {
      accounts?: Array<{ id: string; label?: string }>;
    };
    return owner.accounts?.find((a) => a.id === accountId)?.label || accountId;
  } catch {
    return accountId;
  }
}

type StreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AsyncIterable<unknown>;

async function resolveBuiltinAnthropicStreamSimple(): Promise<StreamSimple> {
  const namespace = (await import("@earendil-works/pi-ai/compat")) as {
    anthropicMessagesApi?: () => { streamSimple?: StreamSimple };
  };
  const streamSimple = namespace.anthropicMessagesApi?.()?.streamSimple;
  if (typeof streamSimple !== "function") {
    throw new Error(
      "qlb-pi: @earendil-works/pi-ai/compat exported no anthropicMessagesApi().streamSimple",
    );
  }
  return streamSimple;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  if (!shouldActivate()) {
    // Inert: QLB does not own Pi yet. anthropic-pool keeps the anthropic provider.
    return;
  }

  let lastDecision: ResolveOk | null = null;
  let builtin: StreamSimple;
  try {
    builtin = await resolveBuiltinAnthropicStreamSimple();
  } catch (err) {
    console.error("[qlb-pi] could not resolve builtin anthropic transport:", err);
    return;
  }

  pi.unregisterProvider("anthropic");
  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    streamSimple: (model, context, options) => {
      const output = createAssistantMessageEventStream();
      void (async () => {
        try {
          const decision = await qlbResolve(model.id);
          lastDecision = decision;
          if (!decision.accountId) {
            throw new Error("qlb resolve returned no accountId");
          }
          const provider = decision.provider || "anthropic";
          const label = ownerAccountLabel(decision.accountId);
          const callerOnPayload = options?.onPayload;
          const onPayload: SimpleStreamOptions["onPayload"] = async (
            payload: unknown,
            payloadModel: unknown,
          ) => {
            const upstream = callerOnPayload
              ? ((await callerOnPayload(payload, payloadModel as Model<Api>)) ??
                payload)
              : payload;
            return shapeAnthropicOAuthPayload(upstream);
          };
          const result = await streamWithAuthRetry({
            readAccess: () =>
              readKeychainGrant(provider, decision.accountId!, label).access,
            startStream: (access) =>
              builtin(model, context, {
                ...options,
                apiKey: access,
                onPayload,
              }),
            resync: () => qlbNativeResync(provider, decision.accountId!),
            onEvent: (event) => {
              output.push(event as never);
            },
            onResync: (resync) => {
              recordOutcome({
                kind: "native_resync",
                decisionId: decision.decisionId,
                accountId: decision.accountId,
                provider,
                model: model.id,
                resynced: resync.resynced,
                reason: resync.reason,
              });
            },
          });
          recordOutcome({
            decisionId: decision.decisionId,
            accountId: decision.accountId,
            model: model.id,
            outcome: result.outcome,
            ...(result.outcome === "failed" && result.error
              ? { error: result.error }
              : {}),
            ...(result.retried ? { retriedAfterNativeResync: true } : {}),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          recordOutcome({
            decisionId: lastDecision?.decisionId,
            accountId: lastDecision?.accountId,
            model: model.id,
            outcome: "failed",
            error: message,
          });
          output.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "error",
              errorMessage: message,
              timestamp: Date.now(),
            },
          });
        } finally {
          output.end();
        }
      })();
      return output;
    },
  });

  pi.on("after_provider_response", (event) => {
    const status = (event as { status?: unknown }).status;
    recordOutcome({
      kind: "after_provider_response",
      decisionId: lastDecision?.decisionId,
      accountId: lastDecision?.accountId,
      model: lastDecision?.model,
      provider: lastDecision?.provider,
      status,
      outcome: classifyHttpStatus(status),
    });
  });

  pi.registerCommand("qlb", {
    description: "QLB status / migrate status (read-only). Subcommands: status, migrate",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub] = args.trim().split(/\s+/);
      try {
        const argv = sub === "migrate" ? ["migrate", "status", "--json"] : ["status", "--json"];
        const result = await runQlb(argv);
        ctx.ui.notify(
          result.stdout || result.stderr || "(no output)",
          result.code === 0 ? "info" : "error",
        );
      } catch (err) {
        ctx.ui.notify(
          `qlb command failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("qlb", "qlb-pi active");
  });
}
