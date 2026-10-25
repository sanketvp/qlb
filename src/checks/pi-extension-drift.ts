import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';

import type { DoctorCheck } from '../diagnostics';
import { qlbHomeDir } from '../home';
import { piDeployPlan, piDeploymentDigest, piExtensionTarget, piRedactTarget, piReleaseAppDir } from '../pi-deploy';
import { check } from './_check';

export default check('pi:extension-drift');

export interface PiExtensionDriftOptions {
  home?: string;
  appDir?: string;
  dbPath: string;
}

/** Compares the installed extension bytes with the extension in `app/current`. */
export function piExtensionDriftCheck(options: PiExtensionDriftOptions): DoctorCheck {
  if (!existsSync(options.dbPath)) {
    return { name: 'pi:extension-drift', level: 'WARN', message: 'unknown: qlb has not recorded a Pi deployment' };
  }
  let deployedAt: string | null = null;
  let recordedHash: string | null = null;
  try {
    const db = new DatabaseSync(options.dbPath, { readOnly: true });
    try {
      deployedAt = (db.prepare('SELECT value FROM config WHERE key = ?').get('pi.deployedAt') as { value?: unknown } | undefined)?.value as string | null;
      recordedHash = (db.prepare('SELECT value FROM config WHERE key = ?').get('pi.extensionHash') as { value?: unknown } | undefined)?.value as string | null;
    } finally {
      db.close();
    }
  } catch {
    return { name: 'pi:extension-drift', level: 'WARN', message: 'unknown: unable to read Pi deployment record' };
  }
  if (typeof deployedAt !== 'string' || deployedAt.length === 0) {
    return { name: 'pi:extension-drift', level: 'WARN', message: 'not deployed' };
  }

  const home = options.home ?? qlbHomeDir();
  let plan: ReturnType<typeof piDeployPlan>;
  try {
    plan = piDeployPlan({ home, appDir: options.appDir ?? piReleaseAppDir(home) });
  } catch (err) {
    return { name: 'pi:extension-drift', level: 'WARN', message: `unknown: ${err instanceof Error ? err.message : String(err)}` };
  }
  const target = piExtensionTarget(home);
  const redactTarget = piRedactTarget(home);
  try {
    if (!lstatSync(target).isDirectory()) throw new Error('installed extension is not a directory');
    if (!lstatSync(redactTarget).isFile()) throw new Error('installed redact.ts is not a file');
    const legacyEntries = readdirSync(dirname(target), { withFileTypes: true })
      .filter((entry) => entry.name.startsWith('.qlb-pi-'));
    if (legacyEntries.length > 0) {
      return {
        name: 'pi:extension-drift', level: 'FAIL',
        message: 'legacy qlb-pi staging directories are present in extensions',
        detail: { entries: legacyEntries.map((entry) => entry.name) },
      };
    }
    const installedHash = piDeploymentDigest(target, redactTarget);
    if (installedHash !== plan.hash || recordedHash !== plan.hash) {
      return {
        name: 'pi:extension-drift', level: 'FAIL',
        message: 'installed qlb-pi deployment hash differs from the current release',
        detail: { expectedHash: plan.hash, recordedHash, installedHash },
      };
    }
    return {
      name: 'pi:extension-drift', level: 'PASS',
      message: 'installed qlb-pi deployment hash matches the current release',
      detail: { hash: plan.hash },
    };
  } catch (err) {
    return {
      name: 'pi:extension-drift', level: 'FAIL',
      message: `installed qlb-pi is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
