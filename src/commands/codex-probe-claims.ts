import { join } from 'node:path';
import { authTime, idTokenClaimNames, readCodexAuthStable } from '../codex-auth';
import { config, stripConfigArgs } from '../config';
import { openStore } from '../store';
import { legacyCommand } from './_legacy';

function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ? join(env.CODEX_HOME, 'auth.json') : config.codexAuthJsonPath;
}

function invokedThroughRemovedAlias(argv: string[] = process.argv): boolean {
  return stripConfigArgs(argv).slice(2)[0] === 'codex-probe-claims';
}

function probeReadError(status: Exclude<Awaited<ReturnType<typeof readCodexAuthStable>>, { status: 'ok' }>): string {
  switch (status.status) {
    case 'missing': return 'auth file is missing';
    case 'unreadable': return `auth file is unreadable (${status.code})`;
    case 'unstable': return 'auth file is unstable while reading';
    case 'wiped': return 'auth file has no usable tokens';
  }
}

/** Reads a Codex auth fixture or live document without emitting any claim value. */
export async function runCodexProbeClaims(args: string[]): Promise<number> {
  if (invokedThroughRemovedAlias()) {
    console.error('qlb: codex-probe-claims is not a command; use qlb codex probe-claims');
    return 1;
  }
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) {
    console.log('qlb codex probe-claims --json | --record-l40-verified');
    return 0;
  }
  if (args.length !== 1 || (args[0] !== '--json' && args[0] !== '--record-l40-verified')) {
    console.error('qlb codex probe-claims: expected --json or --record-l40-verified');
    return 1;
  }

  const result = await readCodexAuthStable(codexAuthPath());
  if (args[0] === '--record-l40-verified') {
    if (result.status !== 'ok' || authTime(result.doc) === undefined) {
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

  if (result.status !== 'ok') {
    console.error(`qlb codex probe-claims: error: ${probeReadError(result)}`);
    return 1;
  }
  console.log(JSON.stringify({ claimNames: idTokenClaimNames(result.doc), hasAuthTime: authTime(result.doc) !== undefined }));
  return 0;
}

export default legacyCommand('codex probe-claims', ['codex-probe-claims']);
