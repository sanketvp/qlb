import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Leaf module: imports nothing from QLB, so credential-backends can use it
// without a load-order cycle through diagnostics.

export interface HelperSigningState {
  authority: string;
  binaryHash: string;
  identityHash: string;
}

/** Injectable only to parse captured `codesign` output in hermetic tests. */
export type CodesignSpawn = (
  command: string,
  args: string[],
  options: { encoding: 'utf8' },
) => { status: number | null; stdout?: string | Buffer; stderr?: string | Buffer };

/** Validates the code signature and reads its metadata; no Keychain values are read. */
export function inspectHelperSigning(
  path: string,
  spawn: CodesignSpawn = spawnSync,
): HelperSigningState | null {
  if (!existsSync(path)) return null;
  const verification = spawn('/usr/bin/codesign', ['--verify', '--strict', path], { encoding: 'utf8' });
  if (verification.status !== 0) return null;
  // Authority needs -vv and CDHash needs -vvv on current macOS codesign output.
  const result = spawn('/usr/bin/codesign', ['-d', '-vvv', '-r-', path], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const details = `${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`;
  const authority = /^Authority=(.+)$/m.exec(details)?.[1]?.trim();
  const binaryHash = /^CDHash=([0-9a-fA-F]+)$/m.exec(details)?.[1]?.toLowerCase();
  const identityHash = /certificate leaf = H"([0-9a-fA-F]{40})"/.exec(details)?.[1]?.toLowerCase();
  return authority && binaryHash && identityHash ? { authority, binaryHash, identityHash } : null;
}

export type HelperIdentityVerification =
  | { trusted: true }
  | { trusted: false; reason: string };

/** Verifies the helper's exact pinned leaf identity using codesign's requirement evaluator. */
export function verifyHelperIdentity(
  path: string,
  pin: string,
  spawn: CodesignSpawn = spawnSync,
): HelperIdentityVerification {
  if (!/^[0-9a-fA-F]{40}$/.test(pin)) {
    return { trusted: false, reason: 'pinned helper identity is invalid' };
  }
  if (!existsSync(path)) return { trusted: false, reason: 'helper is missing' };
  try {
    const verification = spawn('/usr/bin/codesign', [
      '--verify', '--strict', '-R', `certificate leaf = H"${pin}"`, path,
    ], { encoding: 'utf8' });
    return verification.status === 0
      ? { trusted: true }
      : { trusted: false, reason: 'pinned leaf certificate did not verify' };
  } catch {
    return { trusted: false, reason: 'pinned leaf certificate did not verify' };
  }
}
