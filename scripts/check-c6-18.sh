#!/usr/bin/env bash
set -euo pipefail
cd /Users/sanketpatel/GIT/wt-qlb-c6-18
T="$(mktemp -d)"
mkdir -p "$T/home" "$T/qlb"
unset CODEX_HOME
export QLB_TEST_MODE=1 HOME="$T/home" QLB_HOME="$T/qlb"
npm run build
node scripts/clean-registry-output.cjs dist-test/src
./node_modules/.bin/tsc -p tsconfig.test.json
node --test dist-test/test/codex-switch.test.js dist-test/test/store.test.js dist-test/test/codex-sessions.test.js dist-test/test/codex-consume.test.js
