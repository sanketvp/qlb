const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { discoverChecks } = require('../dist/registry');

const manifestDir = join(__dirname, '..', 'test', 'wiring', 'checks.d');

function signature(definition) {
  return `${definition.name}\u0000${definition.prefix ?? ''}`;
}

function describe(signatureValue) {
  const [name, prefix] = signatureValue.split('\u0000');
  return prefix === '' ? name : `${name} (prefix ${prefix})`;
}

function definitionsIn(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const prefix = readFileSync(join(directory, entry.name), 'utf8').trim();
      return prefix === '' ? { name: entry.name } : { name: entry.name, prefix };
    });
}

function unmatched(left, right) {
  const available = new Map();
  for (const entry of right) available.set(entry, (available.get(entry) ?? 0) + 1);
  return left.filter((entry) => {
    const count = available.get(entry) ?? 0;
    if (count === 0) return true;
    available.set(entry, count - 1);
    return false;
  });
}

const expected = definitionsIn(manifestDir).map(signature);
const actual = discoverChecks().map(signature);
const problems = [
  ...unmatched(expected, actual).map((entry) =>
    `missing ${describe(entry)}; restore its module or prefix under src/checks/, or change or remove its test/wiring/checks.d entry only if intentional`,
  ),
  ...unmatched(actual, expected).map((entry) =>
    `unexpected ${describe(entry)}; if intentional, record it in test/wiring/checks.d with its prefix as the file content (empty for none)`,
  ),
].sort();
if (problems.length > 0) {
  throw new Error(`doctor registry manifest mismatch: ${problems.join('; ')}`);
}
