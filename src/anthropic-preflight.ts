import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { admitAnthropicCompleteSet, SourceMembershipInvalidError, type AnthropicIdentityKind } from './anthropic-complete-set';
import {
  planAnthropicAdoption,
  type AdoptionExpiry,
  type AdoptionRefusalCode,
  type AdoptionSlotClass,
  type AdoptionSlotView,
} from './anthropic-adoption';
import { isOAuthTokenExpired } from './anthropic-oauth';
import { readLiveClaudeCredentials, type ClaudeCredentialsOptions } from './cc-credentials';
import type { ClaudePaths } from './cc-paths';
import type { CredentialBackend } from './credential-backends';
import { credentialParts } from './gate/anthropic';
import { PI_POOL_STORE } from './migration';
import { openStoreConnection } from './store';

export const CLAUDE_TOKEN_EXPIRING_MS = 60 * 60 * 1000;

export type ClaudeCodeTokenClass = 'fresh' | 'expiring' | 'expired' | 'expiry-unknown' | 'unreadable';

export interface PreflightMember {
  alias: string;
  identityKind: AnthropicIdentityKind;
  slot: AdoptionSlotClass;
  expiry: AdoptionExpiry;
  active: boolean;
}

export interface AnthropicPreflightReceipt {
  schemaVersion: 1;
  phase: 'preflight';
  disposition: 'go' | 'no-go';
  code?: AdoptionRefusalCode | 'source-membership-invalid';
  claudeCodeActiveToken: ClaudeCodeTokenClass;
  pool?: 'not-native';
  count?: number;
  aliases?: string[];
  members?: PreflightMember[];
}

export interface AnthropicPreflightInput {
  dbPath: string;
  poolFile: string;
  backend: CredentialBackend;
  now?: number;
  account?: string;
  env?: NodeJS.ProcessEnv;
  paths?: ClaudePaths;
  openDatabase?: (dbPath: string) => DatabaseSync;
}

export function openPreflightDatabase(dbPath: string): DatabaseSync {
  return openStoreConnection(dbPath, true);
}

/** Class only. Never returns the token, the expiry, or an ISO timestamp. */
export function classifyClaudeCodeActiveToken(credentials: string, now: number): ClaudeCodeTokenClass {
  try {
    const parts = credentialParts(credentials);
    if (!parts) return 'unreadable';
    if (parts.expiresAt === undefined) return 'expiry-unknown';
    if (isOAuthTokenExpired(parts.expiresAt, now)) return 'expired';
    if (parts.expiresAt - now < CLAUDE_TOKEN_EXPIRING_MS) return 'expiring';
    return 'fresh';
  } catch {
    return 'unreadable';
  }
}

function readPoolText(poolFile: string): string | null {
  try {
    return readFileSync(poolFile, 'utf8');
  } catch {
    return null;
  }
}

function readAdoptionRows(db: DatabaseSync): { slots: AdoptionSlotView[]; activeAccountId: string | null; state: string | null } {
  const slots = (db.prepare(
    'SELECT account_id, email, dead, archived_at FROM claude_slots',
  ).all() as Array<{ account_id: string; email: string | null; dead: number; archived_at: number | null }>).map((row) => ({
    accountId: row.account_id,
    email: row.email,
    dead: row.dead !== 0,
    archivedAt: row.archived_at,
  }));
  const active = db.prepare(
    "SELECT account_id FROM active_login WHERE provider = 'anthropic'",
  ).get() as { account_id: string | null } | undefined;
  const migration = db.prepare('SELECT state FROM migrations WHERE store = ?').get(PI_POOL_STORE) as { state: string } | undefined;
  return {
    slots,
    activeAccountId: active?.account_id ?? null,
    state: migration?.state ?? null,
  };
}

function memberView(member: PreflightMember): PreflightMember {
  return {
    alias: member.alias,
    identityKind: member.identityKind,
    slot: member.slot,
    expiry: member.expiry,
    active: member.active,
  };
}

function goMembers(members: PreflightMember[], token: ClaudeCodeTokenClass): boolean {
  return token === 'fresh'
    && members.filter((member) => member.active).length === 1
    && members.every((member) => member.slot === 'matched' && member.expiry === 'fresh');
}

async function readTokenClass(input: AnthropicPreflightInput, now: number): Promise<ClaudeCodeTokenClass> {
  const options: ClaudeCredentialsOptions = {
    backend: input.backend,
    ...(input.account === undefined ? {} : { account: input.account }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.paths === undefined ? {} : { paths: input.paths }),
  };
  try {
    return classifyClaudeCodeActiveToken(await readLiveClaudeCredentials(options), now);
  } catch {
    return 'unreadable';
  }
}

export async function runAnthropicPreflight(input: AnthropicPreflightInput): Promise<AnthropicPreflightReceipt> {
  const now = input.now ?? Date.now();
  const token = await readTokenClass(input, now);
  const open = input.openDatabase ?? openPreflightDatabase;
  const db = open(input.dbPath);
  try {
    let view: ReturnType<typeof readAdoptionRows>;
    try {
      view = readAdoptionRows(db);
    } catch {
      throw new Error('preflight-failed');
    }
    const poolText = readPoolText(input.poolFile);
    if (poolText === null && view.state === 'QLB_OWNED') {
      return {
        schemaVersion: 1,
        phase: 'preflight',
        disposition: token === 'fresh' ? 'go' : 'no-go',
        pool: 'not-native',
        claudeCodeActiveToken: token,
      };
    }
    if (poolText === null) {
      return { schemaVersion: 1, phase: 'preflight', disposition: 'no-go', claudeCodeActiveToken: token };
    }
    try {
      const admitted = admitAnthropicCompleteSet(poolText);
      const plan = planAnthropicAdoption(admitted, view.slots, view.activeAccountId, now);
      const members = plan.members.map(memberView);
      const base = {
        schemaVersion: 1 as const,
        phase: 'preflight' as const,
        claudeCodeActiveToken: token,
        count: admitted.memberCount,
        aliases: admitted.aliases.slice(),
        members,
      };
      if (plan.code !== undefined || !goMembers(members, token)) {
        return { ...base, disposition: 'no-go', ...(plan.code === undefined ? {} : { code: plan.code }) };
      }
      return { ...base, disposition: 'go' };
    } catch (error) {
      if (error instanceof SourceMembershipInvalidError) {
        return {
          schemaVersion: 1,
          phase: 'preflight',
          disposition: 'no-go',
          code: 'source-membership-invalid',
          claudeCodeActiveToken: token,
        };
      }
      throw new Error('preflight-failed');
    }
  } finally {
    db.close();
  }
}

export function formatAnthropicPreflight(receipt: AnthropicPreflightReceipt, json: boolean): string {
  const body: Record<string, unknown> = {
    schemaVersion: receipt.schemaVersion,
    phase: receipt.phase,
    disposition: receipt.disposition,
  };
  if (receipt.code !== undefined) body.code = receipt.code;
  if (receipt.pool !== undefined) body.pool = receipt.pool;
  body.claudeCodeActiveToken = receipt.claudeCodeActiveToken;
  if (receipt.count !== undefined) body.count = receipt.count;
  if (receipt.aliases !== undefined) body.aliases = receipt.aliases.slice();
  if (receipt.members !== undefined) body.members = receipt.members.map(memberView);
  if (json) return JSON.stringify(body, null, 2);
  const lines = [
    `schema: ${body.schemaVersion}`,
    `phase: ${body.phase}`,
    `disposition: ${body.disposition}`,
  ];
  if (typeof body.code === 'string') lines.push(`code: ${body.code}`);
  if (typeof body.pool === 'string') lines.push(`pool: ${body.pool}`);
  lines.push(`claudeCodeActiveToken: ${body.claudeCodeActiveToken}`);
  if (typeof body.count === 'number') lines.push(`count: ${body.count}`);
  if (Array.isArray(body.aliases)) lines.push(`aliases: ${body.aliases.join(',')}`);
  if (Array.isArray(body.members)) {
    lines.push(`members: ${body.members.map((member) => {
      const row = member as PreflightMember;
      return `${row.alias} identityKind=${row.identityKind} slot=${row.slot} expiry=${row.expiry} active=${row.active}`;
    }).join(';')}`);
  }
  return lines.join('\n');
}
