const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join, relative } = require('node:path');

const root = join(__dirname, '..');
const stampPath = join('dist', '.build-sha');

// This is the same path/type/content encoding used by releaseDigest. The stamp
// itself is omitted so its metadata does not create an impossible self-hash.
function shippedBuildDigest() {
  const paths = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const path = relative(root, absolute);
      if (path === stampPath) continue;
      paths.push(path);
      if (entry.isDirectory()) visit(absolute);
    }
  };
  for (const output of ['dist', 'extensions']) {
    const path = join(root, output);
    if (existsSync(path)) visit(path);
  }

  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    const stat = lstatSync(join(root, path));
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error(`cannot stamp unsupported build output at ${path}`);
    }
    hash.update(`${path}\0${stat.isDirectory() ? 'd' : 'f'}\0`);
    if (!stat.isDirectory()) hash.update(readFileSync(join(root, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
const buildDigest = shippedBuildDigest();
writeFileSync(join(root, stampPath), `${JSON.stringify({ sha, dirty, buildDigest })}\n`, { mode: 0o644 });
