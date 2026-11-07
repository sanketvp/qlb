export interface CredentialOverrides {
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number;
  extra?: Record<string, unknown>;
}

/** Builds the minimal Claude OAuth credential blob used by slot fixtures. */
export function credential(tag: string, overrides: CredentialOverrides = {}): string {
  const oauth = {
    ...(overrides.accessToken === null ? {} : { accessToken: overrides.accessToken ?? `access-${tag}` }),
    ...(overrides.refreshToken === null ? {} : { refreshToken: overrides.refreshToken ?? `refresh-${tag}` }),
    ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
    ...overrides.extra,
  };
  return JSON.stringify({ claudeAiOauth: oauth });
}

/** Builds a Claude OAuth blob with the fixture-access token convention. */
export function credentialWithFixtureAccess(account: string, refreshToken: string, expiresAt: number): string {
  return credential(account, { accessToken: `fixture-access-${account}`, refreshToken, expiresAt });
}

/** Builds a Claude OAuth blob with a supplied refresh token. */
export function credentialWithRefresh(tag: string, refreshToken: string, overrides: CredentialOverrides = {}): string {
  return credential(tag, { expiresAt: 1_800_000_000_000, ...overrides, refreshToken });
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
