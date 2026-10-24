#!/usr/bin/env node

import { readFileSync } from "node:fs";

const schemaVersion = 1;
const registrySource = /^src\/(?:commands|checks|token|gate|auto|usage)\//;

function isCanonicalRepoPath(path) {
  return typeof path === "string"
    && path.length > 0
    && !path.startsWith("/")
    && !path.includes("\\")
    && !path.includes("//")
    && !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

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

function expandSpecPath(path) {
  const match = /^(.*)\{([^{}]+)\}(.*)$/.exec(path);
  if (!match) return [path];
  const [, prefix, choices, suffix] = match;
  return choices.split(",").flatMap((choice) => expandSpecPath(`${prefix}${choice}${suffix}`));
}

function loadSpecFiles(path, violations) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    fail(violations, `cannot read spec ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  const files = new Set();
  for (const match of source.matchAll(/`([^`]+)`/g)) {
    for (const candidate of expandSpecPath(match[1])) {
      if (isCanonicalRepoPath(candidate)) files.add(candidate);
    }
  }
  for (const match of source.matchAll(/(?:src|test|docs|scripts|extensions|native|claude-config)\/[\w./{},*-]+/g)) {
    const rawPath = match[0].replace(/[.,]+$/, "");
    for (const candidate of expandSpecPath(rawPath)) {
      if (isCanonicalRepoPath(candidate)) files.add(candidate);
    }
  }
  return { files, source };
}

function isListedInSpec(file, spec) {
  if (spec.files.has(file) || spec.source.includes(file)) return true;
  const name = file.slice(file.lastIndexOf("/") + 1);
  if (spec.source.includes(name)) return true;
  return file.startsWith("test/")
    && name.endsWith(".ts")
    && spec.source.includes(`dist-test/test/${name.slice(0, -3)}js`);
}

function validate(document, specFiles) {
  const violations = [];
  if (!document || typeof document !== "object" || !Array.isArray(document.slices)) {
    return ["document must contain a slices array"];
  }
  if (document.schemaVersion !== schemaVersion) {
    fail(violations, `schemaVersion must be ${schemaVersion}`);
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
    const malformedStart = !Array.isArray(start) || !start.every((entry) => typeof entry === "string");
    const malformedFiles = !Array.isArray(files) || !files.every((entry) => typeof entry === "string" && entry.length > 0);
    if (malformedStart) fail(violations, `${id}: start must be a string array`);
    if (malformedFiles) fail(violations, `${id}: files must be a non-empty-string array`);
    if (malformedStart || malformedFiles) continue;

    let hasNonCanonicalFile = false;
    for (const file of files) {
      if (!isCanonicalRepoPath(file)) {
        fail(violations, `${id}: file path must be a canonical repo-relative POSIX path: ${file}`);
        hasNonCanonicalFile = true;
      }
    }
    if (hasNonCanonicalFile) continue;

    if (byId.has(id)) fail(violations, `duplicate slice id: ${id}`);
    else byId.set(id, slice);
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

  if (byId.has("X4")) {
    const reachesX4 = new Set(["X4"]);
    const pending = ["X4"];
    while (pending.length > 0) {
      const id = pending.pop();
      for (const prerequisite of byId.get(id)?.start ?? []) {
        if (!reachesX4.has(prerequisite)) {
          reachesX4.add(prerequisite);
          pending.push(prerequisite);
        }
      }
    }
    for (const id of byId.keys()) {
      if (!reachesX4.has(id)) fail(violations, `${id}: is not reachable from the final cutover slice X4`);
    }
  }

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

  if (specFiles) {
    for (const [id, slice] of byId) {
      for (const file of slice.files ?? []) {
        if (!isListedInSpec(file, specFiles)) fail(violations, `${id}: file path is absent from the supplied spec: ${file}`);
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

const args = process.argv.slice(2);
const [path, ...options] = args;
const hasSpec = options[0] === "--spec" && typeof options[1] === "string" && options.length === 2;
if (!path || (options.length !== 0 && !hasSpec)) {
  console.error("usage: node scripts/check-slice-graph.mjs <slices.json> [--spec <spec.md>]");
  process.exitCode = 2;
} else {
  const loadViolations = [];
  const document = load(path, loadViolations);
  const specFiles = hasSpec ? loadSpecFiles(options[1], loadViolations) : undefined;
  const violations = [...loadViolations, ...validate(document, specFiles)];
  if (violations.length > 0) {
    for (const violation of violations) console.error(`violation: ${violation}`);
    console.error(`${violations.length} violation${violations.length === 1 ? "" : "s"}`);
    process.exitCode = 1;
  } else {
    console.log(`slice graph: ${document.slices.length} slices, 0 violations`);
  }
}
