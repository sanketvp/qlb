import assert from 'node:assert/strict';
import type { execFileSync as ExecFileSync } from 'node:child_process';
import test from 'node:test';

import { CswapProcessCheckError, listCswapProcesses, listCswapProcessesToSignal } from '../src/cswap-processes';

const childProcess = require('node:child_process') as { execFileSync: typeof ExecFileSync };
const supportedPlatform: NodeJS.Platform = 'darwin';

test('finds a process running from a claude-swap directory', () => {
  const processes = listCswapProcesses({
    platform: supportedPlatform,
    runPs: () => [
      ' 101 /opt/tools/claude-swap/bin/python auto.py',
      ' 102 /Users/example/.local/share/uv/tools/claude-swap/bin/python /Users/example/.local/bin/cswap auto',
    ].join('\n'),
  });

  assert.deepEqual(processes, [{ pid: 101 }, { pid: 102 }]);
});

test('finds cswap and claude-swap executable paths, including paths with spaces', () => {
  const processes = listCswapProcesses({
    platform: supportedPlatform,
    runPs: () => [
      ' 202 /usr/local/bin/cswap auto',
      ' 203 /usr/local/bin/claude-swap auto',
      ' 204 /Applications/Claude Swap/claude-swap auto',
    ].join('\n'),
  });

  assert.deepEqual(processes, [{ pid: 202 }, { pid: 203 }, { pid: 204 }]);
});

test('finds Python-launched cswap scripts and claude_swap modules', () => {
  const processes = listCswapProcesses({
    platform: supportedPlatform,
    runPs: () => [
      ' 432 /usr/bin/python3 /usr/local/bin/cswap auto',
      ' 433 python3 -u cswap status',
      ' 434 /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python /usr/local/bin/cswap auto',
      ' 435 python3 -m claude_swap.cli list',
      ' 436 /Applications/Python Framework/Python -m claude_swap.cli list',
      ' 437 /usr/bin/python3 --check-hash-based-pycs always cswap auto',
      ' 438 /usr/bin/python3 --check-hash-based-pycs=always cswap auto',
      ' 439 /usr/bin/python3 -mclaude_swap auto',
      ' 440 /usr/bin/python3 -mclaude_swap.cli auto',
      ' 441 /usr/bin/python3 -um claude_swap.cli auto',
      ' 442 /usr/bin/python3 -Em claude_swap auto',
      ' 443 /usr/bin/python3 -Imclaude_swap auto',
    ].join('\n'),
  });

  assert.deepEqual(processes, [
    { pid: 432 }, { pid: 433 }, { pid: 434 }, { pid: 435 }, { pid: 436 },
    { pid: 437 }, { pid: 438 }, { pid: 439 }, { pid: 440 }, { pid: 441 },
    { pid: 442 }, { pid: 443 },
  ]);
});

test('ignores unrelated processes', () => {
  const processes = listCswapProcesses({
    platform: supportedPlatform,
    runPs: () => [
      ' 303 /usr/local/bin/qlb auto',
      ' 404 node /opt/claude-swapper/index.js',
      ' 505 /usr/local/bin/not-cswap auto',
      ' 606 vim notes-about-cswap.txt',
      ' 707 grep cswap',
      ' 808 python -W cswap /path/other-script',
      ' 909 python -m other_module cswap',
      ' 1001 node -m claude_swap.cli list',
      ' 1002 python3 -um json.tool',
      ' 1003 python3 -Wm claude_swap',
      ' 1004 python3 -Xm claude_swap',
    ].join('\n'),
  });

  assert.deepEqual(processes, []);
});

test('throws CswapProcessCheckError when ps fails', () => {
  assert.throws(
    () => listCswapProcesses({ platform: supportedPlatform, runPs: () => { throw new Error('ps failed'); } }),
    CswapProcessCheckError,
  );
});

test('throws CswapProcessCheckError when ps times out', () => {
  assert.throws(
    () => listCswapProcesses({
      platform: supportedPlatform,
      runPs: () => { throw Object.assign(new Error('ps timed out'), { code: 'ETIMEDOUT' }); },
    }),
    CswapProcessCheckError,
  );
});

test('throws CswapProcessCheckError when ps returns an empty table', () => {
  assert.throws(
    () => listCswapProcesses({ platform: supportedPlatform, runPs: () => '' }),
    CswapProcessCheckError,
  );
});

test('uses a large buffer and unlimited-width ps output on Linux', () => {
  const originalExecFileSync = childProcess.execFileSync;
  let invocation: { file: string; args: readonly string[]; options: unknown } | undefined;

  childProcess.execFileSync = ((file: string, args: readonly string[], options: unknown) => {
    invocation = { file, args, options };
    return ' 501 /usr/local/bin/qlb auto';
  }) as typeof ExecFileSync;

  try {
    assert.deepEqual(listCswapProcesses({ platform: 'linux' }), []);
  } finally {
    childProcess.execFileSync = originalExecFileSync;
  }

  assert.deepEqual(invocation?.args, ['-ww', '-ax', '-o', 'pid=,args=']);
  assert.equal(invocation?.file, '/bin/ps');
  assert.equal((invocation?.options as { maxBuffer?: number }).maxBuffer, 64 * 1024 * 1024);
});

test('strict signal lister accepts only positively identified C-swap processes', () => {
  const processes = listCswapProcessesToSignal({
    platform: supportedPlatform,
    runPs: () => [
      ' 101 /usr/local/bin/cswap',
      ' 102 claude-swap --daemon',
      ' 103 python3 /opt/claude-swap/bin/cswap',
      ' 104 python3 -m claude_swap.daemon',
      ' 201 python3 worker.py /tmp/cswap',
      ' 202 vim /tmp/cswap',
      ' 203 tail -f ~/cswap',
      ' 204 python3 -u worker.py cswap',
    ].join('\n'),
  });

  assert.deepEqual(processes, [{ pid: 101 }, { pid: 102 }, { pid: 103 }, { pid: 104 }]);
});

test('strict signal lister throws CswapProcessCheckError when ps returns an empty table', () => {
  assert.throws(
    () => listCswapProcessesToSignal({ platform: supportedPlatform, runPs: () => '' }),
    CswapProcessCheckError,
  );
});

test('throws CswapProcessCheckError on unsupported platforms', () => {
  assert.throws(
    () => listCswapProcesses({
      platform: 'win32',
      runPs: () => { throw new Error('runPs should not be called'); },
    }),
    CswapProcessCheckError,
  );
});
