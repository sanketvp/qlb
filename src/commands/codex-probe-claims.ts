import { join } from 'node:path';
import { authTime, idTokenClaimNames, readCodexAuthStable } from '../codex-auth';
import { config } from '../config';
import { openStore } from '../store';
import { legacyCommand } from './_legacy';

function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ? join(env.CODEX_HOME, 'auth.json') : config.codexAuthJsonPath;
}

/** Reads a Codex auth fixture or live document without emitting any claim value. */
export async function runCodexProbeClaims(args: string[]): Promise<number> {
  if (args.length !== 1 || (args[0] !== '--json' && args[0] !== '--record-l40-verified')) {
    console.error('qlb codex probe-claims: expected --json or --record-l40-verified');
    return 1;
  }

  const result = await readCodexAuthStable(codexAuthPath());
  const doc = result.status === 'ok' ? result.doc : undefined;
  if (args[0] === '--record-l40-verified') {
    if (!doc || authTime(doc) === undefined) {
      console.log(JSON.stringify({ recorded: false, reason: result.status === 'ok' ? 'no-auth-time' : result.status }));
      return 3;
    }
    const store = openStore(config.dbPath);
    try {
      store.setConfig('codex.l40Verified', '1');
    } finally {
      store.close();
    }
    console.log(JSON.stringify({ recorded: true }));
    return 0;
  }

  const claimNames = doc ? idTokenClaimNames(doc) : [];
  console.log(JSON.stringify({ claimNames, hasAuthTime: doc ? authTime(doc) !== undefined : false }));
  return 0;
}

export default legacyCommand('codex probe-claims', ['codex-probe-claims']);
