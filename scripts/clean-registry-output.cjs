#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

// The optional root is for the isolated script check in test/registry.test.ts.
const distRoot = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist'));
for (const directory of ['commands', 'checks']) {
  fs.rmSync(path.join(distRoot, directory), { recursive: true, force: true });
}
