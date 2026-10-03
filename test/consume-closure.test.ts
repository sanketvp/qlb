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

const CONSUME_ROOTS = [
  join(SRC, 'cswap-usage.ts'),
  join(SRC, 'cswap-consume.ts'),
  join(SRC, 'cswap-native-read.ts'),
  join(SRC, 'adapters', 'anthropic.ts'),
];

const RUNTIME_ROOTS = [
  join(SRC, 'proxy.ts'),
  join(SRC, 'credentials.ts'),
  join(SRC, 'cli.ts'),
];

const CLOSURE_ROOTS = [...CONSUME_ROOTS, ...RUNTIME_ROOTS];

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
        dynamic += 1;
        continue;
      }
      // import x = require('…')  /  import x = A.B  (statement-bounded, no token cap)
      let end = i + 1;
      while (end < tokens.length && tokens[end]!.kind !== kinds.SemicolonToken) end++;
      const stmt = tokens.slice(i + 1, end);
      const eq = stmt.findIndex((x) => x.kind === kinds.EqualsToken);
      const fromAt = stmt.findIndex((x) => x.kind === kinds.FromKeyword);
      if (eq !== -1 && (fromAt === -1 || eq < fromAt)) {
        const rhs = stmt.slice(eq + 1);
        const req = rhs.findIndex((x) => isRequireTok(x));
        const str = rhs.findIndex((x) => isString(x));
        if (req !== -1 && str > req) staticSpecs.push(rhs[str]!.value);
        continue;
      }
      // import { x } from '…'  /  import '…'  (unbounded: no token cap on the clause)
      for (let j = i + 1; j < tokens.length; j++) {
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
      for (let j = i + 1; j < tokens.length; j++) {
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
      if (next && next.kind === kinds.OpenParenToken) {
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
    const consume = closureOf(CONSUME_ROOTS);
    const writerHits = [...consume.files].filter((f) => WRITERS.includes(f));
    const texts = [...consume.files, ...HARNESS].map((f) => ({ f, text: readFileSync(f, 'utf8') }));
    let tokenTerms = 0;
    let securityWrites = 0;
    let cswapSpawns = 0;
    for (const { text } of texts) {
      if (TOKEN_RE.test(text) || NATIVE_RESYNC_RE.test(text)) tokenTerms += 1;
      if (SECURITY_WRITE_RE.test(text)) securityWrites += 1;
      if (SPAWN_CSWAP_RE.test(text) || SPAWN_CURL_RE.test(text)) cswapSpawns += 1;
    }
    // Dynamic loading is fail-closed across the full static import closure of
    // all seven roots. Writer exclusion stays scoped to the consume-only
    // closure: cli/proxy legitimately import writers (refresh, native-resync, keychain).
    for (const file of RUNTIME_ROOTS) {
      assert.ok(existsSync(file), `missing runtime root ${relative(ROOT, file)}`);
    }
    const all = closureOf(CLOSURE_ROOTS);
    const dynamic = all.dynamic;
    console.log(
      `WRITER_IMPORTS=${writerHits.length} TOKEN_TERMS=${tokenTerms} CSWAP_SPAWNS_SRC=${cswapSpawns} SECURITY_WRITE_TERMS=${securityWrites} DYNAMIC_IMPORTS=${dynamic} RUNTIME_ROOTS=${RUNTIME_ROOTS.length} CLOSURE_ROOTS=${CLOSURE_ROOTS.length} CLOSURE_FILES=${all.files.size}`,
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
    const dynIdent = collect(join(dir, 'dynamic-ident.ts'));
    const dynConcat = collect(join(dir, 'dynamic-concat.ts'));
    const dynTemplate = collect(join(dir, 'dynamic-template.ts'));
    assert.ok(dynImport.dynamic > 0, 'dynamic import() must be detected');
    assert.ok(dynRequire.dynamic > 0, 'dynamic require() must be detected');
    assert.ok(dynIdent.dynamic > 0, 'identifier import()/require() must fail closed');
    assert.ok(dynConcat.dynamic > 0, 'concatenated import()/require() must fail closed');
    assert.ok(dynTemplate.dynamic > 0, 'template-expression import()/require() must fail closed');
    // Dynamic calls one hop away (behind a static import) must surface through the closure.
    const transitive = closureOf([join(dir, 'transitive-root.ts')]);
    assert.ok(transitive.files.has(join(dir, 'transitive-mid.ts')), 'intermediary must be reached');
    assert.equal(transitive.dynamic, 3, 'identifier/concat/template calls in the intermediary must be counted');
    // A static import clause longer than any fixed token window must still resolve.
    const long = closureOf([join(dir, 'long-import.ts')]);
    const longHit = long.files.has(join(dir, 'long-leaf.ts')) ? 1 : 0;
    console.log(`WALKER_FORMS=${formHits} WALKER_WRITER_DETECT=${writerDetect} WALKER_TRANSITIVE_DYNAMIC=${transitive.dynamic} WALKER_LONG_IMPORT=${longHit}`);
    assert.equal(formHits, 4);
    assert.equal(writerDetect, 1);
    assert.equal(longHit, 1);
  });
});
