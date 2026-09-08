# qlb_advisory — sourceable Pi dispatch helper.
# Usage: source scripts/hooks/pi-advisory.sh
#        qlb_advisory "$model"
# Call it BEFORE any dispatch/exec line. Purely informational — never changes
# which provider/model/account is actually dispatched.

qlb_advisory() {
  local model="${1:-}"
  [[ -z "$model" ]] && return 0
  local -a qlb_cmd=()
  if command -v qlb >/dev/null 2>&1; then
    qlb_cmd=(qlb)
  elif [[ -n "${QLB_BIN:-}" && -e "${QLB_BIN}" ]]; then
    if [[ "${QLB_BIN}" == *.js ]]; then
      qlb_cmd=(node "${QLB_BIN}")
    else
      qlb_cmd=("${QLB_BIN}")
    fi
  elif [[ -f "${HOME}/GIT/qlb/dist/cli.js" ]]; then
    qlb_cmd=(node "${HOME}/GIT/qlb/dist/cli.js")
  else
    return 0
  fi
  local json=""
  json="$("${qlb_cmd[@]}" resolve --model "$model" --harness dispatch --json 2>/dev/null)" || return 0
  [[ -z "$json" ]] && return 0
  node -e '
    let d;
    try { d = JSON.parse(process.argv[1]); } catch { process.exit(0); }
    if (!d || d.error === "EXHAUSTED" || !d.accountId) process.exit(0);
    const buckets = (d.snapshot && d.snapshot.buckets) || {};
    const bits = [];
    for (const k of ["5h", "7d", "weekly", "secondary", "primary"]) {
      if (buckets[k] && buckets[k].usedPct != null) bits.push(k + " " + buckets[k].usedPct + "%");
    }
    const label = (d.snapshot && d.snapshot.label) || d.accountId;
    const extra = bits.length ? " (" + bits.join(", ") + ")" : "";
    console.error("[qlb] advisory: use account " + label + extra);
  ' "$json" 2>/dev/null || true
}
