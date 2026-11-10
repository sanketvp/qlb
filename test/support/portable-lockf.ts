import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { KEYCHAIN_LOCKF_BIN } from '../../src/keychain-client';

/**
 * Ubuntu 26.04's `date` is uutils. `%3N` strips leading zeros from the 9-digit
 * nanosecond field and then keeps three digits, so `date +%s%3N` runs up to
 * about a second ahead of the real millisecond clock. The wait script accepts
 * any all-digit stamp as milliseconds and then reports the deadline already
 * expired. Perl's Time::HiRes read is one clock, which is also the script's
 * own fallback when `date` is not numeric.
 */
export function portableLockf(dir: string): string {
  if (existsSync(KEYCHAIN_LOCKF_BIN)) return KEYCHAIN_LOCKF_BIN;
  const dateDir = join(dir, 'hires-date');
  mkdirSync(dateDir, { recursive: true, mode: 0o700 });
  const date = join(dateDir, 'date');
  writeFileSync(date, `#!/bin/sh
if [ "$1" = "+%s%3N" ]; then
  exec /usr/bin/perl -MTime::HiRes=time -e 'printf "%.0f\\n", time*1000'
fi
exec /usr/bin/date "$@"
`, { mode: 0o700 });
  chmodSync(date, 0o700);
  const path = join(dir, 'lockf');
  writeFileSync(path, `#!/bin/sh
[ "$1" = -k ] && [ "$2" = -t ] && [ "$3" = 0 ] || exit 64
lock=$4
shift 4
PATH='${dateDir}':$PATH
export PATH
exec /usr/bin/flock -n -o -E 75 "$lock" "$@"
`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}
