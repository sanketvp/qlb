import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Derived from the module mapping table in spec §3.1 (D1 / AC42).
const PORTED_MODULES = [
  ['src/fsutil.ts', [['src/claude_swap/fsutil.py', '134-246']]],
  ['src/cc-locks.ts', [['src/claude_swap/claude_locks.py', '46-70,75-93,94-127,129-197']]],
  ['src/keychain.ts', [['src/claude_swap/macos_keychain.py', '1-14,160-205']]],
  ['src/anthropic-oauth.ts', [['src/claude_swap/oauth.py', '44-70,95-101,105-140,154-167,211-226']]],
  ['src/lines.ts', [['src/claude_swap/lines.py', '39-64,88-126']]],
  ['src/poll-policy.ts', [
    ['src/claude_swap/poll_policy.py', '76-262'],
    ['src/claude_swap/usage_store.py', '439-491'],
  ]],
  ['src/auto.ts', [
    ['src/claude_swap/autoswitch.py', '98-158,161-200,1120-1620,2080-2324'],
    ['src/claude_swap/launch_agent.py', '140-145'],
  ]],
];

function expectedHeader(upstreamFiles) {
  return [
    '/*',
    ' * Ported from claude-swap 0.28.0.',
    ` * Upstream file(s): ${upstreamFiles.map(([path, ranges]) => `${path}:${ranges}`).join(', ')}.`,
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
