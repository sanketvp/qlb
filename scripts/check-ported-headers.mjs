import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Derived from the module mapping table in spec §3.1 (D1 / AC42).
const PORTED_MODULES = [
  ['src/fsutil.ts', [['src/claude_swap/fsutil.py', '106-131,134-246']]],
  ['src/cc-locks.ts', [['src/claude_swap/claude_locks.py', '46-70,75-93,94-127,129-197,198-228']]],
  ['src/anthropic-oauth.ts', [['src/claude_swap/oauth.py', '17-20,25-70,73-101,105-140,154-183,200-257,265-324,397-407,464-542'], ['src/claude_swap/autoswitch.py', '95-98,887-892']]],
  ['src/lines.ts', [['src/claude_swap/lines.py', '39-126']]],
  ['src/poll-policy.ts', [
    ['src/claude_swap/poll_policy.py', '76-285'],
    ['src/claude_swap/usage_store.py', '411-421,439-491'],
    ['src/claude_swap/lines.py', '39-45'],
    ['src/claude_swap/oauth.py', '545-601'],
  ]],
];

function expectedHeader(upstreamFiles) {
  const files = upstreamFiles.map(([path, ranges]) => `${path}:${ranges}`).join(', ');
  return readFileSync(join(root, 'docs', 'templates', 'ported-module-header.txt'), 'utf8')
    .replaceAll('\r\n', '\n')
    .replace('src/claude_swap/<path>.py:<first>-<last>', files);
}

const missing = PORTED_MODULES
  .filter(([path, upstreamFiles]) => !readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n').startsWith(expectedHeader(upstreamFiles)))
  .map(([path]) => path);

for (const path of missing) console.log(path);
console.log(`${missing.length} missing`);
process.exitCode = missing.length === 0 ? 0 : 1;
