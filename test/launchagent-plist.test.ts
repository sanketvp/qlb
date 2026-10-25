import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveCommand, discoverCommands } from '../src/registry';

const plistPath = join(__dirname, '..', '..', 'scripts', 'launchagents', 'com.modus.qlb-auto.plist');

describe('QLB auto LaunchAgent template (AC45)', () => {
  it('is valid XML with absolute paths and no test-mode environment', () => {
    const plist = readFileSync(plistPath, 'utf8');
    // plutil exists only on macOS; Linux CI still checks the remaining invariants.
    if (process.platform === 'darwin') {
      assert.equal(execFileSync('plutil', ['-lint', plistPath], { encoding: 'utf8' }).trim(), `${plistPath}: OK`);
    }
    assert.equal(plist.includes('~'), false);
    assert.equal(plist.includes('QLB_TEST_MODE'), false);
    assert.match(plist, /<string>\/[^<]+<\/string>/);
  });

  it('runs a registered command and has no unconditional restart policy', () => {
    const plist = readFileSync(plistPath, 'utf8');
    const argumentsBlock = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
    const values = [...argumentsBlock.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1]);
    assert.ok(resolveCommand(values.slice(2), discoverCommands()), 'plist command must be registered');
    assert.doesNotMatch(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  });
});
