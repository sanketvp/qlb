import { randomUUID } from 'node:crypto';

import { readCodexAuthStableWithStat } from '../codex-auth';
import { CodexSlots } from '../codex-slots';
import {
  CODEX_SWITCH_COMMAND_ENABLED,
  codexOldAccountLine,
  codexSwitchJournalDir,
  listCodexOldAccountSessions,
  switchCodex,
  type CodexOldAccountSession,
  type CodexSwitchDeps,
  type CodexSwitchResult,
} from '../codex-switch';
import { list as listCodexSessions, processLstart } from '../codex-sessions';
import { listCswapProcesses } from '../cswap-processes';
import { platformKeychain } from '../keychain';
import { assertAdmitted } from '../lifecycle';
import { openStore, type Store } from '../store';
import { resolveCodexAuthPath } from './codex-import-active';
import type { CommandContext, CommandDefinition } from '../registry';

type ParsedArgs = { target: string; json: boolean };

const NOT_ENABLED = "qlb switch openai-codex is not enabled yet: it turns on together with QLB's background checks (C8).";

export interface SwitchOpenAiCodexCommandDeps {
  /** C8 is the only production owner permitted to activate this command. */
  enabled?: boolean;
  openStore?: typeof openStore;
  switchCodex?: typeof switchCodex;
  listCodexOldAccountSessions?: typeof listCodexOldAccountSessions;
  codexOldAccountLine?: typeof codexOldAccountLine;
  /** Construction seam covering the engine's filesystem, process, Keychain and HTTP dependencies. */
  makeSwitchDeps?: (ctx: CommandContext, store: Store) => Promise<CodexSwitchDeps> | CodexSwitchDeps;
  now?: () => number;
  randomUUID?: () => string;
  processLstart?: typeof processLstart;
}

function parse(args: string[]): ParsedArgs | null {
  if (!args[0] || args[0].startsWith('-')) return null;
  let json = false;
  let triggerSeen = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--trigger' && !triggerSeen && args[index + 1] === 'manual') {
      triggerSeen = true;
      index += 1;
      continue;
    }
    return null;
  }
  return { target: args[0], json };
}

function usage(ctx: CommandContext): number {
  ctx.stderr('usage: qlb switch openai-codex <slot-id> [--trigger manual] [--json]');
  return 2;
}

function safeReason(reason: string | undefined): string | undefined {
  return reason !== undefined && /^[a-z0-9-]+$/.test(reason)
    && !/(token|secret|credential|access|refresh)/i.test(reason) ? reason : undefined;
}

function safeMessage(message: string | undefined): string | undefined {
  // Engine messages are fixed operator guidance. Do not print arbitrary error text.
  const prefix = 'Codex switch recovery needs you (';
  const suffix = '): log in to Codex with the account you want (codex login), then run qlb codex import-active. QLB finishes the recovery at its next check.';
  if (message === undefined || !message.startsWith(prefix) || !message.endsWith(suffix)) return undefined;
  return safeReason(message.slice(prefix.length, -suffix.length)) === undefined ? undefined : message;
}

function receipt(
  result: CodexSwitchResult,
  from: string | null,
  to: string,
  oldAccountPids: number[],
): Record<string, unknown> {
  return {
    outcome: result.outcome,
    from,
    to,
    switchId: result.switchId ?? null,
    ...(safeReason(result.reason) === undefined ? {} : { reason: safeReason(result.reason) }),
    ...(safeMessage(result.message) === undefined ? {} : { message: safeMessage(result.message) }),
    watch: result.watch ?? null,
    lockLostAfterCommit: result.lockLostAfterCommit === true,
    oldAccountPids,
  };
}

function exitCode(result: CodexSwitchResult): 0 | 1 | 3 {
  if (result.lockLostAfterCommit) return 1;
  if (result.outcome === 'ok' || result.outcome === 'noop') return 0;
  if (result.outcome === 'refused') return 3;
  return 1;
}

function defaultSwitchDeps(
  ctx: CommandContext,
  store: Store,
  commandDeps: Pick<SwitchOpenAiCodexCommandDeps, 'now' | 'randomUUID'>,
): CodexSwitchDeps {
  const slots = new CodexSlots({ keychain: platformKeychain });
  const now = commandDeps.now ?? Date.now;
  return {
    store,
    readLive: () => readCodexAuthStableWithStat(resolveCodexAuthPath(ctx.env, ctx.config)),
    cswapProcesses: listCswapProcesses,
    now,
    attempt: (commandDeps.randomUUID ?? randomUUID)(),
    dbPath: store.dbPath,
    slots,
    keychain: platformKeychain,
    authPath: resolveCodexAuthPath(ctx.env, ctx.config),
    list: listCodexSessions,
    transport: async (request) => {
      const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
      return { status: response.status, body: await response.text() };
    },
    journalDir: codexSwitchJournalDir({ env: ctx.env }),
    admitted: (trigger) => assertAdmitted(store, trigger === 'manual' ? 'switch:manual' : 'switch:auto'),
    journalOwner: { pid: process.pid, lstart: '' },
  };
}

/** `qlb switch openai-codex <slot-id> [--trigger manual] [--json]` (C6-24). */
export function createSwitchOpenAiCodexCommand(deps: SwitchOpenAiCodexCommandDeps = {}): CommandDefinition {
  return {
    name: 'switch openai-codex',
    async execute(args: string[], ctx: CommandContext): Promise<number> {
      // Dark launch is intentionally before parsing, store opening, process
      // inspection and every other side effect.
      if (!(deps.enabled ?? CODEX_SWITCH_COMMAND_ENABLED)) {
        ctx.stderr(NOT_ENABLED);
        return 3;
      }
      const parsed = parse(args);
      if (!parsed) return usage(ctx);

      const store = (deps.openStore ?? openStore)(ctx.config.dbPath);
      try {
        const from = store.getCodexActiveLogin();
        const engineDeps = deps.makeSwitchDeps
          ? await deps.makeSwitchDeps(ctx, store)
          : defaultSwitchDeps(ctx, store, deps);
        // Production captures the process incarnation before a journal can be
        // written; injected engine deps own their complete test topology.
        if (!deps.makeSwitchDeps) engineDeps.journalOwner = {
          pid: process.pid,
          lstart: await (deps.processLstart ?? processLstart)(process.pid) ?? '',
        };
        const result = await (deps.switchCodex ?? switchCodex)(engineDeps, { target: parsed.target, trigger: 'manual' });
        let oldSessions: CodexOldAccountSession[] = [];
        if (result.outcome === 'reverted-by-codex' && from !== null) {
          oldSessions = await (deps.listCodexOldAccountSessions ?? listCodexOldAccountSessions)(engineDeps, { from });
        }
        const oldAccountPids = oldSessions.map(({ pid }) => pid);
        if (parsed.json) {
          ctx.stdout(JSON.stringify(receipt(result, from, parsed.target, oldAccountPids)));
        } else if (result.outcome === 'refused' && safeMessage(result.message) !== undefined) {
          ctx.stderr(safeMessage(result.message)!);
        } else {
          ctx.stdout(`Codex switch ${from ?? '-'} → ${parsed.target}: ${result.outcome}`);
          if (result.outcome === 'reverted-by-codex') {
            ctx.stdout(`Codex reverted the switch at ${new Date((deps.now ?? Date.now)()).toISOString()}; ${oldSessions.length} sessions on old account`);
            for (const session of oldSessions) ctx.stdout((deps.codexOldAccountLine ?? codexOldAccountLine)(from ?? '-', session));
          }
          if (result.watch?.state === 'pending') ctx.stdout(`QLB keeps checking until ${new Date(result.watch.until).toISOString()}`);
        }
        return exitCode(result);
      } finally {
        store.close();
      }
    },
  };
}

const command = createSwitchOpenAiCodexCommand();
export default command;
