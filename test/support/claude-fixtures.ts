export interface CredentialOverrides {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  extra?: Record<string, unknown>;
}

/** Builds the minimal Claude OAuth credential blob used by slot fixtures. */
export function credential(tag: string, overrides: CredentialOverrides | number = {}): string {
  const normalized = typeof overrides === 'number' ? { expiresAt: overrides } : overrides;
  const oauth = {
    accessToken: normalized.accessToken ?? `access-${tag}`,
    refreshToken: normalized.refreshToken ?? `refresh-${tag}`,
    ...(normalized.expiresAt === undefined ? {} : { expiresAt: normalized.expiresAt }),
    ...normalized.extra,
  };
  return JSON.stringify({ claudeAiOauth: oauth });
}

/** Builds a Claude OAuth blob when fixture tokens are specified explicitly. */
export function credentialWithTokens(accessToken: string, refreshToken: string, expiresAt?: number): string {
  return credential('', { accessToken, refreshToken, expiresAt });
}

/** Builds a Claude OAuth blob with the common future expiry used by poll fixtures. */
export function credentialWithStandardExpiry(tag: string, expiresAt = 1_700_003_600_000): string {
  return credential(tag, expiresAt);
}

/** Builds a Claude OAuth blob with the expired timestamp used by refresh fixtures. */
export function credentialWithExpiredExpiry(tag: string, expiresAt = 1_699_999_999_999): string {
  return credential(tag, expiresAt);
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

/** Builds an OAuth credential object used by single-provider fixture suites. */
export function oauthCredential(access: string, refresh: string, expires = 1_730_000_000_000 + 30_000): {
  type: 'oauth'; access: string; refresh: string; expires: number;
} {
  return { type: 'oauth', access, refresh, expires };
}

/** Builds a Claude OAuth blob with caller-controlled OAuth fields. */
export function credentialWithOAuthFields(fields: Record<string, unknown>): string {
  return JSON.stringify({ claudeAiOauth: fields });
}

/** Builds the expiry-only Claude OAuth blobs used by doctor fixtures. */
export function credentialWithRefreshTokenExpiry(expiresAt: unknown, tokens: Record<string, string> = {}): string {
  return credentialWithOAuthFields({ refreshTokenExpiresAt: expiresAt, ...tokens });
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
