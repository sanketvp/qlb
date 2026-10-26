/*
 * Ported from claude-swap 0.28.0.
 * Upstream file(s): src/claude_swap/paths.py:37-100.
 * License: MIT.
 * Modified for QLB. See NOTICE.
 */

import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { qlbHomeDir } from './home';

export const CLAUDE_CODE_CREDENTIALS_SERVICE = 'Claude Code-credentials';

export interface ClaudePathOptions {
  /** Explicit test/caller home; takes precedence over HOME. */
  home?: string;
  /** Explicit test/caller environment; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface ClaudePaths {
  configHome: string;
  credentialsPath: string;
  globalConfigPath: string;
  keychainService: string;
}

function environment(options: ClaudePathOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function resolvedHome(options: ClaudePathOptions): string {
  if (options.home) return options.home;
  const env = environment(options);
  if (env.QLB_TEST_MODE === '1') return qlbHomeDir(env);
  return env.HOME || qlbHomeDir(env);
}

/** Claude Code config home: CLAUDE_CONFIG_DIR when non-empty, otherwise ~/.claude. */
export function claudeConfigHome(options: ClaudePathOptions = {}): string {
  const configured = environment(options).CLAUDE_CONFIG_DIR;
  return configured ? configured : join(resolvedHome(options), '.claude');
}

/** Claude Code plaintext credential file for the active config profile. */
export function credentialsPath(options: ClaudePathOptions = {}): string {
  return join(claudeConfigHome(options), '.credentials.json');
}

/**
 * Claude Code 2.1.299's legacy config selection: a regular, non-empty
 * .config.json wins; an empty legacy file wins only while writable and the
 * ordinary global file is absent. Any filesystem error selects the global file.
 */
export function globalConfigPath(options: ClaudePathOptions = {}): string {
  const env = environment(options);
  const home = resolvedHome(options);
  const configHome = claudeConfigHome(options);
  const configured = env.CLAUDE_CONFIG_DIR;
  const global = join(configured || home, '.claude.json');
  const legacy = join(configHome, '.config.json');
  try {
    const metadata = statSync(legacy);
    if (metadata.isFile() && (metadata.size > 0 || ((metadata.mode & 0o222) !== 0 && !existsSync(global)))) {
      return legacy;
    }
  } catch {
    // Claude Code treats inaccessible and missing legacy paths as absent.
  }
  return global;
}

/**
 * Service selected by Claude Code for the configured secure-storage profile.
 * An unset or empty CLAUDE_CONFIG_DIR uses the unsuffixed default service.
 */
export function keychainServiceName(options: ClaudePathOptions = {}): string {
  const configDir = environment(options).CLAUDE_CONFIG_DIR;
  if (!configDir) return CLAUDE_CODE_CREDENTIALS_SERVICE;
  // Claude Code hashes the raw exported spelling after NFC normalization; do
  // not resolve it, because symlink/trailing-slash spellings remain significant.
  const suffix = createHash('sha256').update(configDir.normalize('NFC'), 'utf8').digest('hex').slice(0, 8);
  return `${CLAUDE_CODE_CREDENTIALS_SERVICE}-${suffix}`;
}

export function claudePaths(options: ClaudePathOptions = {}): ClaudePaths {
  return {
    configHome: claudeConfigHome(options),
    credentialsPath: credentialsPath(options),
    globalConfigPath: globalConfigPath(options),
    keychainService: keychainServiceName(options),
  };
}
