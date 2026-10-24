import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Derived from the module mapping table in spec §3.1 (D1 / AC42).
const PORTED_MODULES = [
  ['src/fsutil.ts', ['src/claude_swap/fsutil.py']],
  ['src/cc-locks.ts', ['src/claude_swap/claude_locks.py']],
  ['src/keychain.ts', ['src/claude_swap/macos_keychain.py']],
  ['src/anthropic-oauth.ts', ['src/claude_swap/oauth.py']],
  ['src/lines.ts', ['src/claude_swap/lines.py']],
  ['src/poll-policy.ts', ['src/claude_swap/poll_policy.py', 'src/claude_swap/usage_store.py']],
  ['src/auto.ts', ['src/claude_swap/autoswitch.py', 'src/claude_swap/launch_agent.py']],
];

function expectedHeader(upstreamFiles) {
  return [
    '/*',
    ' * Ported from claude-swap v0.28.0.',
    ` * Upstream file(s): ${upstreamFiles.join(', ')}.`,
    ' * License: MIT.',
    ' * Modified for QLB. See NOTICE.',
    ' */',
  ].join('\n');
}

const missing = PORTED_MODULES
  .filter(([path, upstreamFiles]) => !readFileSync(join(root, path), 'utf8').startsWith(expectedHeader(upstreamFiles)))
  .map(([path]) => path);

for (const path of missing) console.log(path);
console.log(`${missing.length} missing`);
process.exitCode = missing.length === 0 ? 0 : 1;
