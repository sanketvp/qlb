'use strict';
// Trusted preflight, outside the guarded fixture: anchor build inputs to an
// exact commit in an independently supplied Git object database. The output
// must live outside the candidate build tree and is consumed by
// build-provenance.cjs before compilation.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}
function git(repo, args, encoding = 'utf8') {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${String(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function main() {
  const repoArg = arg('--trusted-repo');
  const expectHead = arg('--expect-head');
  const outputArg = arg('--output');
  const candidateArg = arg('--candidate-root');
  if (!repoArg || !expectHead || !outputArg || !candidateArg) {
    throw new Error('usage: source-oracle.cjs --trusted-repo <git-repo> --expect-head <40-sha> --candidate-root <archive-root> --output <external-json>');
  }
  if (!/^[0-9a-f]{40}$/.test(expectHead)) throw new Error(`invalid expected head: ${expectHead}`);
  const repo = fs.realpathSync(path.resolve(repoArg));
  const candidate = fs.realpathSync(path.resolve(candidateArg));
  fs.mkdirSync(path.dirname(path.resolve(outputArg)), { recursive: true });
  const output = path.join(fs.realpathSync(path.dirname(path.resolve(outputArg))), path.basename(outputArg));
  if (output === candidate || output.startsWith(`${candidate}${path.sep}`)) {
    throw new Error('source oracle must be outside the candidate build root');
  }
  const top = fs.realpathSync(String(git(repo, ['rev-parse', '--show-toplevel'])).trim());
  if (top !== repo) throw new Error(`trusted repo is not its Git top-level: ${repo}`);
  const commit = String(git(repo, ['rev-parse', '--verify', `${expectHead}^{commit}`])).trim();
  if (commit !== expectHead) throw new Error(`Git commit mismatch: resolved=${commit} expect=${expectHead}`);
  const objectType = String(git(repo, ['cat-file', '-t', expectHead])).trim();
  if (objectType !== 'commit') throw new Error(`expected commit object, got ${objectType}`);
  const tree = String(git(repo, ['rev-parse', `${expectHead}^{tree}`])).trim();
  const names = String(git(repo, [
    'ls-tree', '-r', '--name-only', expectHead, '--',
    'package.json', 'package-lock.json', 'tsconfig.json', 'src',
  ])).split('\n').filter(Boolean);
  const paths = names.filter((rel) =>
    rel === 'package.json'
    || rel === 'package-lock.json'
    || rel === 'tsconfig.json'
    || (rel.startsWith('src/') && rel.endsWith('.ts')),
  ).sort();
  for (const required of ['package.json', 'package-lock.json', 'tsconfig.json']) {
    if (!paths.includes(required)) throw new Error(`commit missing build input: ${required}`);
  }
  const files = paths.map((rel) => {
    const bytes = git(repo, ['show', `${expectHead}:${rel}`], null);
    return { path: rel, sha256: sha256(bytes) };
  });
  const oracle = {
    version: 1,
    commit: expectHead,
    tree,
    trustedRepo: repo,
    files,
    sourceTreeSha256: sha256(JSON.stringify(files)),
  };
  fs.writeFileSync(output, `${JSON.stringify(oracle, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({
    oracle: output,
    commit: oracle.commit,
    tree: oracle.tree,
    sourceTreeSha256: oracle.sourceTreeSha256,
  })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`SOURCE_ORACLE_FAIL ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
