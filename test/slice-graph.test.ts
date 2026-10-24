import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

type Slice = { id: string; start: string[]; files: string[] };

const script = join(process.cwd(), "scripts", "check-slice-graph.mjs");

function check(document: { slices: Slice[] }) {
  const dir = mkdtempSync(join(tmpdir(), "qlb-slice-graph-"));
  const path = join(dir, "slices.json");
  writeFileSync(path, JSON.stringify(document));
  return spawnSync(process.execPath, [script, path], { encoding: "utf8" });
}

test("the committed slice graph is valid", () => {
  const result = spawnSync(process.execPath, [script, "docs/slices.json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 violations/);
});

test("rejects a dependency cycle", () => {
  const result = check({
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
    slices: [{ id: "A", start: [], files: ["src/commands/example.ts"] }],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /R0/);
});
