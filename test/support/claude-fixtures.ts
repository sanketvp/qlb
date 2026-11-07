export interface CredentialOverrides {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  extra?: Record<string, unknown>;
}

/** Builds the minimal Claude OAuth credential blob used by slot fixtures. */
export function credential(tag: string, overrides: CredentialOverrides = {}): string {
  const oauth = {
    accessToken: overrides.accessToken ?? `access-${tag}`,
    refreshToken: overrides.refreshToken ?? `refresh-${tag}`,
    ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
    ...overrides.extra,
  };
  return JSON.stringify({ claudeAiOauth: oauth });
}

/** Builds a Claude OAuth blob when fixture tokens are specified explicitly. */
export function credentialWithTokens(accessToken: string, refreshToken: string, expiresAt?: number): string {
  return credential('', { accessToken, refreshToken, expiresAt });
}

/** Builds a Claude OAuth blob with the fixture-access token convention. */
export function credentialWithFixtureAccess(account: string, refreshToken: string, expiresAt: number): string {
  return credential(account, { accessToken: `fixture-access-${account}`, refreshToken, expiresAt });
}

/** Builds a Claude OAuth blob with a supplied refresh token. */
export function credentialWithRefresh(tag: string, refreshToken: string, overrides: CredentialOverrides = {}): string {
  return credential(tag, { expiresAt: 1_800_000_000_000, ...overrides, refreshToken });
}

/** Builds the legacy Claude Swap import fixture blobs. */
export function cswapImportCredential(tag: string, refreshToken: string): string {
  return credentialWithRefresh(tag, refreshToken, {
    extra: { scopes: ['user:inference'], subscriptionType: 'max' },
  });
}

/** Builds the expiry-only Claude OAuth blobs used by doctor fixtures. */
export function credentialWithRefreshTokenExpiry(expiresAt: unknown, tokens: Record<string, string> = {}): string {
  return JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: expiresAt, ...tokens } });
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
