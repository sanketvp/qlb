import { loginExpiryField, parseCredentialBlob } from '../anthropic-oauth';
import { openStoreConnection } from '../store';
import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';

export default check('claude:login-expiry');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

export type ClaudeCredentialProjection = (accountId: string) => string;

interface ExpiryObservation {
  accountId: string;
  kind: 'unreadable' | 'not-reported' | 'expired' | 'expiring' | 'valid';
  expiresAt?: string;
}

/**
 * Advisory-only login-expiry inspection. The supplied projection must only read
 * the already-managed slot credential; this check never refreshes or writes it.
 */
export function claudeLoginExpiryCheck(
  dbPath: string,
  readCredential: ClaudeCredentialProjection,
  now = Date.now(),
): HealthCheck {
  return guardCheck('claude:login-expiry', () => {
    const db = openStoreConnection(dbPath, true);
    let accountIds: string[];
    try {
      accountIds = (db.prepare(`SELECT account_id AS accountId FROM claude_slots
        WHERE archived_at IS NULL ORDER BY account_id`).all() as Array<{ accountId: string }>)
        .map((row) => row.accountId);
    } finally {
      db.close();
    }
    if (accountIds.length === 0) {
      return { name: 'claude:login-expiry', level: 'PASS', message: 'no live Claude slots' };
    }

    const observations = accountIds.map((accountId): ExpiryObservation => {
      let credential: string;
      try {
        credential = readCredential(accountId);
      } catch {
        return { accountId, kind: 'unreadable' };
      }
      try {
        const parsed = parseCredentialBlob(credential);
        if (parsed === null || parsed.oauth === null) return { accountId, kind: 'unreadable' };
        const expiry = loginExpiryField(parsed).iso;
        if (expiry === null) return { accountId, kind: 'not-reported' };
        const expiresAt = new Date(expiry).getTime();
        if (expiresAt <= now) return { accountId, kind: 'expired', expiresAt: expiry };
        if (expiresAt - now <= SEVEN_DAYS_MS) return { accountId, kind: 'expiring', expiresAt: expiry };
        return { accountId, kind: 'valid', expiresAt: expiry };
      } catch {
        return { accountId, kind: 'unreadable' };
      }
    });

    const expired = observations.filter((item) => item.kind === 'expired');
    if (expired.length > 0) {
      return {
        name: 'claude:login-expiry', level: 'FAIL',
        message: `expired Claude login: ${expired.map((item) => `${item.accountId} (${item.expiresAt})`).join(', ')}`,
      };
    }
    const unreadable = observations.filter((item) => item.kind === 'unreadable');
    if (unreadable.length > 0) {
      return {
        name: 'claude:login-expiry', level: 'WARN',
        message: `Claude credential unreadable for slot ${unreadable.map((item) => item.accountId).join(', ')}`,
      };
    }
    const expiring = observations.filter((item) => item.kind === 'expiring');
    if (expiring.length > 0) {
      return {
        name: 'claude:login-expiry', level: 'WARN',
        message: `Claude login expires within 7 days: ${expiring.map((item) => `${item.accountId} (${item.expiresAt})`).join(', ')}`,
      };
    }
    if (observations.every((item) => item.kind === 'not-reported')) {
      return { name: 'claude:login-expiry', level: 'PASS', message: 'expiry not reported' };
    }
    return { name: 'claude:login-expiry', level: 'PASS', message: 'Claude login expiry is valid' };
  }, () => ({
    name: 'claude:login-expiry', level: 'WARN',
    message: 'Claude login expiry cannot be evaluated',
  }));
}
