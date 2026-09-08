// qlb-pi — Pi extension that selects accounts via `qlb resolve` (§4.9.1 / §4.8.3a).
//
// UNTESTED against a live Pi runtime. Do NOT install this into
// ~/.pi/agent/extensions/ until you have manually verified it in a throwaway
// Pi session. Activation is gated on ~/.pi/agent/qlb-owner.json (or
// QLB_PI_REHEARSAL=1); without that marker the extension is inert, so even a
// premature copy into the extensions dir cannot steal anthropic-pool's
// registration. Copy/symlink is an explicit, deliberate user step — this
// repo never writes into ~/.pi/agent/extensions/.
//
// When active:
//   - unregisters the built-in anthropic provider (same hook anthropic-pool
//     uses at index.ts:55-60) and re-registers with a streamSimple that asks
//     `qlb resolve` for the account, then injects that account's Keychain
//     access token into the builtin Anthropic transport;
//   - records each decision's outcome for audit (jsonl);
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
          const label = ownerAccountLabel(decision.accountId);
          const { access } = readKeychainGrant(
            decision.provider || "anthropic",
            decision.accountId,
            label,
          );
          const stream = builtin(model, context, { ...options, apiKey: access });
          for await (const event of stream) {
            output.push(event as never);
          }
          recordOutcome({
            decisionId: decision.decisionId,
            accountId: decision.accountId,
            model: model.id,
            outcome: "ok",
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
    recordOutcome({
      kind: "after_provider_response",
      decisionId: lastDecision?.decisionId,
      accountId: lastDecision?.accountId,
      model: lastDecision?.model,
      provider: (event as { provider?: string })?.provider ?? lastDecision?.provider,
      outcome: "ok",
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
