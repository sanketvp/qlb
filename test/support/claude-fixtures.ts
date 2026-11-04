export interface CredentialOverrides {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

/** Builds the minimal Claude OAuth credential blob used by slot fixtures. */
export function credential(tag: string, overrides: CredentialOverrides = {}): string {
  const oauth = {
    accessToken: overrides.accessToken ?? `access-${tag}`,
    refreshToken: overrides.refreshToken ?? `refresh-${tag}`,
    ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
  };
  return JSON.stringify({ claudeAiOauth: oauth });
}

export interface ClaudeSlotFixture {
  accountId: string;
  credential: string;
  email: string;
  orgUuid: string;
  configJson: string;
  source: 'cswap-import';
}

/** Returns the standard pair of imported Claude slots used by switch fixtures. */
export function twoSlotFixture(
  firstCredential = credential('a'),
  secondCredential = credential('b'),
): [ClaudeSlotFixture, ClaudeSlotFixture] {
  const slot = (tag: 'a' | 'b'): ClaudeSlotFixture => ({
    accountId: `account-${tag}`,
    credential: tag === 'a' ? firstCredential : secondCredential,
    email: `${tag}@example.test`,
    orgUuid: `org-${tag}`,
    configJson: JSON.stringify({ oauthAccount: { accountUuid: `account-${tag}` } }),
    source: 'cswap-import',
  });
  return [slot('a'), slot('b')];
}
