'use strict';
// Inert capture proofs. Install stubs FIRST, then load the guard.
// Never opens a real socket, never execs a captured subprocess.

const http = require('http');
const net = require('net');
const cp = require('child_process');
const path = require('path');

const seen = [];
http.request = function stubHttp(...args) {
  seen.push({ transport: 'http.request', args });
  return { end() {}, on() { return this; } };
};
http.get = http.request;
net.connect = function stubNet(...args) {
  seen.push({ transport: 'net.connect', args });
  return { on() { return this; }, end() {} };
};
net.createConnection = net.connect;
net.Socket.prototype.connect = function stubSock(...args) {
  seen.push({ transport: 'socket.connect', args });
  return this;
};
const origSpawnSync = cp.spawnSync;
cp.spawnSync = function stubSpawn(...args) {
  seen.push({ transport: 'spawnSync', args });
  return { status: 0, stdout: 'stub', stderr: '' };
};

const guard = require('./guard.cjs');

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
  run('url-options-override', () => http.request(new URL('http://127.0.0.1:9'), { hostname: 'external-fixture.invalid' })),
  run('raw-net-bypass', () => net.connect(443, 'external-fixture.invalid')),
  run('node-child-preload-propagation', () => cp.spawnSync(process.execPath, ['-e', '/* inert fixture */'], { env: { HOME: process.env.HOME } })),
];

const hosts = ['localhost', '0', '::', '127.0.0.1', '::1'].map((host) => ({
  host,
  allowed: guard.isAllowedLoopbackHost(host),
}));

const failures = [];
if (results[0].underlyingStubReached || results[0].error?.code !== 'ISOLATION_DENIED') {
  failures.push('external-control');
}
if (results[1].underlyingStubReached || !/unowned|ISOLATION_DENIED/.test(results[1].error?.message || '')) {
  failures.push('unowned-loopback-port');
}
if (results[2].underlyingStubReached || results[2].error?.code !== 'ISOLATION_DENIED') {
  failures.push('url-options-override');
}
if (results[3].underlyingStubReached || results[3].error?.code !== 'ISOLATION_DENIED') {
  failures.push('raw-net-bypass');
}
const child = results[4];
const childArgs = child.captured[0]?.args || [];
const argv = childArgs[1] || [];
const injected = Array.isArray(argv) && argv.includes('--require') && argv.some((a) => String(a).includes('guard.cjs'));
if (!injected) failures.push('node-child-preload-propagation');
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
