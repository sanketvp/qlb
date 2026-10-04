import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CONSUME_ERRORS } from '../extensions/qlb-pi/consume';
import { resolvePiPackageRoot } from '../src/pi-integration';

// Loads the production default export of extensions/qlb-pi/index.ts through
// Pi's own jiti loader and package aliases, using the Pi install on PATH (the
// one the user runs). CI has no Pi; `qlb doctor --live` covers the seam there.
const ROOT = join(__dirname, '..', '..');
const PI_GLOBAL_ROOT = process.env.QLB_TEST_PI_ROOT ?? resolvePiPackageRoot() ?? '/nonexistent-pi';
const FIXTURES = join(ROOT, 'test', 'fixtures', 'qlb-pi-smoke');
const piAvailable = existsSync(join(PI_GLOBAL_ROOT, 'node_modules', 'jiti', 'lib', 'jiti.mjs'));

interface SmokeResult {
  calls: string[];
  poolStillRegistered: boolean;
  events: Array<{ type?: string; error?: { errorMessage?: string } }>;
}

function load(opts: {
  owner?: string;
  states: string;
  call?: boolean;
  marker?: boolean;
  env?: NodeJS.ProcessEnv;
}): SmokeResult {
  const home = mkdtempSync(join(tmpdir(), 'qlb-pi-smoke-'));
  if (opts.marker) {
    mkdirSync(join(home, '.qlb'), { recursive: true });
    writeFileSync(join(home, '.qlb', 'consume-anthropic.json'), '{"state":"CONSUMED"}\n');
  }
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
    ...opts.env,
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
  it('inert when consume is off and no owner file: anthropic-pool untouched, no CLI spawn', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-pi-smoke-nospawn-'));
    const counter = join(home, 'qlb-calls');
    const r = load({ states: 'NATIVE', env: { SMOKE_COUNTER: counter } });
    assert.deepEqual(r.calls, []);
    assert.equal(r.poolStillRegistered, true);
    assert.equal(existsSync(counter), false, 'startup must not spawn qlb when no marker/owner file exists');
  });

  it('consume mode replaces the pool and re-checks the journal per request before any credential read', () => {
    // Load sees CONSUMED; the request sees NATIVE, so it must stop before the Keychain.
    const r = load({ states: 'CONSUMED,NATIVE', call: true, marker: true }); // enable writes the marker
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
    for (const [owner, states, message] of [
      ['{not json', 'NATIVE', CONSUME_ERRORS.conflict],
      ['{"accounts":[]}', 'unknown', CONSUME_ERRORS.stateUnknown],
    ] as const) {
      const r = load({ owner, states, call: true });
      assert.equal(r.poolStillRegistered, false, `${owner}/${states}`);
      assert.equal(r.events[0]!.error?.errorMessage, message);
    }
  });

  it('consume marker present but status unreadable: never falls back to anthropic-pool', () => {
    const r = load({ states: 'unknown', marker: true, call: true });
    assert.deepEqual(r.calls, ['unregister:anthropic', 'register:anthropic']);
    assert.equal(r.poolStillRegistered, false);
    assert.equal(r.events[0]!.error?.errorMessage, CONSUME_ERRORS.stateUnknown);
    // Without the marker an unreadable status stays inert (consume was never enabled).
    assert.deepEqual(load({ states: 'unknown' }).calls, []);
    // Loading between the marker write and the journal write (or after a crash) fails closed.
    const mid = load({ states: 'NATIVE', marker: true, call: true });
    assert.equal(mid.poolStillRegistered, false);
    assert.equal(mid.events[0]!.error?.errorMessage, CONSUME_ERRORS.stateInconsistent);
  });

  it('marker beside a custom QLB_DB_PATH is honored', () => {
    const home = mkdtempSync(join(tmpdir(), 'qlb-pi-smoke-db-'));
    const dbDir = join(home, 'custom-db');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, 'consume-anthropic.json'), '{"state":"CONSUMED"}\n');
    const r = load({ states: 'unknown', call: true, env: { QLB_DB_PATH: join(dbDir, 'qlb.db') } });
    assert.equal(r.poolStillRegistered, false);
    assert.equal(r.events[0]!.error?.errorMessage, CONSUME_ERRORS.stateUnknown);
  });

  it('owned mode still unregisters the existing provider before registering', () => {
    const r = load({ owner: '{"accounts":[]}', states: 'NATIVE' });
    assert.deepEqual(r.calls, ['unregister:anthropic', 'register:anthropic']);
    assert.equal(r.poolStillRegistered, false);
  });
});
