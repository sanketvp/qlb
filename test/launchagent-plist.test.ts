import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const plistPath = join(__dirname, '..', '..', 'scripts', 'launchagents', 'com.modus.qlb-auto.plist');

describe('QLB auto LaunchAgent template (AC45)', () => {
  it('is valid XML with absolute paths and no test-mode environment', () => {
    const plist = readFileSync(plistPath, 'utf8');
    assert.equal(execFileSync('plutil', ['-lint', plistPath], { encoding: 'utf8' }).trim(), `${plistPath}: OK`);
    assert.equal(plist.includes('~'), false);
    assert.equal(plist.includes('QLB_TEST_MODE'), false);
    assert.match(plist, /<string>\/[^<]+<\/string>/);
  });
});
