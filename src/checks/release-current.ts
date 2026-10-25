import type { DoctorCheck } from '../diagnostics';
import { currentReleaseSha } from '../release';
import { check } from './_check';

export default check('release:current');

export interface ReleaseCurrentInput {
  appDir: string;
  lifecycleReleaseSha: string | null;
}

/** Compares the deployed target to the SHA recorded when cutover began. */
export function releaseCurrentCheck(input: ReleaseCurrentInput): DoctorCheck {
  const current = currentReleaseSha(input.appDir);
  if (!input.lifecycleReleaseSha) {
    return { name: 'release:current', level: 'PASS', message: 'no lifecycle release is recorded' };
  }
  if (current === input.lifecycleReleaseSha) {
    return { name: 'release:current', level: 'PASS', message: `current release matches lifecycle SHA ${current}` };
  }
  return {
    name: 'release:current',
    level: 'WARN',
    message: `current release ${current ?? 'missing'} differs from lifecycle SHA ${input.lifecycleReleaseSha}`,
  };
}
