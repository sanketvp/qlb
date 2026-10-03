import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CONSUME_ERRORS } from '../extensions/qlb-pi/consume';

// Loads the production default export of extensions/qlb-pi/index.ts through
// Pi's own jiti loader and package aliases. Needs a global Pi install, which
// CI does not have; `qlb doctor` (pi:typecheck) covers the same seam there.
const ROOT = join(__dirname, '..', '..');
const PI_GLOBAL_ROOT =
  process.env.QLB_TEST_PI_ROOT ?? '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const FIXTURES = join(ROOT, 'test', 'fixtures', 'qlb-pi-smoke');
const piAvailable = existsSync(join(PI_GLOBAL_ROOT, 'node_modules', 'jiti', 'lib', 'jiti.mjs'));

interface SmokeResult {
  calls: string[];
  poolStillRegistered: boolean;
  events: Array<{ type?: string; error?: { errorMessage?: string } }>;
}

function load(opts: { owner?: string; states: string; call?: boolean }): SmokeResult {
  const home = mkdtempSync(join(tmpdir(), 'qlb-pi-smoke-'));
  if (opts.owner !== undefined) {
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(join(home, '.pi', 'agent', 'qlb-owner.json'), opts.owner);
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USER: 'qlb-smoke-nobody',
    PI_GLOBAL_ROOT,
    QLB_PI_EXTENSION: join(ROOT, 'extensions', 'qlb-pi', 'index.ts'),
    QLB_CLI: join(FIXTURES, 'fake-qlb-cli.js'),
    SMOKE_STATES: opts.states,
    SMOKE_COUNTER: join(home, 'qlb-calls'),
    SMOKE_CALL: opts.call ? '1' : '0',
  };
  const r = spawnSync(process.execPath, [join(FIXTURES, 'load-extension.mjs')], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.trim().split('\n').pop() ?? '';
  return JSON.parse(line) as SmokeResult;
}

describe('qlb-pi production default export (Pi jiti loader)', { skip: piAvailable ? false : 'global Pi install not found' }, () => {
  it('inert when consume is off and no owner file: anthropic-pool untouched', () => {
    const r = load({ states: 'NATIVE' });
    assert.deepEqual(r.calls, []);
    assert.equal(r.poolStillRegistered, true);
  });

  it('consume mode replaces the pool and re-checks the journal per request before any credential read', () => {
    // Load sees CONSUMED; the request sees NATIVE, so it must stop before the Keychain.
    const r = load({ states: 'CONSUMED,NATIVE', call: true });
    assert.deepEqual(r.calls, ['unregister:anthropic', 'register:anthropic']);
    assert.equal(r.poolStillRegistered, false);
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0]!.error?.errorMessage, CONSUME_ERRORS.disabled);
  });

  it('owner file + CONSUMED is a conflict: pool replaced by an error-only stub', () => {
    const r = load({ owner: '{"accounts":[]}', states: 'CONSUMED', call: true });
    assert.deepEqual(r.calls, ['unregister:anthropic', 'register:anthropic']);
    assert.equal(r.poolStillRegistered, false);
    assert.equal(r.events[0]!.error?.errorMessage, CONSUME_ERRORS.conflict);
  });

  it('malformed owner file or unreadable journal with an owner file fails closed', () => {
    for (const [owner, states] of [['{not json', 'NATIVE'], ['{"accounts":[]}', 'unknown']] as const) {
      const r = load({ owner, states, call: true });
      assert.equal(r.poolStillRegistered, false, `${owner}/${states}`);
      assert.equal(r.events[0]!.error?.errorMessage, CONSUME_ERRORS.conflict);
    }
  });

  it('owned mode still unregisters the existing provider before registering', () => {
    const r = load({ owner: '{"accounts":[]}', states: 'NATIVE' });
    assert.deepEqual(r.calls, ['unregister:anthropic', 'register:anthropic']);
    assert.equal(r.poolStillRegistered, false);
  });
});
