import { dirname } from 'node:path';

import { planHandBack, CswapUndoRefusalError, type HandBackPlan, type PlanHandBackDependencies } from '../cswap-undo';
import { isCredentialNotFound } from '../credential-backends';
import { platformKeychain } from '../keychain';
import { openStoreConnection } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';

export interface UndoCswapCommandDependencies {
  plan?: (deps: PlanHandBackDependencies) => Promise<HandBackPlan>;
  /** Test seam for the read-only plan; production uses the guarded platform backend. */
  keychain?: PlanHandBackDependencies['keychain'];
  backupDir?: string;
}

type Options = { json: boolean };

function parse(args: string[]): Options | null {
  const allowed = new Set(['--dry-run', '--json']);
  if (!args.includes('--dry-run') || args.some((arg) => !allowed.has(arg)) || new Set(args).size !== args.length) return null;
  return { json: args.includes('--json') };
}

function readPlanState(dbPath: string): Pick<PlanHandBackDependencies, 'slots' | 'activeAccountId' | 'migratedPiProviders'> {
  const db = openStoreConnection(dbPath, true);
  try {
    const slots = db.prepare(`SELECT account_id AS accountId, slot_num AS slotNum, email, fingerprint, source, dead
      FROM claude_slots WHERE archived_at IS NULL ORDER BY slot_num, account_id`).all() as Array<{
      accountId: string; slotNum: number | null; email: string | null; fingerprint: string | null; source: string | null; dead: number;
    }>;
    const active = db.prepare("SELECT account_id AS accountId FROM active_login WHERE provider = 'anthropic'").get() as { accountId: string | null } | undefined;
    const migrated = db.prepare("SELECT key FROM config WHERE key LIKE 'pi.%.state' AND value = 'migrated' ORDER BY key").all() as Array<{ key: string }>;
    return {
      slots: () => slots,
      activeAccountId: () => active?.accountId ?? null,
      migratedPiProviders: () => migrated.map(({ key }) => key.slice('pi.'.length, -'.state'.length)),
    };
  } finally {
    db.close();
  }
}

function formatHuman(plan: HandBackPlan): string[] {
  const active = plan.activeAccountNumber === null ? 'none' : String(plan.activeAccountNumber);
  return [
    `activeAccountNumber=${active}`,
    ...plan.slots.map((slot) => `slot ${slot.accountNumber}: ${slot.action} claude-swap/${slot.item} fingerprint=${slot.fingerprint}`),
    ...plan.deleteEnc.map((path) => `delete .enc ${path}`),
  ];
}

/** `qlb undo cswap --dry-run`: render only the G16 hand-back plan. */
export async function runUndoCswapCommand(
  args: string[],
  ctx: CommandContext,
  dependencies: UndoCswapCommandDependencies = {},
): Promise<number> {
  const options = parse(args);
  if (!options) {
    ctx.stderr('usage: qlb undo cswap --dry-run [--json]');
    return 2;
  }

  try {
    const state = readPlanState(ctx.config.dbPath);
    const keychain: PlanHandBackDependencies['keychain'] = dependencies.keychain ?? {
      async get(service, account) {
        const credential = await platformKeychain.get(service, account);
        ctx.registerSecret(credential);
        return credential;
      },
    };
    const plan = await (dependencies.plan ?? planHandBack)({
      ...state,
      backupDir: dependencies.backupDir ?? dirname(ctx.config.cswapSequencePath),
      keychain,
    });
    if (options.json) ctx.stdout(JSON.stringify({ ...plan, dryRun: true }));
    else for (const line of formatHuman(plan)) ctx.stdout(line);
    return 0;
  } catch (error) {
    if (error instanceof CswapUndoRefusalError) {
      if (error.code === 'qlb-add-slot') {
        if (options.json) {
          ctx.stdout(JSON.stringify({
            dryRun: true,
            refused: error.code,
            slots: error.slots,
          }));
        } else {
          ctx.stderr(`qlb undo cswap: refused: qlb-add slots ${error.slots
            .map((slot) => `${slot.accountNumber} (${slot.email})`)
            .join(', ')}`);
        }
        return 3;
      }
      const detail = error.code === 'pi-migrated'
        ? `migrated Pi provider ${error.provider ?? 'unknown'}`
        : 'active Claude slot';
      ctx.stderr(`qlb undo cswap: refused: ${detail}`);
      return 3;
    }
    // Backend messages can contain credentials; never render arbitrary errors.
    if (isCredentialNotFound(error)) ctx.stderr('qlb undo cswap: plan unavailable');
    else ctx.stderr('qlb undo cswap: plan unavailable');
    return 1;
  }
}

const command: CommandDefinition = { name: 'undo cswap', execute: runUndoCswapCommand };
export default command;
