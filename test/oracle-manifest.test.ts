import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = join(__dirname, '..', '..');
const ORACLE = join(ROOT, 'test', 'oracle', 'claude-swap-v0.28.0');
const MANIFEST_PATH = join(ORACLE, 'MANIFEST.json');
const LICENSE = join(ROOT, 'third_party', 'claude-swap', 'LICENSE');
const GOLDENS = join(ROOT, 'test', 'oracle', 'goldens');
const PINNED_FILES_AGGREGATE_SHA256 = 'ca95ba205a093a2a96a52537f7f7a39f365842764cae6fb3e3e9c6895d182b58';

type Manifest = {
  upstream: string;
  tag: string;
  commit: string;
  files: Record<string, string>;
  files_aggregate_sha256: string;
  git_blob_ids: Record<string, string>;
  upstream_tree: string[];
  test_def_counts: Record<string, number>;
  test_switcher_top_level_test_classes: string[];
};

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function filesAggregateSha256(files: Record<string, string>): string {
  const listing = Object.entries(files)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, digest]) => `${path} ${digest}\n`)
    .join('');
  return createHash('sha256').update(listing).digest('hex');
}

function filesBelow(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) assert.fail(`symlink in vendored tree: ${path}`);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function switcherClassesInCoverage(): string[] {
  const coverage = readFileSync(join(ROOT, 'test', 'oracle', 'COVERAGE.md'), 'utf8');
  return [...coverage.matchAll(/^\| `test_switcher\.py::(Test[^`]+)` \| [^|]+ \|$/gm)].map((match) => match[1]);
}

describe('claude-swap v0.28.0 oracle provenance', () => {
  it('matches every vendored file to its pinned manifest hash', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
    assert.equal(manifest.upstream, 'https://github.com/realiti4/claude-swap');
    assert.equal(manifest.tag, 'v0.28.0');
    assert.equal(manifest.commit, '2b2d71c7aeb49e6bd25393509ceb05dbca7b0e10');
    assert.equal(Object.keys(manifest.files).length, 94);
    assert.equal(manifest.files_aggregate_sha256, PINNED_FILES_AGGREGATE_SHA256);
    const sourceFiles = Object.keys(manifest.files)
      .filter((path) => path.startsWith('test/oracle/claude-swap-v0.28.0/src/claude_swap/'))
      .sort();
    assert.equal(sourceFiles.length, 43);
    assert.equal(Object.keys(manifest.test_def_counts).length, 50);
    assert.equal(manifest.test_def_counts['tests/test_switcher.py'], 502);
    assert.equal(manifest.test_switcher_top_level_test_classes.length, 78);
    assert.deepEqual(switcherClassesInCoverage(), manifest.test_switcher_top_level_test_classes);

    const actualFiles = [
      LICENSE,
      ...filesBelow(ORACLE).filter((path) => path !== MANIFEST_PATH),
    ].map((path) => relative(ROOT, path).split(sep).join('/')).sort();
    assert.deepEqual(Object.keys(manifest.files).sort(), actualFiles);

    const actualHashes: Record<string, string> = {};
    for (const [repoRelativePath, expectedHash] of Object.entries(manifest.files)) {
      assert.match(expectedHash, /^[a-f0-9]{64}$/);
      const path = join(ROOT, repoRelativePath);
      assert.ok(existsSync(path), `vendored file is missing: ${repoRelativePath}`);
      actualHashes[repoRelativePath] = sha256(path);
      assert.equal(actualHashes[repoRelativePath], expectedHash, `sha256 mismatch: ${repoRelativePath}`);
    }
    assert.equal(filesAggregateSha256(actualHashes), PINNED_FILES_AGGREGATE_SHA256);
    assert.deepEqual(Object.keys(manifest.git_blob_ids).sort(), Object.keys(manifest.files).sort());
    for (const blobId of Object.values(manifest.git_blob_ids)) {
      assert.match(blobId, /^[a-f0-9]{40}$/);
    }
    assert.equal(manifest.upstream_tree.length, Object.keys(manifest.files).length);
  });

  it('carries attribution headers on every mapped port', () => {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-ported-headers.mjs')], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^0 missing\n$/);
  });

  it('accepts a header rendered from the canonical ported-module template', () => {
    const template = readFileSync(join(ROOT, 'docs', 'templates', 'ported-module-header.txt'), 'utf8');
    const rendered = template.replace(
      'src/claude_swap/<path>.py:<first>-<last>',
      'src/claude_swap/fsutil.py:134-246',
    );
    assert.ok(readFileSync(join(ROOT, 'src', 'fsutil.ts'), 'utf8').startsWith(rendered));

    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-ported-headers.mjs')], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  });

  it('contains parseable JSON goldens only', () => {
    const goldenFiles = filesBelow(GOLDENS).filter((path) => path.endsWith('.json'));
    assert.ok(goldenFiles.length > 0, 'expected committed oracle goldens');
    for (const path of goldenFiles) {
      assert.ok(statSync(path).size > 0, `golden is empty: ${relative(ROOT, path)}`);
      assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')), relative(ROOT, path));
    }
  });
});
