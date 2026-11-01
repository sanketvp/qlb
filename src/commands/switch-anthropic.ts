import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { buildProfileRequest, buildUsageRequest, parseProfileResponse, type HttpRequestDescription } from '../anthropic-oauth';
import { bootstrap, type BootstrapHooks } from '../bootstrap';
import { readClaudeConfig } from '../cc-credentials';
import { claudePaths } from '../cc-paths';
import { ProbeVerdictMemo, fetchActiveUsage, type RefreshHttpResponse } from '../cc-resync';
import { ClaudeSlots, SqliteClaudeSlotRepository } from '../cc-slots';
import { AdmissionRefused, switchClaude, type ClaudeSwitchDeps, type ClaudeSwitchResult } from '../cc-switch';
import { processLstart } from '../codex-sessions';
import { qlbHomeDir } from '../home';
import { platformKeychain } from '../keychain';
import { assertAdmitted } from '../lifecycle';
import type { CommandContext, CommandDefinition } from '../registry';
import { openStore, type Store } from '../store';

type ParsedArgs = { accountId: string; json: boolean };
type SwitchResources = { deps: ClaudeSwitchDeps; close?: () => void };

type FetchLike = (input: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}) => Promise<{ status: number; text(): Promise<string> }>;

export interface SwitchAnthropicCommandDeps {
  openStore?: typeof openStore;
  bootstrap?: (hooks?: BootstrapHooks, env?: NodeJS.ProcessEnv) => Promise<void>;
  assertAdmitted?: typeof assertAdmitted;
  switchClaude?: typeof switchClaude;
  /**
   * Full construction seam for the switch engine and all I/O beneath it.  It
   * keeps command tests hermetic while the default below is the production
   * composition root.
   */
  makeSwitchDeps?: (ctx: CommandContext, store: Store, warn: (message: string) => void) => Promise<SwitchResources | ClaudeSwitchDeps>;
  claudePaths?: typeof claudePaths;
  randomUUID?: () => string;
  processLstart?: typeof processLstart;
  fetchFn?: FetchLike;
  fetchActiveUsage?: typeof fetchActiveUsage;
  now?: () => number;
  reconcileJournals?: () => void | Promise<void>;
}

function parse(args: string[]): ParsedArgs | null {
  if (!args[0] || args[0].startsWith('-')) return null;
  const accountId = args[0];
  let json = false;
  let triggerSeen = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json' && !json) {
      json = true;
      continue;
    }
    if (arg === '--trigger' && !triggerSeen && args[index + 1] === 'manual') {
      triggerSeen = true;
      index += 1;
      continue;
    }
    return null;
  }
  return { accountId, json };
}

function usage(ctx: CommandContext): number {
  ctx.stderr('usage: qlb switch anthropic <account_id> [--trigger manual] [--json]');
  return 2;
}

function receipt(result: ClaudeSwitchResult): Record<string, unknown> {
  return {
    outcome: result.outcome,
    from: result.from,
    to: result.to,
    switchId: result.switchId ?? null,
    attempt: result.attempt,
    reason: result.reason ?? null,
    error: result.error ?? null,
    outgoingKind: result.outgoingKind ?? null,
    steps: result.steps ?? null,
    injected: result.injected ?? false,
  };
}

function exitCode(result: ClaudeSwitchResult): 0 | 1 | 3 {
  switch (result.outcome) {
    case 'ok':
    case 'noop': return 0;
    case 'refused': return 3;
    case 'failed':
    case 'rolled-back': return 1;
  }
}

async function request(fetchFn: FetchLike, description: HttpRequestDescription): Promise<RefreshHttpResponse> {
  const response = await fetchFn(description.url, {
    method: description.method,
    headers: description.headers,
    ...(description.body === undefined ? {} : { body: description.body }),
    signal: AbortSignal.timeout(description.timeoutMs),
  });
  return { status: response.status, body: await response.text() };
}

function defaultMakeSwitchDeps(commandDeps: SwitchAnthropicCommandDeps, ctx: CommandContext, store: Store, warn: (message: string) => void): Promise<SwitchResources> {
  const paths = (commandDeps.claudePaths ?? claudePaths)({ home: ctx.home, env: ctx.env });
  const repository = SqliteClaudeSlotRepository.open(ctx.config.dbPath);
  const slots = new ClaudeSlots({
    backend: platformKeychain,
    repository,
    stashDir: join(qlbHomeDir(ctx.env), '.qlb', 'unclaimed'),
  });
  const fetchFn = commandDeps.fetchFn ?? (fetch as unknown as FetchLike);
  const send = (description: HttpRequestDescription) => request(fetchFn, description);
  const now = commandDeps.now ?? Date.now;
  const fetchUsage = commandDeps.fetchActiveUsage ?? fetchActiveUsage;
  const live = { backend: platformKeychain, paths, env: ctx.env };
  const deps: ClaudeSwitchDeps = {
    store,
    slots,
    live,
    readConfig: (path) => readClaudeConfig(path),
    resolveProfile: async (accessToken) => {
      const response = await send(buildProfileRequest(accessToken));
      if (response.status < 200 || response.status >= 300) return null;
      try { return parseProfileResponse(JSON.parse(response.body)); } catch { return null; }
    },
    consume: { postRefresh: send },
    env: ctx.env,
    home: ctx.home,
    now,
    by: 'qlb-cli',
    attempt: (commandDeps.randomUUID ?? randomUUID)(),
    journalOwner: { pid: process.pid, lstart: '' },
    warn,
    afterSwitch: async (accountId) => {
      const slot = slots.getSlot(accountId);
      if (!slot) throw new Error('active Claude slot missing after switch');
      const current = await slots.readSlot(accountId, { fresh: true });
      const result = await fetchUsage({
        slots,
        store,
        live,
        postRefresh: send,
        now,
        verdicts: new ProbeVerdictMemo(),
        env: ctx.env,
        by: 'qlb-cli',
        getUsage: async (accessToken) => request(fetchFn, buildUsageRequest(accessToken)),
      }, {
        accountId,
        email: slot.email ?? '',
        orgUuid: slot.orgUuid ?? '',
        creds: current.credential,
        degraded: false,
      });
      if (result.error !== undefined) throw new Error('usage fetch failed');
    },
  };
  return (commandDeps.processLstart ?? processLstart)(process.pid).then((lstart) => {
    deps.journalOwner = { pid: process.pid, lstart: lstart ?? '' };
    return { deps, close: () => repository.close() };
  }, (error: unknown) => {
    repository.close();
    throw error;
  });
}

/** `qlb switch anthropic <account_id> [--trigger manual] [--json]` (K5-6). */
export function createSwitchAnthropicCommand(deps: SwitchAnthropicCommandDeps = {}): CommandDefinition {
  return {
    name: 'switch anthropic',
    async execute(args: string[], ctx: CommandContext): Promise<number> {
      const parsed = parse(args);
      if (!parsed) return usage(ctx);

      const store = (deps.openStore ?? openStore)(ctx.config.dbPath);
      let resources: SwitchResources | undefined;
      try {
        try {
          await (deps.bootstrap ?? bootstrap)({
            assertAdmitted: () => {
              const admission = (deps.assertAdmitted ?? assertAdmitted)(store, 'switch:manual');
              if (!admission.ok) throw new AdmissionRefused(admission.code ?? 'not-admitted');
            },
            // Intentionally passed through unchanged: K14 owns bootstrap's default.
            reconcileJournals: deps.reconcileJournals,
          }, ctx.env);
        } catch (error) {
          if (error instanceof AdmissionRefused) {
            ctx.stderr(`qlb switch anthropic: refused: ${error.code}`);
            return 3;
          }
          throw error;
        }

        const warn = (message: string): void => ctx.stderr(`qlb switch anthropic: warning: ${message}`);
        const built = await (deps.makeSwitchDeps ?? ((commandCtx, commandStore, commandWarn) => defaultMakeSwitchDeps(deps, commandCtx, commandStore, commandWarn)))(ctx, store, warn);
        resources = 'deps' in built ? built : { deps: built };
        const result = await (deps.switchClaude ?? switchClaude)(resources.deps, { to: parsed.accountId, trigger: 'manual' });
        if (parsed.json) ctx.stdout(JSON.stringify(receipt(result)));
        else if (result.outcome === 'refused') ctx.stderr(`qlb switch anthropic: refused: ${result.reason ?? 'unknown'}`);
        else ctx.stdout(`switched anthropic: ${result.from ?? '-'} → ${result.to} (${result.outcome})`);
        if (result.outcome === 'ok' && result.steps?.cleanup.length) warn(`cleanup: ${result.steps.cleanup.join(', ')}`);
        return exitCode(result);
      } finally {
        try { resources?.close?.(); } finally { store.close(); }
      }
    },
  };
}

const command = createSwitchAnthropicCommand();
export default command;
