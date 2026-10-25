import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
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
  /** Injectable filesystem rename for failure-path tests. */
  rename?: typeof renameSync;
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

export function piRedactTarget(home: string): string {
  return join(home, '.pi', 'agent', 'src', 'redact.ts');
}

export function piDeploymentDigest(extension: string, redact: string): string {
  return createHash('sha256')
    .update(releaseDigest(extension))
    .update('\0src/redact.ts\0')
    .update(readFileSync(redact))
    .digest('hex');
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
  const redact = join(appDir, sha, 'src', 'redact.ts');
  try {
    if (!lstatSync(redact).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`current release does not contain redact.ts at ${redact}`);
  }
  return { source, target: piExtensionTarget(home), hash: piDeploymentDigest(source, redact) };
}

function sweepStaging(stagingRoot: string, extensionParent: string): void {
  for (const dir of [stagingRoot, extensionParent]) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.qlb-pi-') || entry.name.startsWith('.redact-')) {
          rmSync(join(dir, entry.name), { recursive: true, force: true });
        }
      }
    } catch {
      // A missing directory has no stale staging entries to remove.
    }
  }
}

/**
 * Publishes the extension and its sibling redactor from staging outside extensions/.
 * Existing complete targets are restored if either publish rename fails.
 */
function replaceDeployment(source: string, redactSource: string, target: string, redactTarget: string, rename: typeof renameSync): void {
  const agentDir = dirname(dirname(target));
  const extensionParent = dirname(target);
  const stagingRoot = join(agentDir, '.qlb-pi-staging');
  const nonce = `${process.pid}-${Date.now()}`;
  const staging = join(stagingRoot, `.qlb-pi-${nonce}.tmp`);
  const stagedRedact = join(stagingRoot, `.redact-${nonce}.tmp`);
  const previous = join(stagingRoot, `.qlb-pi-${nonce}.previous`);
  const previousRedact = join(stagingRoot, `.redact-${nonce}.previous`);
  let movedPrevious = false;
  let movedPreviousRedact = false;
  let publishedExtension = false;
  let publishedRedact = false;
  let published = false;
  try {
    mkdirSync(extensionParent, { recursive: true, mode: 0o755 });
    mkdirSync(dirname(redactTarget), { recursive: true, mode: 0o755 });
    mkdirSync(stagingRoot, { recursive: true, mode: 0o755 });
    sweepStaging(stagingRoot, extensionParent);
    cpSync(source, staging, { recursive: true, dereference: true, errorOnExist: true, force: false });
    cpSync(redactSource, stagedRedact, { dereference: true, errorOnExist: true, force: false });
    if (existsSync(target)) { rename(target, previous); movedPrevious = true; }
    if (existsSync(redactTarget)) { rename(redactTarget, previousRedact); movedPreviousRedact = true; }
    rename(staging, target);
    publishedExtension = true;
    rename(stagedRedact, redactTarget);
    publishedRedact = true;
    published = true;
  } catch (err) {
    // Restore the extension before the redactor so a second publish failure
    // cannot leave the new extension paired with the prior redactor.
    try {
      if (publishedExtension && existsSync(target)) rmSync(target, { recursive: true, force: true });
      if (movedPrevious && existsSync(previous)) rename(previous, target);
    } catch { /* Preserve the original error. */ }
    try {
      if (publishedRedact && existsSync(redactTarget)) rmSync(redactTarget, { recursive: true, force: true });
      if (movedPreviousRedact && existsSync(previousRedact)) rename(previousRedact, redactTarget);
    } catch { /* Preserve the original error. */ }
    throw err;
  } finally {
    for (const path of [staging, stagedRedact]) if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    if (published) {
      for (const path of [previous, previousRedact]) if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
  }
}

/** Copies the extension from the installed release and records its deployed bytes. */
export function deployPiExtension(options: PiDeployOptions): PiDeployResult {
  const plan = piDeployPlan(options);
  if (options.dryRun) return { ...plan, dryRun: true };

  const redactSource = join(dirname(dirname(plan.source)), 'src', 'redact.ts');
  replaceDeployment(plan.source, redactSource, plan.target, piRedactTarget(options.home ?? qlbHomeDir()), options.rename ?? renameSync);
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
