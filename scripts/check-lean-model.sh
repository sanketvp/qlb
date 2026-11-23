#!/usr/bin/env bash
# Builds a Lean model in proofs/<model>, rejects placeholder proofs, checks the
# committed fixture against the generator, and replays it through the shipped
# code. Usage: scripts/check-lean-model.sh [model]; with no model, every model.
# A model's fixture is test/fixtures/<model>-model-cases.json and its replay
# test is test/<model>-model.test.ts.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$#" -gt 1 ]; then
  echo "usage: scripts/check-lean-model.sh [model]" >&2
  exit 64
fi
if [ "$#" -eq 1 ]; then
  models=("$1")
else
  models=()
  for dir in "$root"/proofs/*/; do
    [ -f "$dir/lakefile.lean" ] && models+=("$(basename "$dir")")
  done
fi

tmp_fixture="$(mktemp)"
test_home="$(mktemp -d)"
trap 'rm -f "$tmp_fixture"; rm -rf "$test_home"' EXIT

for model in "${models[@]}"; do
  proofs="$root/proofs/$model"
  fixture="$root/test/fixtures/$model-model-cases.json"
  if [ ! -f "$proofs/lakefile.lean" ]; then
    echo "No Lean model at proofs/$model" >&2
    exit 1
  fi
  (
    cd "$proofs"
    lake build
    if grep -R -n --include='*.lean' --exclude-dir=.lake "s""orry" .; then
      echo "Lean proof source in proofs/$model contains a prohibited placeholder" >&2
      exit 1
    fi
    lake exe gen "$tmp_fixture"
  )
  cmp -s "$tmp_fixture" "$fixture" || {
    echo "Committed $model fixture differs from the Lean generator output" >&2
    exit 1
  }
done

cd "$root"
npm run build
node scripts/clean-registry-output.cjs dist-test/src
./node_modules/.bin/tsc -p tsconfig.test.json
for model in "${models[@]}"; do
  QLB_TEST_MODE=1 QLB_HOME="$test_home" HOME="$test_home" node --test "dist-test/test/$model-model.test.js"
done
