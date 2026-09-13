'use strict';

const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * A real v4 QLB store: full schema after migrateIfNeeded reaches user_version=4,
 * with the v4 `decisions` DDL (store.ts CREATE TABLE, no strategy/provider).
 * The only hand-shaped decision rows in the suite — production can no longer
 * write pre-strategy/provider rows.
 */
function buildV4Store(path, rows = []) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      provider TEXT,
      label TEXT,
      status TEXT,
      created_at INTEGER,
      grant_generation INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      account_id TEXT,
      bucket TEXT,
      used_pct REAL,
      used REAL,
      limit_val REAL,
      remaining REAL,
      reset_at INTEGER,
      fetched_at INTEGER,
      source TEXT,
      confidence TEXT,
      PRIMARY KEY (account_id, bucket)
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      session TEXT,
      harness TEXT,
      requested_model TEXT,
      effort TEXT,
      served_model TEXT,
      account_id TEXT,
      mode TEXT,
      reason TEXT,
      snapshot_json TEXT
    );
    CREATE TABLE IF NOT EXISTS overrides (
      kind TEXT,
      account_id TEXT,
      session TEXT,
      until INTEGER
    );
    CREATE TABLE IF NOT EXISTS poll_claims (
      account_id TEXT PRIMARY KEY,
      holder_id TEXT,
      claimed_at INTEGER,
      until INTEGER
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS leases (
      name TEXT PRIMARY KEY,
      holder_pid INTEGER,
      holder_id TEXT,
      until INTEGER,
      generation INTEGER
    );
    CREATE TABLE IF NOT EXISTS migrations (
      store TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      detail_json TEXT
    );
    CREATE TABLE IF NOT EXISTS policies (
      harness TEXT,
      virtual_model TEXT,
      real_model TEXT,
      effort TEXT,
      fallback_json TEXT,
      session_mode TEXT,
      created_at INTEGER,
      PRIMARY KEY (harness, virtual_model)
    );
  `);
  db.exec('PRAGMA user_version = 4');
  const insert = db.prepare(`
    INSERT INTO decisions (
      ts, session, harness, requested_model, effort, served_model,
      account_id, mode, reason, snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAccount = db.prepare(`
    INSERT INTO accounts (id, provider, label, status, created_at)
    VALUES (?, ?, ?, 'active', ?)
  `);
  for (const row of rows) {
    if (row.account_id && row.account_provider) {
      try {
        insertAccount.run(row.account_id, row.account_provider, row.account_id, Date.now());
      } catch {
        // ignore duplicate account
      }
    }
    insert.run(
      row.ts ?? Date.now(),
      row.session ?? null,
      row.harness ?? null,
      row.requested_model ?? 'claude-sonnet-5',
      row.effort ?? null,
      row.served_model ?? null,
      row.account_id ?? null,
      row.mode ?? 'headroom',
      row.reason ?? 'ok',
      row.snapshot_json ?? '{}',
    );
  }
  db.close();
  return path;
}

module.exports = { buildV4Store };
