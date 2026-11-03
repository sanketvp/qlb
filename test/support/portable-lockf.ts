import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { KEYCHAIN_LOCKF_BIN } from '../../src/keychain-client';

export function portableLockf(dir: string): string {
  if (existsSync(KEYCHAIN_LOCKF_BIN)) return KEYCHAIN_LOCKF_BIN;
  const path = join(dir, 'lockf');
  writeFileSync(path, `#!/bin/sh
[ "$1" = -k ] && [ "$2" = -t ] && [ "$3" = 0 ] || exit 64
lock=$4; shift 4
exec /usr/bin/flock -n -o -E 75 "$lock" "$@"
`, { mode: 0o700 });
  return path;
}
