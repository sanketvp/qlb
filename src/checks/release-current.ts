import { join } from 'node:path';

import type { DoctorCheck } from '../diagnostics';
import { currentReleaseSha, readReleaseManifest, releaseDigest } from '../release';
import { check } from './_check';

export default check('release:current');

export interface ReleaseCurrentInput {
  appDir: string;
  lifecycleReleaseSha: string | null;
  /** Digest recorded with the lifecycle release, when available. */
  lifecycleReleaseDigest?: string | null;
}

/** Compares the deployed target and its immutable bytes to the recorded release. */
export function releaseCurrentCheck(input: ReleaseCurrentInput): DoctorCheck {
  const current = currentReleaseSha(input.appDir);
  if (!input.lifecycleReleaseSha) {
    return { name: 'release:current', level: 'PASS', message: 'no lifecycle release is recorded' };
  }
  if (current !== input.lifecycleReleaseSha) {
    return {
      name: 'release:current',
      level: 'WARN',
      message: `current release ${current ?? 'missing'} differs from lifecycle SHA ${input.lifecycleReleaseSha}`,
    };
  }

  const manifest = readReleaseManifest(join(input.appDir, current));
  if (!manifest || manifest.sha !== current || manifest.digest !== releaseDigest(join(input.appDir, current))) {
    return { name: 'release:current', level: 'WARN', message: `current release ${current} bytes do not match its manifest` };
  }
  if (input.lifecycleReleaseDigest && manifest.digest !== input.lifecycleReleaseDigest) {
    return { name: 'release:current', level: 'WARN', message: `current release ${current} digest differs from lifecycle release` };
  }
  return { name: 'release:current', level: 'PASS', message: `current release matches lifecycle SHA ${current} and digest` };
}
