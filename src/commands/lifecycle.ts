import { FINISH_RETIREMENT_FIRST, RETIREMENT_IN_PROGRESS, closeLifecycle, markDrillDone, phase } from '../lifecycle';
import { openStore } from '../store';
import type { CommandContext, CommandDefinition } from '../registry';

function emit(ctx: CommandContext, json: boolean, value: unknown, message: string): void {
  if (json) ctx.stdout(JSON.stringify(value));
  else ctx.stderr(message);
}

function parseJson(args: string[]): { json: boolean; args: string[] } {
  return { json: args.includes('--json'), args: args.filter((arg) => arg !== '--json') };
}

async function execute(args: string[], ctx: CommandContext): Promise<number> {
  const parsed = parseJson(args);
  const [subcommand, ...rest] = parsed.args;
  const store = openStore(ctx.config.dbPath);
  try {
    if (subcommand === 'drill-done' && rest.length === 0) {
      const result = markDrillDone(store);
      emit(ctx, parsed.json, result, result.ok ? 'lifecycle drill recorded' : `lifecycle drill refused: ${result.code}`);
      return result.ok ? 0 : 3;
    }
    if (subcommand === 'close' && rest.length >= 3 && rest[1] === '--note') {
      const id = Number(rest[0]);
      const note = rest.slice(2).join(' ');
      if (!Number.isInteger(id) || id <= 0 || note.length === 0) {
        ctx.stderr('usage: qlb lifecycle close <id> --note <why> [--json]');
        return 2;
      }
      const result = closeLifecycle(store, id, note);
      const refusal = result.code === RETIREMENT_IN_PROGRESS
        ? `lifecycle close refused: ${result.code}; ${FINISH_RETIREMENT_FIRST}`
        : `lifecycle close refused: ${result.code}`;
      emit(ctx, parsed.json, result, result.ok ? 'lifecycle closed' : refusal);
      return result.ok ? 0 : 3;
    }
    if (subcommand === 'status' && rest.length === 0) {
      emit(ctx, parsed.json, phase(store), `lifecycle: ${phase(store).state}`);
      return 0;
    }
  } finally { store.close(); }
  ctx.stderr('usage: qlb lifecycle status|drill-done|close <id> --note <why> [--json]');
  return 2;
}

const command: CommandDefinition = { name: 'lifecycle', execute };
export default command;
