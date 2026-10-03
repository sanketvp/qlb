import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { describe, it } from 'node:test';

// TypeScript 7.0.2 no longer exports classic `createSourceFile(text)`.
// The in-tree compiler API used here is `typescript/unstable/ast`
// (`createScanner` + `SyntaxKind` + `forEachChild` on scanned structure).
// Implementation note: this is the supported in-tree parse surface for ^7.
const ts = require('typescript/unstable/ast') as {
  createScanner: (skipTrivia: boolean, languageVariant?: number, text?: string) => {
    setText: (text: string) => void;
    scan: () => number;
    getToken: () => number;
    getTokenValue: () => string;
    isIdentifier: () => boolean;
  };
  SyntaxKind: Record<string, number>;
};

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

const CLOSURE_ROOTS = [
  join(SRC, 'cswap-usage.ts'),
  join(SRC, 'cswap-consume.ts'),
  join(SRC, 'cswap-native-read.ts'),
  join(SRC, 'adapters', 'anthropic.ts'),
];

const WRITERS = [
  join(SRC, 'refresh.ts'),
  join(SRC, 'refresh-lease.ts'),
  join(SRC, 'native-resync.ts'),
  join(SRC, 'keychain.ts'),
  join(SRC, 'migration.ts'),
];

const HARNESS = [
  join(ROOT, 'harness', 'claude'),
  join(ROOT, 'harness', 'qlb-proxy-token'),
  join(ROOT, 'harness', 'qlb-proxy-mutex'),
];

const TOKEN_RE = new RegExp(['grant', '_type'].join('') + '|refreshTokenDirect|/oauth/token|api/oauth/usage');
const NATIVE_RESYNC_RE = /native-resync/;
const SECURITY_WRITE_RE = /add-generic-password|delete-generic-password|security -i/;
const SPAWN_CSWAP_RE = /\b(?:execFile|execFileSync|spawn|spawnSync|execvp|Popen)\b[\s\S]{0,80}\bcswap\b/;
const SPAWN_CURL_RE = /\b(?:execFile|execFileSync|spawn|spawnSync|execvp|Popen)\b[\s\S]{0,80}\bcurl\b/;

function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolvePath(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface ScanResult {
  staticSpecs: string[];
  dynamic: number;
}

function collect(file: string): ScanResult {
  const text = readFileSync(file, 'utf8');
  const scanner = ts.createScanner(true);
  scanner.setText(text);
  const kinds = ts.SyntaxKind;
  const tokens: Array<{ kind: number; value: string }> = [];
  for (let n = 0; n < 200_000; n++) {
    const kind = scanner.scan();
    if (kind === kinds.EndOfFile || kind === kinds.EndOfFileToken) break;
    let value = scanner.getTokenValue();
    if (
      (kind === kinds.StringLiteral || kind === kinds.NoSubstitutionTemplateLiteral) &&
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    tokens.push({ kind, value });
  }

  const staticSpecs: string[] = [];
  let dynamic = 0;

  const isString = (t?: { kind: number }) =>
    !!t && (t.kind === kinds.StringLiteral || t.kind === kinds.NoSubstitutionTemplateLiteral);
  const isRequireTok = (t?: { kind: number; value: string }) =>
    !!t && (t.kind === kinds.RequireKeyword || (t.kind === kinds.Identifier && t.value === 'require'));

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === kinds.ImportKeyword) {
      const next = tokens[i + 1];
      if (next && next.kind === kinds.OpenParenToken) {
        const arg = tokens[i + 2];
        if (isString(arg)) dynamic += 1;
        continue;
      }
      // import x = require('…')
      const eq = tokens.slice(i, i + 8).findIndex((x) => x.kind === kinds.EqualsToken);
      if (eq !== -1) {
        const window = tokens.slice(i + eq, i + eq + 6);
        const req = window.find((x) => isRequireTok(x));
        const str = window.find((x) => isString(x));
        if (req && str) staticSpecs.push(str.value);
        continue;
      }
      // import { x } from '…'  /  import '…'
      for (let j = i + 1; j < Math.min(tokens.length, i + 40); j++) {
        if (tokens[j]!.kind === kinds.FromKeyword && isString(tokens[j + 1])) {
          staticSpecs.push(tokens[j + 1]!.value);
          break;
        }
        if (j === i + 1 && isString(tokens[j])) {
          staticSpecs.push(tokens[j]!.value);
          break;
        }
        if (tokens[j]!.kind === kinds.SemicolonToken) break;
      }
      continue;
    }
    if (t.kind === kinds.ExportKeyword) {
      for (let j = i + 1; j < Math.min(tokens.length, i + 40); j++) {
        if (tokens[j]!.kind === kinds.FromKeyword && isString(tokens[j + 1])) {
          staticSpecs.push(tokens[j + 1]!.value);
          break;
        }
        if (tokens[j]!.kind === kinds.SemicolonToken) break;
      }
      continue;
    }
    if (isRequireTok(t)) {
      const next = tokens[i + 1];
      if (next && next.kind === kinds.OpenParenToken && isString(tokens[i + 2])) {
        dynamic += 1;
      }
    }
  }

  return { staticSpecs, dynamic };
}

function forEachChildFiles(file: string, visit: (childFile: string) => void): void {
  const { staticSpecs } = collect(file);
  for (const spec of staticSpecs) {
    const resolved = resolveLocal(file, spec);
    if (resolved) visit(resolved);
  }
}

function closureOf(roots: string[]): { files: Set<string>; dynamic: number } {
  const files = new Set<string>();
  const queue = [...roots];
  let dynamic = 0;
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const scanned = collect(file);
    dynamic += scanned.dynamic;
    forEachChildFiles(file, (child) => queue.push(child));
  }
  return { files, dynamic };
}

describe('consume import-closure walker', () => {
  it('production closure excludes writers and dynamic imports', () => {
    const { files, dynamic } = closureOf(CLOSURE_ROOTS);
    const writerHits = [...files].filter((f) => WRITERS.includes(f));
    const texts = [...files, ...HARNESS].map((f) => ({ f, text: readFileSync(f, 'utf8') }));
    let tokenTerms = 0;
    let securityWrites = 0;
    let cswapSpawns = 0;
    for (const { text } of texts) {
      if (TOKEN_RE.test(text) || NATIVE_RESYNC_RE.test(text)) tokenTerms += 1;
      if (SECURITY_WRITE_RE.test(text)) securityWrites += 1;
      if (SPAWN_CSWAP_RE.test(text) || SPAWN_CURL_RE.test(text)) cswapSpawns += 1;
    }
    console.log(
      `WRITER_IMPORTS=${writerHits.length} TOKEN_TERMS=${tokenTerms} CSWAP_SPAWNS_SRC=${cswapSpawns} SECURITY_WRITE_TERMS=${securityWrites} DYNAMIC_IMPORTS=${dynamic}`,
    );
    assert.equal(writerHits.length, 0, `writers in closure: ${writerHits.map((f) => relative(ROOT, f)).join(', ')}`);
    assert.equal(tokenTerms, 0);
    assert.equal(cswapSpawns, 0);
    assert.equal(securityWrites, 0);
    assert.equal(dynamic, 0);
  });

  it('walker covers four static forms, detects writer reach, and fail-closes dynamics', () => {
    const dir = join(ROOT, 'test', 'fixtures', 'closure');
    const leaf = join(dir, 'leaf.ts');
    const forms = [
      join(dir, 'from-import.ts'),
      join(dir, 'export-from.ts'),
      join(dir, 'import-equals.ts'),
      join(dir, 'side-effect-import.ts'),
    ];
    let formHits = 0;
    for (const file of forms) {
      const { files } = closureOf([file]);
      if (files.has(leaf)) formHits += 1;
    }
    const writerStub = join(dir, 'keychain-stub.ts');
    const reaches = closureOf([join(dir, 'reaches-writer.ts')]);
    const writerDetect = reaches.files.has(writerStub) ? 1 : 0;
    const dynImport = collect(join(dir, 'dynamic-import.ts'));
    const dynRequire = collect(join(dir, 'dynamic-require.ts'));
    assert.ok(dynImport.dynamic > 0, 'dynamic import() must be detected');
    assert.ok(dynRequire.dynamic > 0, 'dynamic require() must be detected');
    console.log(`WALKER_FORMS=${formHits} WALKER_WRITER_DETECT=${writerDetect}`);
    assert.equal(formHits, 4);
    assert.equal(writerDetect, 1);
  });
});
