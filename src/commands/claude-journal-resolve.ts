import { randomUUID } from 'node:crypto';

import { makeProductionSwitchDeps, type SwitchResources } from './switch-anthropic';
import { ClaudeCodeLockTimeout, ProperLockfileCompromised } from '../cc-locks';
import { resolveClaudeSwitchJournal, type ClaudeJournalResolveDirection } from '../journal';
import { assertAdmitted } from '../lifecycle';
import type { CommandContext, CommandDefinition } from '../registry';
import { openStore, type Store } from '../store';

export interface ClaudeJournalResolveCommandDeps {
  openStore?: typeof openStore;
  assertAdmitted?: typeof assertAdmitted;
  makeSwitchDeps?: (ctx: CommandContext, store: Store, warn: (message: string) => void) => Promise<SwitchResources>;
  resolve?: typeof resolveClaudeSwitchJournal;
  randomUUID?: () => string;
}

function parse(args: string[]): ClaudeJournalResolveDirection | null {
  return args.length === 1 && args[0] === '--forward' ? 'forward'
    : args.length === 1 && args[0] === '--back' ? 'back' : null;
}

/** `qlb claude journal resolve --forward|--back` resolves a dead switch owner. */
export function createClaudeJournalResolveCommand(deps: ClaudeJournalResolveCommandDeps = {}): CommandDefinition {
  return {
    name: 'claude journal resolve',
    async execute(args: string[], ctx: CommandContext): Promise<number> {
      const direction = parse(args);
      if (direction === null) {
        ctx.stderr('usage: qlb claude journal resolve --forward|--back');
        return 2;
      }
      let store: Store | undefined;
      let resources: SwitchResources | undefined;
      try {
        store = (deps.openStore ?? openStore)(ctx.config.dbPath);
        const admission = (deps.assertAdmitted ?? assertAdmitted)(store, 'claude-journal-resolve');
        if (!admission.ok) {
          ctx.stderr(`qlb claude journal resolve: refused: ${admission.code}`);
          return 3;
        }
        const warn = (message: string): void => ctx.stderr(`qlb claude journal resolve: warning: ${message}`);
        resources = await (deps.makeSwitchDeps ?? ((commandCtx, commandStore, commandWarn) =>
          makeProductionSwitchDeps({ randomUUID: deps.randomUUID ?? randomUUID }, commandCtx, commandStore, commandWarn)))(ctx, store, warn);
        const result = await (deps.resolve ?? resolveClaudeSwitchJournal)(resources.deps, direction);
        if (result.outcome === 'refused') {
          ctx.stderr(`qlb claude journal resolve: refused: ${result.reason}`);
          return 3;
        }
        if (result.cleanup?.length) warn(`completed with cleanup warnings: ${result.cleanup.join(', ')}`);
        ctx.stdout(`Claude journal resolved ${direction}${result.fingerprints?.length ? ` (${result.fingerprints.join(', ')})` : ''}`);
        return 0;
      } catch (error) {
        if (error instanceof ClaudeCodeLockTimeout || error instanceof ProperLockfileCompromised) {
          ctx.stderr('qlb claude journal resolve: refused: lock-timeout');
          return 3;
        }
        ctx.stderr('qlb claude journal resolve: failed');
        return 1;
      } finally {
        try { resources?.close?.(); } finally { store?.close(); }
      }
    },
  };
}

const command = createClaudeJournalResolveCommand();
export default command;
