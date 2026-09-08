#!/usr/bin/env bash
# Idempotent QLB installer.
# Safe to re-run: npm ci/install, build, optional global link, then `qlb init`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "qlb install: Node.js is required (need >= 22)." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "Number.parseInt(process.versions.node, 10)")"
if [ -z "${NODE_MAJOR}" ] || [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "qlb install: Node.js >= 22 is required (found $(node -v))." >&2
  exit 1
fi

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

npm run build

LINKED=0
set +e
npm link
LINK_STATUS=$?
set -e
if [ "${LINK_STATUS}" -eq 0 ]; then
  LINKED=1
else
  echo "qlb install: npm link failed (often a permissions issue)."
  echo "  Fallback options:"
  echo "    - add ${ROOT}/dist to your PATH, then run: node ${ROOT}/dist/cli.js"
  echo "    - re-run with sudo if you intended a global install"
  echo "    - use npx: npx --prefix ${ROOT} qlb"
fi

if [ "${LINKED}" -eq 1 ] && command -v qlb >/dev/null 2>&1; then
  qlb init
else
  node dist/cli.js init
fi

echo "qlb install: done."
