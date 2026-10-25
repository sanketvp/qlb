import { cpSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { qlbHomeDir } from './home';
import { currentReleaseSha, releaseDigest } from './release';
import { openStore } from './store';

export interface PiDeployPlan {
  source: string;
  target: string;
  hash: string;
}

export interface PiDeployOptions {
  home?: string;
  appDir?: string;
  dbPath: string;
  dryRun?: boolean;
  now?: () => number;
}

export interface PiDeployResult extends PiDeployPlan {
  deployedAt?: number;
  dryRun: boolean;
}

/** The disposable test release tree mirrors production's ~/.qlb/app layout. */
export function piReleaseAppDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.QLB_TEST_MODE === '1' && env.QLB_HOME
    ? join(home, 'app')
    : join(home, '.qlb', 'app');
}

export function piExtensionTarget(home: string): string {
  return join(home, '.pi', 'agent', 'extensions', 'qlb-pi');
}

/** Locates and hashes the extension built into the release selected by `current`. */
export function piDeployPlan(options: Pick<PiDeployOptions, 'home' | 'appDir'> = {}): PiDeployPlan {
  const home = options.home ?? qlbHomeDir();
  const appDir = options.appDir ?? piReleaseAppDir(home);
  const sha = currentReleaseSha(appDir);
  if (!sha) throw new Error(`current release is missing or invalid under ${appDir}; run qlb release install first`);
  const source = join(appDir, sha, 'extensions', 'qlb-pi');
  try {
    if (!lstatSync(source).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`current release does not contain qlb-pi at ${source}`);
  }
  return { source, target: piExtensionTarget(home), hash: releaseDigest(source) };
}

/**
 * Publishes a fully copied sibling staging directory by rename. POSIX cannot replace
 * a non-empty directory with one rename, so a previous complete tree is moved aside
 * and restored if publishing the complete staged tree fails; no partial tree is exposed.
 */
function replaceDirectory(source: string, target: string): void {
  const parent = dirname(target);
  const nonce = `${process.pid}-${Date.now()}`;
  const staging = join(parent, `.qlb-pi-${nonce}.tmp`);
  const previous = join(parent, `.qlb-pi-${nonce}.previous`);
  let movedPrevious = false;
  let published = false;
  try {
    mkdirSync(parent, { recursive: true, mode: 0o755 });
    cpSync(source, staging, { recursive: true, dereference: true, errorOnExist: true });
    if (existsSync(target)) {
      renameSync(target, previous);
      movedPrevious = true;
    }
    renameSync(staging, target);
    published = true;
  } catch (err) {
    if (movedPrevious && !existsSync(target) && existsSync(previous)) {
      try { renameSync(previous, target); } catch { /* Preserve the original error. */ }
    }
    throw err;
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    if (published && existsSync(previous)) rmSync(previous, { recursive: true, force: true });
  }
}

/** Copies the extension from the installed release and records its deployed bytes. */
export function deployPiExtension(options: PiDeployOptions): PiDeployResult {
  const plan = piDeployPlan(options);
  if (options.dryRun) return { ...plan, dryRun: true };

  replaceDirectory(plan.source, plan.target);
  const deployedAt = Math.floor((options.now ?? Date.now)() / 1000);
  const store = openStore(options.dbPath);
  try {
    store.setConfig('pi.deployedAt', String(deployedAt));
    store.setConfig('pi.extensionHash', plan.hash);
  } finally {
    store.close();
  }
  return { ...plan, deployedAt, dryRun: false };
}
