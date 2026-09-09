'use strict';
// Isolation preload for QLB tests. Deny external net and non-Node children.
// Allow only test-owned loopback (127.0.0.1 / ::1) and process.execPath.

const Module = require('module');
const http = require('http');
const https = require('https');
const childProcess = require('child_process');

function denied(kind, detail) {
  const err = new Error(`ISOLATION_DENIED:${kind}:${detail}`);
  err.code = 'ISOLATION_DENIED';
  throw err;
}

function hostOf(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (value.startsWith('/')) return null;
    try {
      if (value.includes('://')) return new URL(value).hostname;
    } catch {
      // fall through
    }
    if (value.startsWith('[')) {
      const end = value.indexOf(']');
      if (end > 0) return value.slice(1, end);
    }
    const colon = value.lastIndexOf(':');
    if (colon > 0 && value.indexOf(':') === colon) return value.slice(0, colon);
    return value;
  }
  if (typeof value === 'object') {
    if (typeof value.host === 'string') return hostOf(value.host);
    if (typeof value.hostname === 'string') return value.hostname;
    if (typeof value.address === 'string') return value.address;
  }
  return null;
}

function isLoopbackHost(host) {
  if (!host) return false;
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost' || h === '0' || h === '::';
}

function assertLoopback(target) {
  const host = hostOf(target);
  if (host && !isLoopbackHost(host)) denied('net', host);
}

function wrapClient(mod) {
  const origRequest = mod.request.bind(mod);
  const origGet = mod.get.bind(mod);
  function inspect(urlOrOpts) {
    if (typeof urlOrOpts === 'string' || urlOrOpts instanceof URL) assertLoopback(String(urlOrOpts));
    else if (urlOrOpts && typeof urlOrOpts === 'object') {
      assertLoopback(urlOrOpts.hostname || urlOrOpts.host);
    }
  }
  mod.request = function guardedRequest(urlOrOpts, ...rest) {
    inspect(urlOrOpts);
    return origRequest(urlOrOpts, ...rest);
  };
  mod.get = function guardedGet(urlOrOpts, ...rest) {
    inspect(urlOrOpts);
    return origGet(urlOrOpts, ...rest);
  };
}
wrapClient(http);
wrapClient(https);

if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const url = typeof input === 'string' || input instanceof URL
      ? String(input)
      : (input && input.url) || '';
    assertLoopback(url);
    return origFetch.call(this, input, init);
  };
}

function isNodeExec(file) {
  return typeof file === 'string' && file === process.execPath;
}

function guardSpawn(file) {
  if (!isNodeExec(file)) denied('spawn', typeof file === 'string' ? file : String(file));
}

function wrapSpawn(orig) {
  return function guardedSpawn(file, ...rest) {
    guardSpawn(file);
    return orig.call(this, file, ...rest);
  };
}

childProcess.spawn = wrapSpawn(childProcess.spawn);
childProcess.spawnSync = wrapSpawn(childProcess.spawnSync);
childProcess.execFile = wrapSpawn(childProcess.execFile);
childProcess.execFileSync = wrapSpawn(childProcess.execFileSync);
childProcess.fork = wrapSpawn(childProcess.fork);
childProcess.exec = function guardedExec() {
  denied('spawn', 'sh');
};
childProcess.execSync = function guardedExecSync() {
  denied('spawn', 'sh');
};

const origLoad = Module._load;
Module._load = function guardedLoad(request, parent, isMain) {
  if (request === 'keytar' || request === 'node-keytar') {
    denied('native', request);
  }
  return origLoad.call(this, request, parent, isMain);
};

module.exports = {
  isLoopbackHost,
  assertLoopback,
};
