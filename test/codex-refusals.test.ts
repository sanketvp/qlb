import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CODEX_NAMED_REFUSALS } from '../src/codex-refusals';

const source = (name: string): string => readFileSync(join(process.cwd(), 'src', name), 'utf8');
const switchSource = source('codex-switch.ts');
const consumeSource = source('codex-consume.ts');

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

/** The quoted members of the first union that follows `anchor` up to the next `;`. */
function unionMembers(text: string, anchor: string): string[] {
  const start = text.indexOf(anchor);
  assert.ok(start >= 0, `anchor not found: ${anchor}`);
  const body = text.slice(start + anchor.length, text.indexOf(';', start + anchor.length));
  const members = matches(body, /'([\w-]+)'/g);
  assert.ok(members.length > 0, `no members after ${anchor}`);
  return members;
}

function assertNamed(causes: string[]): void {
  const missing = causes.filter((cause) => !CODEX_NAMED_REFUSALS.has(cause));
  assert.deepEqual(missing, []);
}

describe('named Codex refusal list', () => {
  it('names every literal passed to the persisting refusal helpers', () => {
    const literals = [
      ...matches(switchSource, /switchRefusal\(deps, input, '([\w-]+)'\)/g),
      ...matches(switchSource, /refuse\('([\w-]+)'\)/g),
      ...matches(switchSource, /kind: 'refused', reason: '([\w-]+)'/g),
    ];
    assert.ok(literals.includes('switch-busy'));
    assertNamed(literals);
  });

  it('names every precondition reason', () => {
    assertNamed(unionMembers(switchSource, 'export type CodexSwitchPreconditionReason ='));
  });

  it('names target-freshen-<status> for every consume status', () => {
    const statuses = unionMembers(consumeSource, 'export type CodexConsumeStatus =');
    assertNamed(statuses.map((status) => `target-freshen-${status}`));
  });

  it('names the holder refusal, every recovery-fence reason and every live-observation refusal', () => {
    assertNamed(['target-held-by-session']);
    assertNamed(matches(switchSource, /const reason = '([\w-]+)'/g));
    assertNamed(unionMembers(switchSource, "{ class: 'unresolved'; reason:"));
    assertNamed(unionMembers(switchSource, "| { outcome: 'refused'; reason:"));
  });
});
