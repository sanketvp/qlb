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

export function piOwnerDocumentTarget(home: string): string {
  return join(home, '.pi', 'agent', 'src', 'pi-owner-document.ts');
}

export function piDeploymentDigest(extension: string, redact: string, ownerDocument: string): string {
  return createHash('sha256')
    .update(releaseDigest(extension))
    .update('\0src/redact.ts\0')
    .update(readFileSync(redact))
    .update('\0src/pi-owner-document.ts\0')
    .update(readFileSync(ownerDocument))
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
  const ownerDocument = join(appDir, sha, 'src', 'pi-owner-document.ts');
  try {
    if (!lstatSync(ownerDocument).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`current release does not contain pi-owner-document.ts at ${ownerDocument}`);
  }
  return { source, target: piExtensionTarget(home), hash: piDeploymentDigest(source, redact, ownerDocument) };
}

function sweepStaging(stagingRoot: string, extensionParent: string): void {
  for (const dir of [stagingRoot, extensionParent]) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        // Shared-source temp files live only in stagingRoot; never sweep their prefixes from Pi's extensions dir.
        if (entry.name.startsWith('.qlb-pi-') || (dir === stagingRoot && (entry.name.startsWith('.redact-') || entry.name.startsWith('.owner-document-')))) {
          rmSync(join(dir, entry.name), { recursive: true, force: true });
        }
      }
    } catch {
      // A missing directory has no stale staging entries to remove.
    }
  }
}

/**
 * Publishes the extension and its shared source files from staging outside extensions/.
 * Existing complete targets are restored if any publish rename fails.
 */
function replaceDeployment(
  source: string,
  redactSource: string,
  ownerDocumentSource: string,
  target: string,
  redactTarget: string,
  ownerDocumentTarget: string,
  rename: typeof renameSync,
): void {
  const agentDir = dirname(dirname(target));
  const extensionParent = dirname(target);
  const stagingRoot = join(agentDir, '.qlb-pi-staging');
  const nonce = `${process.pid}-${Date.now()}`;
  const staging = join(stagingRoot, `.qlb-pi-${nonce}.tmp`);
  const stagedRedact = join(stagingRoot, `.redact-${nonce}.tmp`);
  const stagedOwnerDocument = join(stagingRoot, `.owner-document-${nonce}.tmp`);
  const previous = join(stagingRoot, `.qlb-pi-${nonce}.previous`);
  const previousRedact = join(stagingRoot, `.redact-${nonce}.previous`);
  const previousOwnerDocument = join(stagingRoot, `.owner-document-${nonce}.previous`);
  let movedPrevious = false;
  let movedPreviousRedact = false;
  let movedPreviousOwnerDocument = false;
  let publishedExtension = false;
  let publishedRedact = false;
  let publishedOwnerDocument = false;
  let published = false;
  try {
    mkdirSync(extensionParent, { recursive: true, mode: 0o755 });
    mkdirSync(dirname(redactTarget), { recursive: true, mode: 0o755 });
    mkdirSync(dirname(ownerDocumentTarget), { recursive: true, mode: 0o755 });
    mkdirSync(stagingRoot, { recursive: true, mode: 0o755 });
    sweepStaging(stagingRoot, extensionParent);
    cpSync(source, staging, { recursive: true, dereference: true, errorOnExist: true, force: false });
    cpSync(redactSource, stagedRedact, { dereference: true, errorOnExist: true, force: false });
    cpSync(ownerDocumentSource, stagedOwnerDocument, { dereference: true, errorOnExist: true, force: false });
    if (existsSync(target)) { rename(target, previous); movedPrevious = true; }
    if (existsSync(redactTarget)) { rename(redactTarget, previousRedact); movedPreviousRedact = true; }
    if (existsSync(ownerDocumentTarget)) { rename(ownerDocumentTarget, previousOwnerDocument); movedPreviousOwnerDocument = true; }
    rename(staging, target);
    publishedExtension = true;
    rename(stagedRedact, redactTarget);
    publishedRedact = true;
    rename(stagedOwnerDocument, ownerDocumentTarget);
    publishedOwnerDocument = true;
    published = true;
  } catch (err) {
    // Restore the extension before its shared source files so a second publish
    // failure cannot leave a new extension paired with prior schema rules.
    try {
      if (publishedExtension && existsSync(target)) rmSync(target, { recursive: true, force: true });
      if (movedPrevious && existsSync(previous)) rename(previous, target);
    } catch { /* Preserve the original error. */ }
    try {
      if (publishedRedact && existsSync(redactTarget)) rmSync(redactTarget, { recursive: true, force: true });
      if (movedPreviousRedact && existsSync(previousRedact)) rename(previousRedact, redactTarget);
    } catch { /* Preserve the original error. */ }
    try {
      if (publishedOwnerDocument && existsSync(ownerDocumentTarget)) rmSync(ownerDocumentTarget, { recursive: true, force: true });
      if (movedPreviousOwnerDocument && existsSync(previousOwnerDocument)) rename(previousOwnerDocument, ownerDocumentTarget);
    } catch { /* Preserve the original error. */ }
    throw err;
  } finally {
    for (const path of [staging, stagedRedact, stagedOwnerDocument]) if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    if (published) {
      for (const path of [previous, previousRedact, previousOwnerDocument]) if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
  }
}

/** Copies the extension from the installed release and records its deployed bytes. */
export function deployPiExtension(options: PiDeployOptions): PiDeployResult {
  const plan = piDeployPlan(options);
  if (options.dryRun) return { ...plan, dryRun: true };

  const releaseRoot = dirname(dirname(plan.source));
  const redactSource = join(releaseRoot, 'src', 'redact.ts');
  const ownerDocumentSource = join(releaseRoot, 'src', 'pi-owner-document.ts');
  const home = options.home ?? qlbHomeDir();
  replaceDeployment(
    plan.source,
    redactSource,
    ownerDocumentSource,
    plan.target,
    piRedactTarget(home),
    piOwnerDocumentTarget(home),
    options.rename ?? renameSync,
  );
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
