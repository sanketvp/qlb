import assert from 'node:assert/strict';
import { test } from 'node:test';

import { credential, twoSlotFixture } from './support/claude-fixtures';

test('Claude fixture helpers preserve canonical OAuth blobs and slot metadata', () => {
  assert.equal(
    credential('a'),
    '{"claudeAiOauth":{"accessToken":"access-a","refreshToken":"refresh-a"}}',
  );
  assert.equal(
    credential('a', { accessToken: 'fixture-access-a', refreshToken: 'fixture-refresh-a', expiresAt: 123 }),
    '{"claudeAiOauth":{"accessToken":"fixture-access-a","refreshToken":"fixture-refresh-a","expiresAt":123}}',
  );
  assert.deepEqual(twoSlotFixture(), [
    { accountId: 'account-a', credential: credential('a'), email: 'a@example.test', orgUuid: 'org-a', configJson: '{"oauthAccount":{"accountUuid":"account-a"}}', source: 'cswap-import' },
    { accountId: 'account-b', credential: credential('b'), email: 'b@example.test', orgUuid: 'org-b', configJson: '{"oauthAccount":{"accountUuid":"account-b"}}', source: 'cswap-import' },
  ]);
});
