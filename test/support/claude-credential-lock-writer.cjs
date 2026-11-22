'use strict';
// Test-only stand-in for Claude Code's credential writer (AC36). It takes
// Claude Code's two proper-lockfile credential lock directories the way
// Claude Code does (mkdir; EEXIST means another holder), writes the live
// item into a FileKeychain-format JSON file, and releases. It never touches
// QLB's switch lock.
//
// argv: <oauthRefreshLockDir> <credentialsLockDir> <keychainPath> <service> <account> <value>
// stdout lines: `contended` (first EEXIST seen), `acquired`, `written`.
const { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } = require('node:fs');

const [oauthLockDir, credentialsLockDir, keychainPath, service, account, value] = process.argv.slice(2);
let reportedContention = false;

function contended() {
  if (!reportedContention) process.stdout.write('contended\n');
  reportedContention = true;
  return false;
}

function tryAcquire() {
  try { mkdirSync(oauthLockDir); } catch (error) {
    if (error.code === 'EEXIST') return contended();
    throw error;
  }
  try { mkdirSync(credentialsLockDir); } catch (error) {
    rmdirSync(oauthLockDir);
    if (error.code === 'EEXIST') return contended();
    throw error;
  }
  return true;
}

function writeLiveItem() {
  let items = {};
  try { items = JSON.parse(readFileSync(keychainPath, 'utf8')); } catch { items = {}; }
  items[`${service}\0${account}`] = value;
  const temporary = `${keychainPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(items), { mode: 0o600 });
  renameSync(temporary, keychainPath);
}

function attempt() {
  if (!tryAcquire()) {
    setTimeout(attempt, 10);
    return;
  }
  process.stdout.write('acquired\n');
  try {
    writeLiveItem();
  } finally {
    rmdirSync(credentialsLockDir);
    rmdirSync(oauthLockDir);
  }
  process.stdout.write('written\n');
}

attempt();
