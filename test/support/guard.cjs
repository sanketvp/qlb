'use strict';
// Isolation preload. Fail-closed credential mocks, child preload injection,
// test-owned 127.0.0.1/::1 listeners only, effective URL+options destinations.

const Module = require('module');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const childProcess = require('child_process');

const GUARD_FILE = __filename;
const ownedLoopback = new Set();

function denied(kind, detail) {
  const err = new Error(`ISOLATION_DENIED:${kind}:${detail}`);
  err.code = 'ISOLATION_DENIED';
  throw err;
}

function normalizeHost(host) {
  if (!host) return null;
  let h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (h.startsWith('::ffff:')) h = h.slice(7);
  const colon = h.lastIndexOf(':');
  if (colon > 0 && h.indexOf(':') === colon && /^\d+$/.test(h.slice(colon + 1))) {
    h = h.slice(0, colon);
  }
  return h;
}

function isAllowedLoopbackHost(host) {
  const h = normalizeHost(host);
  return h === '127.0.0.1' || h === '::1';
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
    if (typeof value.hostname === 'string') return value.hostname;
    if (typeof value.host === 'string') return hostOf(value.host);
    if (typeof value.address === 'string') return value.address;
  }
  return null;
}

function portOfUrl(value) {
  try {
    const u = new URL(String(value));
    if (u.port) return Number(u.port);
    if (u.protocol === 'https:') return 443;
    if (u.protocol === 'http:') return 80;
  } catch {
    return null;
  }
  return null;
}

function effectiveDestination(urlOrOpts, options) {
  let host = null;
  let port = null;
  if (typeof urlOrOpts === 'string' || (typeof URL !== 'undefined' && urlOrOpts instanceof URL)) {
    host = hostOf(String(urlOrOpts));
    port = portOfUrl(String(urlOrOpts));
  } else if (urlOrOpts && typeof urlOrOpts === 'object') {
    host = hostOf(urlOrOpts.hostname || urlOrOpts.host || urlOrOpts.address);
    if (urlOrOpts.port != null) port = Number(urlOrOpts.port);
  }
  if (options && typeof options === 'object') {
    if (options.hostname || options.host) {
      host = hostOf(options.hostname || options.host);
    }
    if (options.port != null) port = Number(options.port);
  }
  return { host: normalizeHost(host), port };
}

function assertOwnedLoopback(dest, label) {
  const host = dest.host;
  const port = dest.port;
  if (!isAllowedLoopbackHost(host)) {
    denied('net', host || label || 'unknown');
  }
  if (port == null || Number.isNaN(port)) {
    denied('net', `${host}:noport`);
  }
  const key = `${host}:${port}`;
  const alt = host === '127.0.0.1' ? `::ffff:127.0.0.1:${port}` : null;
  if (!ownedLoopback.has(key) && !(alt && ownedLoopback.has(alt))) {
    denied('net', `${host}:${port}:unowned`);
  }
}

function registerListen(server) {
  const onListening = () => {
    const addr = server.address();
    if (!addr || typeof addr !== 'object') return;
    const host = normalizeHost(addr.address);
    if (!isAllowedLoopbackHost(host)) return;
    const key = `${host}:${addr.port}`;
    ownedLoopback.add(key);
    server.once('close', () => ownedLoopback.delete(key));
  };
  server.on('listening', onListening);
}

const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function guardedListen(...args) {
  registerListen(this);
  return origListen.apply(this, args);
};

function wrapClient(mod) {
  const origRequest = mod.request.bind(mod);
  const origGet = mod.get.bind(mod);
  function inspect(urlOrOpts, rest) {
    const options = rest && rest[0] && typeof rest[0] === 'object' && typeof rest[0] !== 'function'
      ? rest[0]
      : undefined;
    if ((urlOrOpts && typeof urlOrOpts === 'object' && urlOrOpts.socketPath) || options?.socketPath) {
      denied('net', 'unix');
    }
    assertOwnedLoopback(effectiveDestination(urlOrOpts, options), 'http');
  }
  mod.request = function guardedRequest(urlOrOpts, ...rest) {
    inspect(urlOrOpts, rest);
    return origRequest(urlOrOpts, ...rest);
  };
  mod.get = function guardedGet(urlOrOpts, ...rest) {
    inspect(urlOrOpts, rest);
    return origGet(urlOrOpts, ...rest);
  };
}
wrapClient(http);
wrapClient(https);

function wrapNetConnect(orig) {
  return function guardedConnect(...args) {
    // Node's own net.createConnection normalizes options into a single array
    // argument before delegating to Socket.prototype.connect.
    const inspectedArgs = Array.isArray(args[0]) ? args[0] : args;
    const first = inspectedArgs[0];
    let host = null;
    let port = null;
    if (typeof first === 'number') {
      port = first;
      host = typeof inspectedArgs[1] === 'string' ? inspectedArgs[1] : '127.0.0.1';
    } else if (typeof first === 'string' && first.startsWith('/')) {
      denied('net', 'unix');
    } else if (typeof first === 'string') {
      host = first;
      port = typeof inspectedArgs[1] === 'number' ? inspectedArgs[1] : null;
    } else if (first && typeof first === 'object') {
      if (first.path != null) denied('net', 'unix');
      if (typeof first.lookup === 'function') denied('net', 'custom-lookup');
      if (first.hostname != null && first.hostname !== first.host) {
        denied('net', 'ambiguous-hostname');
      }
      if (first.address != null && first.address !== first.host) {
        denied('net', 'ambiguous-address');
      }
      // Installed Node net/Socket routing consumes options.host || localhost;
      // hostname/address are not destination aliases for this API.
      host = first.host || 'localhost';
      port = first.port;
    }
    assertOwnedLoopback({ host: normalizeHost(host), port: port == null ? null : Number(port) }, 'net');
    return orig.apply(this, args);
  };
}

const origSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = wrapNetConnect(origSocketConnect);
net.connect = wrapNetConnect(net.connect);
net.createConnection = wrapNetConnect(net.createConnection);
tls.connect = wrapNetConnect(tls.connect);

if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const url = typeof input === 'string' || input instanceof URL
      ? String(input)
      : (input && input.url) || '';
    if (init?.dispatcher || init?.agent) denied('net', 'fetch-custom-transport');
    // RequestInit hostname/host/port fields are ignored by fetch and therefore
    // must never override the URL that fetch will actually request.
    assertOwnedLoopback(effectiveDestination(url), 'fetch');
    const nextInit = { ...(init || {}), redirect: 'manual' };
    return Promise.resolve(origFetch.call(this, input, nextInit)).then((res) => {
      if (res && res.status >= 300 && res.status < 400 && typeof res.headers?.get === 'function') {
        const loc = res.headers.get('location');
        if (loc) {
          const abs = new URL(loc, url).toString();
          assertOwnedLoopback(effectiveDestination(abs), 'fetch-redirect');
        }
      }
      return res;
    });
  };
}

function isNodeExec(file) {
  return typeof file === 'string' && file === process.execPath;
}

function withPreload(argv) {
  const list = Array.isArray(argv) ? argv.slice() : [];
  // Never scan application argv for an apparent preload: Node stops parsing
  // runtime options at the script entry or `--`. Duplicate loading is safe
  // (CommonJS caches this file); a false exemption is not.
  return ['--require', GUARD_FILE, ...list];
}

function splitSpawn(file, args, options) {
  if (args && !Array.isArray(args) && typeof args === 'object') {
    return { argv: [], opts: args };
  }
  return { argv: Array.isArray(args) ? args : [], opts: options };
}

function wrapSpawn(orig) {
  return function guardedSpawn(file, args, options) {
    if (!isNodeExec(file)) {
      denied('spawn', typeof file === 'string' ? file : String(file));
    }
    const split = splitSpawn(file, args, options);
    if (split.opts?.shell) denied('spawn', 'shell');
    return orig.call(this, file, withPreload(split.argv), split.opts);
  };
}

childProcess.spawn = wrapSpawn(childProcess.spawn);
childProcess.spawnSync = wrapSpawn(childProcess.spawnSync);
childProcess.execFile = wrapSpawn(childProcess.execFile);
childProcess.execFileSync = wrapSpawn(childProcess.execFileSync);
childProcess.fork = function guardedFork(modulePath, args, options) {
  const argv = Array.isArray(args) ? args : [];
  const opts = Array.isArray(args) ? options : args;
  return childProcess.spawn(process.execPath, [modulePath, ...argv], opts);
};
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
  const exp = origLoad.apply(this, arguments);
  try {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (/[/\\]keychain\.js$/.test(resolved) && exp && typeof exp.MockKeychain === 'function') {
      if (!exp.__qlbGuardMocked) {
        const mock = new exp.MockKeychain();
        const assertSvc = typeof exp.assertSafeKeychainService === 'function'
          ? exp.assertSafeKeychainService
          : () => {};
        const guarded = {
          setSync(service, account, json) {
            assertSvc(service);
            return mock.setSync(service, account, json);
          },
          getSync(service, account) {
            assertSvc(service);
            return mock.getSync(service, account);
          },
          deleteSync(service, account) {
            assertSvc(service);
            return mock.deleteSync(service, account);
          },
          async set(service, account, json) {
            assertSvc(service);
            return mock.set(service, account, json);
          },
          async get(service, account) {
            assertSvc(service);
            return mock.get(service, account);
          },
          async delete(service, account) {
            assertSvc(service);
            return mock.delete(service, account);
          },
        };
        exp.platformKeychain = guarded;
        exp.macosKeychain = guarded;
        exp.readNativeOpenRouterKey = function () {
          denied('native', 'openrouter-key');
        };
        exp.__qlbGuardMocked = true;
      }
    }
    if (/[/\\]native-resync\.js$/.test(resolved) && exp && typeof exp.createNativeCredentialReader === 'function') {
      if (!exp.__qlbGuardNativeReaderMocked) {
        const productionReader = exp.createNativeCredentialReader;
        exp.createNativeCredentialReader = function guardedNativeCredentialReader(opts) {
          const fixtureRoot = process.env.QLB_TEST_NATIVE_READER_ROOT;
          if (!fixtureRoot) denied('native', 'default-native-reader');
          const root = fs.realpathSync(path.resolve(fixtureRoot));
          const underFixtureRoot = (candidate) => {
            const resolvedPath = path.resolve(String(candidate || ''));
            const parent = fs.realpathSync(path.dirname(resolvedPath));
            if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) return false;
            if (!fs.existsSync(resolvedPath)) return true;
            const real = fs.realpathSync(resolvedPath);
            return real.startsWith(`${root}${path.sep}`);
          };
          if (!underFixtureRoot(opts?.poolFilePath) || !underFixtureRoot(opts?.authJsonPath)) {
            denied('native', 'reader-outside-fixture-root');
          }
          return productionReader(opts);
        };
        exp.__qlbGuardNativeReaderMocked = true;
      }
    }
  } catch (err) {
    if (err?.code === 'ISOLATION_DENIED') throw err;
    // resolution can fail for builtins
  }
  return exp;
};

Object.defineProperty(globalThis, '__qlbIsolationGuard', {
  value: Object.freeze({ path: GUARD_FILE }),
  configurable: false,
  enumerable: false,
  writable: false,
});

module.exports = {
  isAllowedLoopbackHost,
  isLoopbackHost: isAllowedLoopbackHost,
  ownedLoopback,
  GUARD_FILE,
};
