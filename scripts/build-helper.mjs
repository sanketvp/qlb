#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, renameSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const identityName = 'QLB Keychain Helper';
const source = resolve('native/keychain-helper/main.swift');
const defaultOutput = resolve('native/keychain-helper/build/qlb-keychain-helper');

function usage() {
  console.error('usage: node scripts/build-helper.mjs [--keychain <path>] [--out <path>] [--no-trust]');
  process.exit(2);
}

function parseArgs(argv) {
  let keychain = join(homedir(), 'Library/Keychains/login.keychain-db');
  let output = defaultOutput;
  let noTrust = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keychain' && argv[i + 1]) {
      keychain = resolve(argv[++i]);
    } else if (argv[i] === '--out' && argv[i + 1]) {
      output = resolve(argv[++i]);
    } else if (argv[i] === '--no-trust') {
      noTrust = true;
    } else {
      usage();
    }
  }
  return { keychain, output, noTrust };
}

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function tryRun(file, args, options = {}) {
  try {
    return { ok: true, output: run(file, args, options) };
  } catch (error) {
    return { ok: false, output: String(error) };
  }
}

function opensslForPkcs12() {
  const candidate = tryRun('openssl', ['version']);
  const major = candidate.ok ? /^OpenSSL\s+(\d+)/.exec(candidate.output)?.[1] : undefined;
  if (major && Number(major) >= 3) return { executable: 'openssl', legacy: true };
  return { executable: '/usr/bin/openssl', legacy: false };
}

function certificateHashes(keychain) {
  const output = run('/usr/bin/security', ['find-certificate', '-c', identityName, '-a', '-Z', keychain]);
  return [...output.matchAll(/SHA-1 hash:\s*([0-9A-Fa-f]{40})/g)].map((match) => match[1].toUpperCase());
}

function privateKeyIdentityHashes(keychain) {
  // Unlike `find-identity -v`, this reports identities even while the
  // self-signed certificate is not yet trusted. Its presence proves that the
  // certificate's private key is in this keychain.
  const result = tryRun('/usr/bin/security', ['find-identity', '-p', 'codesigning', keychain]);
  if (!result.ok) return new Set();
  return new Set([...result.output.matchAll(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s/mg)].map((match) => match[1].toUpperCase()));
}

function existingIdentity(keychain) {
  try {
    const privateKeyHashes = privateKeyIdentityHashes(keychain);
    return certificateHashes(keychain).find((hash) => privateKeyHashes.has(hash)) ?? null;
  } catch {
    return null;
  }
}

function createIdentity(keychain, directory, noTrust) {
  const key = join(directory, 'identity-key.pem');
  const cert = join(directory, 'identity-cert.pem');
  const p12 = join(directory, 'identity.p12');
  const passphrase = randomBytes(32).toString('hex');
  const openssl = opensslForPkcs12();
  run('/usr/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-subj', `/CN=${identityName}/`, '-addext', 'keyUsage=digitalSignature',
    '-addext', 'extendedKeyUsage=codeSigning', '-days', '3650',
  ]);
  const p12Args = ['pkcs12', '-export', '-out', p12, '-inkey', key, '-in', cert, '-passout', `pass:${passphrase}`];
  if (openssl.legacy) p12Args.push('-legacy');
  run(openssl.executable, p12Args);
  run('/usr/bin/security', ['import', p12, '-k', keychain, '-P', passphrase, '-T', '/usr/bin/codesign']);
  // Only the operator's default build may change per-user trust settings.
  if (!noTrust) {
    run('/usr/bin/security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', keychain, cert]);
  }
  const hash = existingIdentity(keychain);
  if (!hash) throw new Error('imported Keychain Helper certificate has no matching private key');
  return hash;
}

function main() {
  const { keychain, output, noTrust } = parseArgs(process.argv.slice(2));
  const temp = mkdtempSync(join(tmpdir(), 'qlb-build-helper-'));
  try {
    mkdirSync(dirname(output), { recursive: true });
    const signingHash = existingIdentity(keychain) ?? createIdentity(keychain, temp, noTrust);
    const candidate = join(temp, 'qlb-keychain-helper');
    run('/usr/bin/swiftc', [source, '-o', candidate]);
    run('/usr/bin/codesign', ['--force', '--sign', signingHash, '--keychain', keychain, '--timestamp=none', candidate]);
    run('/usr/bin/codesign', ['--verify', '--strict', candidate]);
    const signingInfo = tryRun('/usr/bin/codesign', ['-dv', candidate]);
    if (!signingInfo.ok) throw new Error('codesign verification details could not be read');

    // Retain the last good helper only after this candidate has compiled, signed
    // and verified. It is used by S50's previous-helper matrix.
    const previousDir = process.env.QLB_HELPER_PREVIOUS_DIR ?? join(homedir(), '.qlb/helper-prev');
    if (existsSync(output)) {
      mkdirSync(previousDir, { recursive: true, mode: 0o700 });
      copyFileSync(output, join(previousDir, 'qlb-keychain-helper'));
    }
    renameSync(candidate, output);
  } finally {
    // The unencrypted private key, certificate and PKCS#12 export never survive
    // a failed import/signing attempt.
    rmSync(temp, { recursive: true, force: true });
  }
}

main();
