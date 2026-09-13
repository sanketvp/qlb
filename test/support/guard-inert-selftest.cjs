'use strict';
// Inert capture proofs. Install stubs FIRST, then load the guard.
// Never opens a real socket, never execs a captured subprocess.

const fs = require('fs');
const http = require('http');
const net = require('net');
const cp = require('child_process');
const path = require('path');

const seen = [];
function capture(transport, result) {
  return function inertCapture(...args) {
    seen.push({ transport, args });
    return result;
  };
}

http.request = capture('http.request', { end() {}, on() { return this; } });
http.get = http.request;
net.connect = capture('net.connect', { on() { return this; }, end() {} });
net.createConnection = net.connect;
net.Socket.prototype.connect = capture('socket.connect', null);
net.Server.prototype.listen = capture('server.listen', null);
globalThis.fetch = capture('fetch', Promise.resolve({ status: 200, headers: { get: () => null } }));
cp.spawnSync = capture('spawnSync', { status: 0, stdout: 'stub', stderr: '' });

const guard = require('./guard.cjs');

// Register an inert simulation of a fixture-owned listener through the guard's
// real registration hook. No bind/listen operation occurs.
const server = new net.Server();
server.address = () => ({ address: '127.0.0.1', port: 31819, family: 'IPv4' });
server.listen(0, '127.0.0.1');
server.emit('listening');
seen.length = 0;

function run(name, fn) {
  const before = seen.length;
  let error = null;
  try {
    fn();
  } catch (e) {
    error = { code: e.code, message: e.message };
  }
  return {
    name,
    underlyingStubReached: seen.length > before,
    error,
    captured: seen.slice(before),
  };
}

const results = [
  run('external-control', () => http.request('https://external-fixture.invalid')),
  run('unowned-loopback-port', () => http.request('http://127.0.0.1:9/')),
  run('owned-loopback-control', () => http.request('http://127.0.0.1:31819/')),
  run('url-options-override', () => http.request(new URL('http://127.0.0.1:31819'), { hostname: 'external-fixture.invalid' })),
  run('direct-socket-connect', () => new net.Socket().connect(443, 'external-fixture.invalid')),
  run('fetch-ignored-init-hostname', () => fetch('https://external-fixture.invalid/', { hostname: '127.0.0.1', port: 31819 })),
  run('http-socket-path', () => http.request('http://127.0.0.1:31819/', { socketPath: '/tmp/qlb-inert-not-a-real-socket' })),
  run('net-path-override', () => net.connect({ host: '127.0.0.1', port: 31819, path: '/tmp/qlb-inert-not-a-real-socket' })),
  run('node-child-preload-propagation', () => cp.spawnSync(process.execPath, ['-e', '/* inert fixture */'], { env: { HOME: process.env.HOME } })),
  run('node-child-arbitrary-selftest-basename', () => cp.spawnSync(process.execPath, ['-e', '/* inert fixture */', 'guard-inert-selftest.cjs'], { env: { HOME: process.env.HOME } })),
  run('node-child-preload-after-script', () => cp.spawnSync(process.execPath, ['fixture.js', '--require', guard.GUARD_FILE], { env: { HOME: process.env.HOME } })),
  run('node-child-preload-after-terminator', () => cp.spawnSync(process.execPath, ['-e', '/* inert fixture */', '--', '--require', guard.GUARD_FILE], { env: { HOME: process.env.HOME } })),
  run('node-child-shell-option', () => cp.spawnSync(process.execPath, ['-e', '/* inert fixture */'], { shell: true, env: { HOME: process.env.HOME } })),
  run('socket-conflicting-hostname', () => new net.Socket().connect({
    host: 'external-fixture.invalid', hostname: '127.0.0.1', port: 31819,
  })),
  run('non-node-control', () => cp.spawnSync('sh', ['-c', '/* inert */'])),
];

const nativeModule = path.join(__dirname, '..', '..', 'dist', 'native-resync.js');
if (fs.existsSync(nativeModule)) {
  results.push(run('default-native-reader', () => {
    const { createNativeCredentialReader } = require(nativeModule);
    createNativeCredentialReader({
      poolFilePath: '/qlb-inert-native-pool',
      authJsonPath: '/qlb-inert-native-auth',
    });
  }));
} else {
  results.push({
    name: 'default-native-reader',
    underlyingStubReached: false,
    error: { code: 'SELFTEST_SETUP', message: `compiled module missing: ${nativeModule}` },
    captured: [],
  });
}

const hosts = ['localhost', '0', '::', '127.0.0.1', '::1'].map((host) => ({
  host,
  allowed: guard.isAllowedLoopbackHost(host),
}));

const byName = new Map(results.map((row) => [row.name, row]));
const failures = [];
function expectDenied(name) {
  const row = byName.get(name);
  if (!row || row.underlyingStubReached || row.error?.code !== 'ISOLATION_DENIED') failures.push(name);
}
for (const name of [
  'external-control',
  'unowned-loopback-port',
  'url-options-override',
  'direct-socket-connect',
  'fetch-ignored-init-hostname',
  'http-socket-path',
  'net-path-override',
  'node-child-shell-option',
  'socket-conflicting-hostname',
  'non-node-control',
  'default-native-reader',
]) expectDenied(name);

if (!byName.get('owned-loopback-control')?.underlyingStubReached || byName.get('owned-loopback-control')?.error) {
  failures.push('owned-loopback-control');
}
for (const name of [
  'node-child-preload-propagation',
  'node-child-arbitrary-selftest-basename',
  'node-child-preload-after-script',
  'node-child-preload-after-terminator',
]) {
  const row = byName.get(name);
  const argv = row?.captured?.[0]?.args?.[1] || [];
  const injected = Array.isArray(argv)
    && argv.includes('--require')
    && argv.some((a) => path.resolve(String(a)) === path.resolve(__dirname, 'guard.cjs'));
  if (!row?.underlyingStubReached || row.error || !injected) failures.push(name);
}
if (hosts.find((h) => h.host === 'localhost')?.allowed) failures.push('localhost-not-loopback');
if (hosts.find((h) => h.host === '0')?.allowed) failures.push('zero-not-loopback');
if (hosts.find((h) => h.host === '::')?.allowed) failures.push('unspec-not-loopback');
if (!hosts.find((h) => h.host === '127.0.0.1')?.allowed) failures.push('127-should-allow-host-class');
if (!hosts.find((h) => h.host === '::1')?.allowed) failures.push('v6-should-allow-host-class');

const report = { results, hosts, failures, ok: failures.length === 0 };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) {
  process.stderr.write(`GUARD_INERT_FAIL ${failures.join(',')}\n`);
  process.exit(1);
}
process.exit(0);
