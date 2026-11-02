#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
proofs="$root/proofs/codex-poll"
fixture="$root/test/fixtures/codex-poll-model-cases.json"
tmp_fixture="$(mktemp)"
test_home="$(mktemp -d)"
trap 'rm -f "$tmp_fixture"; rm -rf "$test_home"' EXIT

cd "$proofs"
lake build
if grep -R -n --include='*.lean' "s""orry" .; then
  echo "Lean proof source contains a prohibited placeholder" >&2
  exit 1
fi
lake exe gen "$tmp_fixture"
cmp -s "$tmp_fixture" "$fixture" || {
  echo "Committed Codex poll fixture differs from the Lean generator output" >&2
  exit 1
}

cd "$root"
npm run build
node scripts/clean-registry-output.cjs dist-test/src
./node_modules/.bin/tsc -p tsconfig.test.json
QLB_TEST_MODE=1 QLB_HOME="$test_home" HOME="$test_home" node --test dist-test/test/codex-poll-model.test.js
