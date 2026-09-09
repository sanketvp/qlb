'use strict';
// Trusted verifier preflight: first require source bytes to match an external
// Git-object oracle for the exact commit, then independently compile that
// source, require its bytes to match the build under test, and write a manifest
// OUTSIDE that build root. A build-root HEAD receipt alone is never provenance.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function treeSha256(entries) {
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function walk(root, relativeDir, accept) {
  const dir = path.join(root, relativeDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = path.posix.join(relativeDir.split(path.sep).join('/'), entry.name);
    if (entry.isDirectory()) out.push(...walk(root, rel, accept));
    else if (entry.isFile() && accept(rel)) out.push(rel);
    else if (entry.isSymbolicLink()) throw new Error(`provenance refuses symlink: ${rel}`);
  }
  return out;
}

function sourcePaths(root) {
  const fixed = ['package.json', 'package-lock.json', 'tsconfig.json'];
  for (const rel of fixed) {
    if (!fs.statSync(path.join(root, rel)).isFile()) throw new Error(`missing source input: ${rel}`);
  }
  return [...fixed, ...walk(root, 'src', (rel) => rel.endsWith('.ts'))].sort();
}

function buildPaths(root) {
  return walk(root, 'dist', (rel) => rel.endsWith('.js')).sort();
}

function entriesFor(root, paths) {
  return paths.map((rel) => ({ path: rel, sha256: sha256File(path.join(root, rel)) }));
}

function sameEntries(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function verifyEntries(root, expected, actualPaths, label) {
  if (!Array.isArray(expected)) throw new Error(`invalid ${label} manifest entries`);
  const actual = entriesFor(root, actualPaths(root));
  if (!sameEntries(actual, expected)) {
    const expectedByPath = new Map(expected.map((row) => [row.path, row.sha256]));
    const actualByPath = new Map(actual.map((row) => [row.path, row.sha256]));
    const mismatches = [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])]
      .filter((p) => expectedByPath.get(p) !== actualByPath.get(p));
    throw new Error(`${label} provenance mismatch: ${mismatches.slice(0, 8).join(',')}`);
  }
  return treeSha256(actual);
}

function readGitHead(root) {
  const git = path.join(root, '.git');
  const headFile = path.join(git, 'HEAD');
  if (!fs.existsSync(headFile)) return null;
  const raw = fs.readFileSync(headFile, 'utf8').trim();
  if (!raw.startsWith('ref: ')) return /^[0-9a-f]{40}$/.test(raw) ? raw : null;
  const ref = raw.slice(5).trim();
  const loose = path.join(git, ref);
  if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim();
  const packed = path.join(git, 'packed-refs');
  if (!fs.existsSync(packed)) return null;
  const line = fs.readFileSync(packed, 'utf8').split('\n').find((row) => row.endsWith(` ${ref}`));
  return line ? line.split(' ')[0] : null;
}

function readInputHead(root) {
  const receipt = path.join(root, 'HEAD.receipt');
  if (fs.existsSync(receipt)) {
    const value = fs.readFileSync(receipt, 'utf8').trim().split(/\s+/)[0];
    return /^[0-9a-f]{40}$/.test(value) ? value : null;
  }
  return readGitHead(root);
}

function verifyManifest(buildRoot, manifest, expectHead, sourceOraclePath) {
  if (!manifest || manifest.version !== 2) throw new Error('unsupported provenance manifest');
  if (manifest.verifiedHead !== expectHead) {
    throw new Error(`provenance head mismatch: manifest=${manifest.verifiedHead} expect=${expectHead}`);
  }
  const buildRootRealpath = fs.realpathSync(buildRoot);
  if (buildRootRealpath !== manifest.buildRoot) {
    throw new Error(`provenance build-root mismatch: manifest=${manifest.buildRoot} actual=${buildRootRealpath}`);
  }
  if (!sourceOraclePath) throw new Error('source oracle is required');
  const oraclePath = fs.realpathSync(path.resolve(sourceOraclePath));
  if (oraclePath === buildRootRealpath || oraclePath.startsWith(`${buildRootRealpath}${path.sep}`)) {
    throw new Error('source oracle must be outside build root');
  }
  const oracleBytes = fs.readFileSync(oraclePath);
  if (sha256File(oraclePath) !== manifest.sourceOracle?.sha256) throw new Error('source oracle hash mismatch');
  const oracle = JSON.parse(oracleBytes.toString('utf8'));
  if (oracle.version !== 1 || oracle.commit !== expectHead || oracle.tree !== manifest.sourceOracle.tree) {
    throw new Error('source oracle commit/tree mismatch');
  }
  if (!sameEntries(oracle.files, manifest.source?.files)) throw new Error('source oracle file binding mismatch');
  if (treeSha256(oracle.files) !== oracle.sourceTreeSha256 || oracle.sourceTreeSha256 !== manifest.source.treeSha256) {
    throw new Error('source oracle tree digest mismatch');
  }
  const sourceTreeSha256 = verifyEntries(buildRoot, manifest.source?.files, sourcePaths, 'source');
  const buildTreeSha256 = verifyEntries(buildRoot, manifest.build?.files, buildPaths, 'build');
  if (sourceTreeSha256 !== manifest.source.treeSha256 || buildTreeSha256 !== manifest.build.treeSha256) {
    throw new Error('provenance tree digest mismatch');
  }
  for (const [label, rel, expected] of [
    ['guard', 'test/support/guard.cjs', manifest.guardSha256],
    ['scenario-driver', 'test/support/prune-scenarios.cjs', manifest.scenarioDriverSha256],
    ['provenance-builder', 'test/support/build-provenance.cjs', manifest.provenanceBuilderSha256],
    ['source-oracle-builder', 'test/support/source-oracle.cjs', manifest.sourceOracleBuilderSha256],
  ]) {
    const actual = sha256File(path.join(buildRoot, rel));
    if (actual !== expected) throw new Error(`${label} provenance mismatch`);
  }
  return { sourceTreeSha256, buildTreeSha256 };
}

function valueArg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}

function main() {
  const buildRootArg = valueArg(process.argv, '--build-root');
  const expectHead = valueArg(process.argv, '--expect-head');
  const outputArg = valueArg(process.argv, '--output');
  const sourceOracleArg = valueArg(process.argv, '--source-oracle');
  if (!buildRootArg || !expectHead || !outputArg || !sourceOracleArg) {
    throw new Error('usage: build-provenance.cjs --build-root <root> --expect-head <sha> --source-oracle <external-json> --output <external-json>');
  }
  if (!/^[0-9a-f]{40}$/.test(expectHead)) throw new Error(`invalid expected head: ${expectHead}`);
  const buildRoot = fs.realpathSync(path.resolve(buildRootArg));
  fs.mkdirSync(path.dirname(path.resolve(outputArg)), { recursive: true });
  const output = path.join(fs.realpathSync(path.dirname(path.resolve(outputArg))), path.basename(outputArg));
  const sourceOraclePath = fs.realpathSync(path.resolve(sourceOracleArg));
  if (output === buildRoot || output.startsWith(`${buildRoot}${path.sep}`)) {
    throw new Error('provenance manifest must be outside the build root');
  }
  if (sourceOraclePath === buildRoot || sourceOraclePath.startsWith(`${buildRoot}${path.sep}`)) {
    throw new Error('source oracle must be outside the build root');
  }
  const oracleBytes = fs.readFileSync(sourceOraclePath);
  const oracle = JSON.parse(oracleBytes.toString('utf8'));
  if (oracle.version !== 1 || oracle.commit !== expectHead || !/^[0-9a-f]{40}$/.test(oracle.tree || '')) {
    throw new Error('source oracle does not bind the requested Git commit/tree');
  }
  if (treeSha256(oracle.files) !== oracle.sourceTreeSha256) throw new Error('source oracle digest mismatch');
  const initialSource = entriesFor(buildRoot, sourcePaths(buildRoot));
  if (!sameEntries(initialSource, oracle.files)) {
    const oracleByPath = new Map(oracle.files.map((row) => [row.path, row.sha256]));
    const sourceByPath = new Map(initialSource.map((row) => [row.path, row.sha256]));
    const mismatches = [...new Set([...oracleByPath.keys(), ...sourceByPath.keys()])]
      .filter((p) => oracleByPath.get(p) !== sourceByPath.get(p));
    throw new Error(`source does not match Git oracle for ${expectHead}: ${mismatches.slice(0, 8).join(',')}`);
  }
  const inputHead = readInputHead(buildRoot);
  if (inputHead !== expectHead) throw new Error(`input head mismatch: input=${inputHead} expect=${expectHead}`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qlb-provenance-build-'));
  try {
    const cleanDist = path.join(scratch, 'dist');
    const tsc = path.join(buildRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!fs.existsSync(tsc)) throw new Error(`TypeScript compiler missing: ${tsc}`);
    const compile = spawnSync(
      process.execPath,
      [tsc, '-p', path.join(buildRoot, 'tsconfig.json'), '--outDir', cleanDist],
      { cwd: buildRoot, encoding: 'utf8', env: process.env },
    );
    if (compile.status !== 0) {
      throw new Error(`independent compile failed (${compile.status}): ${compile.stderr || compile.stdout}`);
    }
    const built = entriesFor(buildRoot, buildPaths(buildRoot));
    const clean = entriesFor(scratch, buildPaths(scratch));
    if (!sameEntries(built, clean)) {
      const expectedByPath = new Map(clean.map((row) => [row.path, row.sha256]));
      const actualByPath = new Map(built.map((row) => [row.path, row.sha256]));
      const mismatches = [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])]
        .filter((p) => expectedByPath.get(p) !== actualByPath.get(p));
      throw new Error(`build does not match clean source compile: ${mismatches.slice(0, 8).join(',')}`);
    }
    const source = entriesFor(buildRoot, sourcePaths(buildRoot));
    if (!sameEntries(source, initialSource)) throw new Error('source changed during provenance build');
    const manifest = {
      version: 2,
      verifiedHead: expectHead,
      buildRoot,
      sourceOracle: {
        sha256: sha256File(sourceOraclePath),
        commit: oracle.commit,
        tree: oracle.tree,
      },
      source: { treeSha256: treeSha256(source), files: source },
      build: { treeSha256: treeSha256(built), files: built },
      guardSha256: sha256File(path.join(buildRoot, 'test/support/guard.cjs')),
      scenarioDriverSha256: sha256File(path.join(buildRoot, 'test/support/prune-scenarios.cjs')),
      provenanceBuilderSha256: sha256File(__filename),
      sourceOracleBuilderSha256: sha256File(path.join(buildRoot, 'test/support/source-oracle.cjs')),
      compiler: {
        executable: process.execPath,
        typescriptVersion: require(path.join(buildRoot, 'node_modules/typescript/package.json')).version,
      },
    };
    fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({
      manifest: output,
      verifiedHead: manifest.verifiedHead,
      gitTree: manifest.sourceOracle.tree,
      sourceOracleSha256: manifest.sourceOracle.sha256,
      sourceTreeSha256: manifest.source.treeSha256,
      buildTreeSha256: manifest.build.treeSha256,
    })}\n`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = {
  buildPaths,
  readInputHead,
  sha256File,
  sourcePaths,
  treeSha256,
  verifyManifest,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`PROVENANCE_FAIL ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
