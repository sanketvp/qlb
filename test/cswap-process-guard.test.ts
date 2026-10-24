import assert from 'node:assert/strict';
import test from 'node:test';

import { listCswapProcesses } from '../src/cswap-processes';

test('finds a process running from a claude-swap directory', () => {
  const processes = listCswapProcesses({
    runPs: () => ' 101 /opt/tools/claude-swap/bin/python auto.py\n',
  });

  assert.deepEqual(processes, [{ pid: 101 }]);
});

test('finds a process whose argv0 basename is cswap', () => {
  const processes = listCswapProcesses({
    runPs: () => ' 202 /usr/local/bin/cswap auto\n',
  });

  assert.deepEqual(processes, [{ pid: 202 }]);
});

test('ignores unrelated processes', () => {
  const processes = listCswapProcesses({
    runPs: () => [
      ' 303 /usr/local/bin/qlb auto',
      ' 404 node /opt/claude-swapper/index.js',
      ' 505 /usr/local/bin/not-cswap auto',
    ].join('\n'),
  });

  assert.deepEqual(processes, []);
});
