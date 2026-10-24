import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type Slice = { id: string; start: string[]; files: string[] };
type Document = { schemaVersion: number; slices: Slice[] };

const script = join(process.cwd(), "scripts", "check-slice-graph.mjs");

function check(document: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "qlb-slice-graph-"));
  const path = join(dir, "slices.json");
  writeFileSync(path, JSON.stringify(document));
  return spawnSync(process.execPath, [script, path], { encoding: "utf8" });
}

function closure(document: Document, id: string) {
  const byId = new Map(document.slices.map((slice) => [slice.id, slice]));
  const result = new Set<string>();
  function visit(sliceId: string) {
    for (const prerequisite of byId.get(sliceId)?.start ?? []) {
      if (!result.has(prerequisite)) {
        result.add(prerequisite);
        visit(prerequisite);
      }
    }
  }
  visit(id);
  return result;
}

test("the committed slice graph is valid", () => {
  const result = spawnSync(process.execPath, [script, "docs/slices.json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 violations/);
});

test("K13 owns bootstrap after A10", () => {
  const document = JSON.parse(readFileSync("docs/slices.json", "utf8")) as Document;
  const k13 = document.slices.find((slice) => slice.id === "K13");
  assert.ok(k13);
  assert.deepEqual(k13.start.includes("A10"), true);
  assert.deepEqual(k13.files.includes("src/bootstrap.ts"), true);

  const result = check({
    schemaVersion: 1,
    slices: [
      { id: "R0", start: [], files: ["src/bootstrap.ts"] },
      { id: "A10", start: ["R0"], files: ["src/bootstrap.ts"] },
      { id: "K13", start: ["A10"], files: ["src/bootstrap.ts"] },
    ],
  });
  assert.equal(result.status, 0, result.stderr);
});

test("rejects the unordered A10 and K13 bootstrap pair", () => {
  const result = check({
    schemaVersion: 1,
    slices: [
      { id: "R0", start: [], files: ["src/bootstrap.ts"] },
      { id: "A10", start: ["R0"], files: ["src/bootstrap.ts"] },
      { id: "K13", start: ["R0"], files: ["src/bootstrap.ts"] },
    ],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shared file src\/bootstrap\.ts: A10 and K13/i);
});

test("X1 closure includes every required pre-cutover slice", () => {
  const document = JSON.parse(readFileSync("docs/slices.json", "utf8")) as Document;
  const x1Closure = closure(document, "X1");
  for (const id of ["A0b", "A0c", "H1", "D1", "D3", "C1c", "A10b", "P6b", "A2c", "C7", "P10", "P8", "K14", "K5b"]) {
    assert.ok(x1Closure.has(id), `X1 closure must include ${id}`);
  }
});

test("rejects a dependency cycle", () => {
  const result = check({
    schemaVersion: 1,
    slices: [
      { id: "A", start: ["B"], files: ["a.ts"] },
      { id: "B", start: ["A"], files: ["b.ts"] },
    ],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cycle/i);
});

test("rejects unordered shared files", () => {
  const result = check({
    schemaVersion: 1,
    slices: [
      { id: "A", start: [], files: ["shared.ts"] },
      { id: "B", start: [], files: ["shared.ts"] },
    ],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shared file/i);
});

test("requires R0 for registry-owned source files", () => {
  const result = check({
    schemaVersion: 1,
    slices: [{ id: "A", start: [], files: ["src/commands/example.ts"] }],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /R0/);
});

test("rejects missing or unsupported schema versions", () => {
  for (const document of [{ slices: [] }, { schemaVersion: 2, slices: [] }]) {
    const result = check(document);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /schemaVersion/i);
  }
});

test("rejects non-canonical file paths before ownership checks", () => {
  const result = check({
    schemaVersion: 1,
    slices: [{ id: "A", start: [], files: ["src/./commands/foo.ts"] }],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /canonical repo-relative POSIX path/i);
  assert.doesNotMatch(result.stderr, /requires R0/i);
});

test("stops processing slices with malformed start or files", () => {
  for (const slice of [
    { id: "A", start: "A0", files: ["a.ts"] },
    { id: "A", start: [], files: 5 },
  ]) {
    const result = check({ schemaVersion: 1, slices: [slice] });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be a (string|non-empty-string) array/i);
    assert.match(result.stderr, /^1 violation$/m);
    assert.doesNotMatch(result.stderr, /cycle|TypeError/i);
  }
});
