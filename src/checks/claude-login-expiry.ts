import { loginExpiryField, parseCredentialBlob } from '../anthropic-oauth';
import { QLB_KEYCHAIN_ACCOUNT, qlbKeychainService, type KeychainBackend } from '../keychain';
import { redactError } from '../redact';
import { openStoreConnection } from '../store';
import { check, guardCheck } from './_check';
import type { HealthCheck } from './claude-slots';

export default check('claude:login-expiry');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

interface ExpiryObservation {
  accountId: string;
  kind: 'unreadable' | 'not-reported' | 'expired' | 'expiring' | 'valid';
  expiresAt?: string;
}

export function claudeLoginExpiryCheck(
  dbPath: string,
  keychain: Pick<KeychainBackend, 'getSync'>,
  now = Date.now(),
): HealthCheck {
  return guardCheck('claude:login-expiry', () => {
    const db = openStoreConnection(dbPath, true);
    let accountIds: string[];
    try {
      accountIds = (db.prepare(`SELECT account_id AS accountId FROM claude_slots
        WHERE dead = 0 AND archived_at IS NULL ORDER BY account_id`).all() as Array<{ accountId: string }>)
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
        credential = keychain.getSync(qlbKeychainService('anthropic', accountId), QLB_KEYCHAIN_ACCOUNT);
      } catch {
        return { accountId, kind: 'unreadable' };
      }
      try {
        const parsed = parseCredentialBlob(credential);
        if (parsed === null) return { accountId, kind: 'unreadable' };
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
    const unreadable = observations.filter((item) => item.kind === 'unreadable');
    const expiring = observations.filter((item) => item.kind === 'expiring');
    const message = [
      expired.length > 0 && `expired Claude login: ${expired.map((item) => `${item.accountId} (${item.expiresAt})`).join(', ')}`,
      unreadable.length > 0 && `Claude credential unreadable for slot ${unreadable.map((item) => item.accountId).join(', ')}`,
      expiring.length > 0 && `Claude login expires within 7 days: ${expiring.map((item) => `${item.accountId} (${item.expiresAt})`).join(', ')}`,
    ].filter((item): item is string => Boolean(item)).join('; ');
    const level = expired.length > 0 ? 'FAIL' : unreadable.length > 0 || expiring.length > 0 ? 'WARN' : undefined;
    if (level !== undefined) return { name: 'claude:login-expiry', level, message };
    if (observations.every((item) => item.kind === 'not-reported')) {
      return { name: 'claude:login-expiry', level: 'PASS', message: 'expiry not reported' };
    }
    return { name: 'claude:login-expiry', level: 'PASS', message: 'Claude login expiry is valid' };
  }, (error) => ({
    name: 'claude:login-expiry', level: 'WARN',
    message: `Claude login expiry cannot be evaluated: ${redactError(error, [])}`,
  }));
}
