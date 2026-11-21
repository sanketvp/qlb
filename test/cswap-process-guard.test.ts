import assert from 'node:assert/strict';
import type { execFileSync as ExecFileSync } from 'node:child_process';
import test from 'node:test';

import { CswapProcessCheckError, isCswapCommandToSignal, listCswapProcesses, listCswapProcessesAsync, listCswapProcessesToSignal, listCswapProcessesToSignalAsync } from '../src/cswap-processes';

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
      ' 205 /opt/claude-swap/bin/python /srv/unrelated.py',
      ' 206 /opt/claude-swap/bin/worker',
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

test('async scans classify, time out and fail closed like the sync scans', async () => {
  const fixture = [
    ' 101 /usr/local/bin/cswap',
    ' 102 claude-swap --daemon',
    ' 103 python3 /opt/claude-swap/bin/cswap',
    ' 104 python3 -m claude_swap.daemon',
    ' 201 python3 worker.py /tmp/cswap',
    ' 202 vim /tmp/cswap',
    ' 203 tail -f ~/cswap',
    ' 204 python3 -u worker.py cswap',
    ' 205 /opt/claude-swap/bin/python /srv/unrelated.py',
    ' 206 /opt/claude-swap/bin/worker',
  ].join('\n');
  const syncLiveness = listCswapProcesses({ platform: supportedPlatform, runPs: () => fixture });
  const syncTargets = listCswapProcessesToSignal({ platform: supportedPlatform, runPs: () => fixture });
  assert.deepEqual(await listCswapProcessesAsync({ platform: supportedPlatform, runPs: async () => fixture }), syncLiveness);
  assert.deepEqual(await listCswapProcessesToSignalAsync({ platform: supportedPlatform, runPs: async () => fixture }), syncTargets);

  const timedOut = () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); };
  assert.throws(
    () => listCswapProcesses({ platform: supportedPlatform, runPs: timedOut }),
    (error: Error) => error instanceof CswapProcessCheckError && error.message === 'failed to inspect the process table',
  );
  await assert.rejects(
    listCswapProcessesAsync({ platform: supportedPlatform, runPs: async () => timedOut() }),
    (error: Error) => error instanceof CswapProcessCheckError && error.message === 'failed to inspect the process table',
  );
  assert.throws(
    () => listCswapProcessesToSignal({ platform: supportedPlatform, runPs: () => '' }),
    (error: Error) => error instanceof CswapProcessCheckError && error.message === 'process table was empty',
  );
  await assert.rejects(
    listCswapProcessesToSignalAsync({ platform: supportedPlatform, runPs: async () => '' }),
    (error: Error) => error instanceof CswapProcessCheckError && error.message === 'process table was empty',
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

// A14c: CPython short-option grammar for -c/-m/-W/-X.
// https://docs.python.org/3/using/cmdline.html#interface-options
const a14cNeverDetected = [
  'python3 -cm claude_swap',
  'python3 -mm claude_swap',
  'python3 -Xm claude_swap',
  'python3 -Wm claude_swap',
  '/usr/bin/python3 -Icm claude_swap auto',
  '/usr/bin/python3 -Imm claude_swap auto',
];

const a14cNotSignalTargets = [
  ...a14cNeverDetected,
  'python3 -c__import__("time").sleep(600) -m claude_swap',
  // The flattened ps form of python3 -IW 'ignore:message -m claude_swap' -c 'print(1)'.
  'python3 -IW ignore:message -m claude_swap -c print(1)',
  'python3 -c print(1) -m claude_swap',
  'python3 -Ic print(1) -m claude_swap',
];

const a14cDetected = [
  'python3 -Im claude_swap',
  'python3 -Bm claude_swap',
  'python3 -IBm claude_swap',
  'python3 -IWignore -m claude_swap',
  'python3 -um claude_swap',
  'python3 -Em claude_swap',
  'python3 -X importtime -m claude_swap',
  'python3 -W ignore -m claude_swap',
];

function psTable(commands: readonly string[]): string {
  return commands.map((command, index) => ` ${1000 + index} ${command}`).join('\n');
}

function pidsOf(commands: readonly string[]): { pid: number }[] {
  return commands.map((_, index) => ({ pid: 1000 + index }));
}

test('A14c: -c, -m, -W and -X consume their value before a later m', () => {
  for (const list of [listCswapProcesses, listCswapProcessesToSignal]) {
    assert.deepEqual(list({ platform: supportedPlatform, runPs: () => psTable(a14cNeverDetected) }), []);
  }
});

test('A14c: -c code and clustered -W with a separate value are never signal targets', () => {
  for (const command of a14cNotSignalTargets) {
    assert.equal(isCswapCommandToSignal(command), false, command);
  }
});

test('A14c: no-argument flags and attached or standalone -W/-X values still find -m claude_swap', () => {
  const runPs = () => psTable(a14cDetected);
  assert.deepEqual(listCswapProcesses({ platform: supportedPlatform, runPs }), pidsOf(a14cDetected));
  assert.deepEqual(listCswapProcessesToSignal({ platform: supportedPlatform, runPs }), pidsOf(a14cDetected));
});

// A verbatim copy of main's (2030710) strict signal classifier. The new
// classifier must never signal a process this one would not have signalled.
function mainPythonArguments(args: string): string | undefined {
  const interpreter = /(^|\/)python(?:\d+(?:\.\d+)*)?(?=\s|$)/i.exec(args);
  if (interpreter === null || interpreter.index === undefined) return undefined;
  return args.slice(interpreter.index + interpreter[0].length).trimStart();
}

function mainIsCswapModuleOption(args: string): boolean {
  const moduleOption = /^-([A-Za-z]*)m\s*claude_swap(\.|\s|$)/.exec(args);
  if (moduleOption === null) return false;
  return !/[WX]/.test(moduleOption[1]);
}

function mainStrictFirstPythonScriptIsCswap(args: string): boolean {
  let remaining = mainPythonArguments(args);
  if (remaining === undefined) return false;
  let option: RegExpExecArray | null;
  while (true) {
    if (mainIsCswapModuleOption(remaining)) return true;
    option = /^(?:(?:-W|-X|-Q)\s+\S+|--check-hash-based-pycs(?:=\S+|\s+\S+)|-\S+)\s+/.exec(remaining);
    if (option === null) break;
    remaining = remaining.slice(option[0].length);
  }
  const script = /^(\S+)/.exec(remaining)?.[1];
  return script !== undefined && /(^|\/)(cswap|claude-swap)$/.test(script);
}

function mainIsCswapCommandToSignal(args: string): boolean {
  const separator = args.indexOf(' ');
  const executable = separator === -1 ? args : args.slice(0, separator);
  if (/(^|\/)(cswap|claude-swap)$/.test(executable)) return true;
  return mainPythonArguments(executable) !== undefined && mainStrictFirstPythonScriptIsCswap(args);
}

test('A14c: the strict signal classifier never signals a command main would not', () => {
  const tricky = [
    ...a14cNotSignalTargets,
    ...a14cDetected,
    'python3 -IW cswap',
    'python3 -W cswap',
    'python3 -W -m claude_swap',
    'python3 -m -u cswap',
    'python3 -?m claude_swap',
    'python3 -I?m claude_swap',
    'python3 -1m claude_swap',
    'python3 -- -m claude_swap',
    'python3 -- cswap',
    'python3 - cswap',
    'python3 -Q new -m claude_swap',
    'python3 -Qm claude_swap',
    'python3 -mclaude_swapm claude_swap',
    'python3 -IXdev -m claude_swap',
    'python3 -IX dev -m claude_swap',
    'python3 --check-hash-based-pycs always -m claude_swap',
    'python3 --check-hash-based-pycs=always -IWm claude_swap',
    '/opt/claude-swap/bin/python -c import cswap',
  ];
  const interpreters = ['python3', '/usr/bin/python3'];
  const parts = [
    '-I', '-u', '-IW', '-W', '-X', '-Q', '-Wignore', '-Xm', '-c', '-cm', '-mm', '-m', '-Im',
    '-mclaude_swap', '-c__import__("time").sleep(600)', '--', '-', '--check-hash-based-pycs',
    '--version', '-?m', 'ignore', 'print(1)', 'cswap', 'claude_swap', 'claude_swap.cli',
    '/usr/local/bin/cswap',
  ];
  const generated: string[] = [];
  for (const interpreter of interpreters) {
    for (const a of parts) {
      generated.push(`${interpreter} ${a}`);
      for (const b of parts) {
        generated.push(`${interpreter} ${a} ${b}`);
        for (const c of parts) generated.push(`${interpreter} ${a} ${b} ${c}`);
      }
    }
  }

  let newTargets = 0;
  for (const command of [...tricky, ...generated]) {
    if (isCswapCommandToSignal(command)) {
      newTargets += 1;
      assert.equal(mainIsCswapCommandToSignal(command), true, `new signal target that main did not signal: ${command}`);
    }
  }
  assert.ok(newTargets > 0, 'the comparison must include real signal targets');
});
