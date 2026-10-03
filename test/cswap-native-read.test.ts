import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACTIVE_CC_SERVICE,
  SECURITY_BIN,
  activeCcSecurityArgs,
  activeKeychainAccount,
  getActiveClaudeCodeAccess,
  parseActiveCcBlob,
} from '../src/cswap-native-read';

describe('cswap-native-read allowlisted GET', () => {
  it('argv is exactly find-generic-password -a account -w -s service', () => {
    const captured: { exe: string; args: readonly string[] }[] = [];
    const blob = JSON.stringify({
      claudeAiOauth: { accessToken: 'test-access', expiresAt: 4102444800000 },
    });
    const account = activeKeychainAccount({ USER: 'fixture-user' });
    const result = getActiveClaudeCodeAccess({
      env: { USER: 'fixture-user' },
      runner: (exe, args) => {
        captured.push({ exe, args });
        return blob;
      },
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.exe, SECURITY_BIN);
    assert.deepEqual(captured[0]?.args, activeCcSecurityArgs(account));
    assert.deepEqual(captured[0]?.args, [
      'find-generic-password',
      '-a',
      account,
      '-w',
      '-s',
      ACTIVE_CC_SERVICE,
    ]);
    assert.equal(ACTIVE_CC_SERVICE, 'Claude Code-credentials');
    assert.equal(captured[0]?.exe, '/usr/bin/security');
    assert.equal(result.access, 'test-access');
    assert.equal('refreshToken' in result, false);
    assert.ok(!captured.some((c) => c.args.includes('add-generic-password')));
    assert.ok(!captured.some((c) => c.args.includes('claude-swap')));
  });

  it('normal oauth blob with only claudeAiOauth serves', () => {
    const parsed = parseActiveCcBlob(
      JSON.stringify({ claudeAiOauth: { accessToken: 'test-access', expiresAt: 4102444800000 } }),
    );
    assert.equal(parsed.access, 'test-access');
    assert.equal('refreshToken' in parsed, false);
  });
});
