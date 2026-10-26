/*
 * Ported from claude-swap 0.28.0.
 * Upstream file(s): src/claude_swap/switcher.py:3511-3528,3695-3948.
 * License: MIT.
 * Modified for QLB. See NOTICE.
 */

import { type ClaudeAddEffectsResult, type ClaudeSlots } from './cc-slots';
import { looksLikeApiKey } from './cc-credentials';

export interface ClaudeAddInput {
  credential: string;
  /** Parsed global Claude config. It is supplied by the caller to keep filesystem I/O injectable. */
  config: unknown;
  replace?: string;
  alias?: string;
  slots: ClaudeSlots;
}

export interface ClaudeAddResult extends ClaudeAddEffectsResult {
  accountId: string;
}

type ClaudeIdentity = {
  accountId: string;
  email: string | null;
  orgUuid: string | null;
  configJson: string;
};

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function assertSafeId(value: string, description: string): void {
  if (!value || /[\0/\\:]/.test(value)) throw new Error(`invalid ${description}`);
}

function identityFromConfig(config: unknown): ClaudeIdentity {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Claude config has no oauthAccount');
  }
  const oauthAccount = (config as Record<string, unknown>).oauthAccount;
  if (!oauthAccount || typeof oauthAccount !== 'object' || Array.isArray(oauthAccount)) {
    throw new Error('Claude config has no oauthAccount');
  }
  const accountId = stringOrNull((oauthAccount as Record<string, unknown>).accountUuid);
  if (!accountId) throw new Error('Claude config has no accountUuid');
  assertSafeId(accountId, 'accountUuid');
  return {
    accountId,
    email: stringOrNull((oauthAccount as Record<string, unknown>).emailAddress),
    orgUuid: stringOrNull((oauthAccount as Record<string, unknown>).organizationUuid),
    configJson: JSON.stringify(config),
  };
}

function validatedAlias(alias: string | undefined): string | null {
  if (alias == null) return null;
  if (!alias || /[\0\r\n]/.test(alias)) throw new Error('invalid alias');
  return alias;
}

/**
 * §4.13's pure coordination boundary. The caller injects the live credential
 * and config; this function never reads or writes the live Claude store.
 */
export async function addClaudeLogin(input: ClaudeAddInput): Promise<ClaudeAddResult> {
  if (looksLikeApiKey(input.credential)) throw new Error('active Claude login is an API key');
  const identity = identityFromConfig(input.config);
  const alias = validatedAlias(input.alias);
  const existing = input.slots.listSlots().find((slot) => slot.accountId === identity.accountId) ?? null;

  if (existing && input.replace !== identity.accountId) {
    if (input.replace) throw new Error('replace target belongs to a different identity');
    throw new Error(`Claude slot already exists for ${identity.accountId}`);
  }
  if (!existing && input.replace) {
    throw new Error('replace target belongs to a different identity');
  }

  const result = await input.slots.applyAdd({
    accountId: identity.accountId,
    credential: input.credential,
    email: identity.email,
    alias,
    orgUuid: identity.orgUuid,
    configJson: identity.configJson,
    replace: Boolean(existing),
  });
  return { ...result, accountId: identity.accountId };
}
