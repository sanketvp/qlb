const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
writeFileSync(join(root, 'dist', '.build-sha'), `${JSON.stringify({ sha, dirty })}\n`, { mode: 0o644 });
