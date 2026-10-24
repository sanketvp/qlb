#!/usr/bin/env node

import { readFileSync } from "node:fs";

const registrySource = /^src\/(?:commands|checks|token|gate|auto|usage)\//;

function fail(violations, message) {
  violations.push(message);
}

function load(path, violations) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(violations, `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function validate(document) {
  const violations = [];
  if (!document || typeof document !== "object" || !Array.isArray(document.slices)) {
    return ["document must contain a slices array"];
  }

  const byId = new Map();
  for (const slice of document.slices) {
    if (!slice || typeof slice !== "object") {
      fail(violations, "slice entries must be objects");
      continue;
    }
    const { id, start, files } = slice;
    if (typeof id !== "string" || id.length === 0) {
      fail(violations, "slice has no id");
      continue;
    }
    if (byId.has(id)) fail(violations, `duplicate slice id: ${id}`);
    else byId.set(id, slice);
    if (!Array.isArray(start) || !start.every((entry) => typeof entry === "string")) {
      fail(violations, `${id}: start must be a string array`);
    }
    if (!Array.isArray(files) || !files.every((entry) => typeof entry === "string" && entry.length > 0)) {
      fail(violations, `${id}: files must be a non-empty-string array`);
    }
  }

  for (const [id, slice] of byId) {
    for (const prerequisite of slice.start ?? []) {
      if (!byId.has(prerequisite)) fail(violations, `${id}: unknown start-state slice ${prerequisite}`);
    }
  }

  const states = new Map();
  const stack = [];
  function visit(id) {
    const state = states.get(id);
    if (state === "done") return;
    if (state === "visiting") {
      const first = stack.indexOf(id);
      fail(violations, `dependency cycle: ${[...stack.slice(first), id].join(" -> ")}`);
      return;
    }
    states.set(id, "visiting");
    stack.push(id);
    for (const prerequisite of byId.get(id)?.start ?? []) visit(prerequisite);
    stack.pop();
    states.set(id, "done");
  }
  for (const id of byId.keys()) visit(id);
  if (violations.some((message) => message.startsWith("dependency cycle:"))) return violations;

  const closures = new Map();
  function closure(id) {
    const cached = closures.get(id);
    if (cached) return cached;
    const result = new Set();
    for (const prerequisite of byId.get(id)?.start ?? []) {
      result.add(prerequisite);
      for (const ancestor of closure(prerequisite)) result.add(ancestor);
    }
    closures.set(id, result);
    return result;
  }

  for (const [id, slice] of byId) {
    const start = slice.start ?? [];
    if (new Set(start).size !== start.length) fail(violations, `${id}: duplicate start-state entry`);
    for (const file of slice.files ?? []) {
      if (id !== "R0" && registrySource.test(file) && !closure(id).has("R0")) {
        fail(violations, `${id}: ${file} requires R0 in its start-state closure`);
      }
    }
  }

  const owners = new Map();
  for (const [id, slice] of byId) {
    for (const file of new Set(slice.files ?? [])) {
      const list = owners.get(file) ?? [];
      list.push(id);
      owners.set(file, list);
    }
  }
  for (const [file, ids] of owners) {
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const a = ids[left];
        const b = ids[right];
        if (!closure(a).has(b) && !closure(b).has(a)) {
          fail(violations, `shared file ${file}: ${a} and ${b} are outside each other's start-state closure`);
        }
      }
    }
  }

  return violations;
}

const [path] = process.argv.slice(2);
if (!path || process.argv.length !== 3) {
  console.error("usage: node scripts/check-slice-graph.mjs <slices.json>");
  process.exitCode = 2;
} else {
  const loadViolations = [];
  const document = load(path, loadViolations);
  const violations = [...loadViolations, ...validate(document)];
  if (violations.length > 0) {
    for (const violation of violations) console.error(`violation: ${violation}`);
    console.error(`${violations.length} violation${violations.length === 1 ? "" : "s"}`);
    process.exitCode = 1;
  } else {
    console.log(`slice graph: ${document.slices.length} slices, 0 violations`);
  }
}
