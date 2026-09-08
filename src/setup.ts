import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SETUP_HARNESSES = ['pi', 'claude-code', 'codex-cli', 'generic'] as const;
export type SetupHarness = (typeof SETUP_HARNESSES)[number];

export interface SetupResult {
  harness: SetupHarness;
  instructions: string;
  snippetWritten?: string;
}

export function isSetupHarness(value: string | undefined): value is SetupHarness {
  return (
    value === 'pi' ||
    value === 'claude-code' ||
    value === 'codex-cli' ||
    value === 'generic'
  );
}

/**
 * Verbatim `qlb_advisory` from ~/.claude/scripts/pi-dispatch.sh.
 * Do not reinvent — setup pi prints and writes this function as-is.
 */
export const QLB_ADVISORY_FUNCTION = "qlb_advisory() {\n  local model=\"${1:-}\"\n  [[ -z \"$model\" ]] && return 0\n  local -a qlb_cmd=()\n  if command -v qlb >/dev/null 2>&1; then\n    qlb_cmd=(qlb)\n  elif [[ -n \"${QLB_BIN:-}\" && -e \"${QLB_BIN}\" ]]; then\n    if [[ \"${QLB_BIN}\" == *.js ]]; then\n      qlb_cmd=(node \"${QLB_BIN}\")\n    else\n      qlb_cmd=(\"${QLB_BIN}\")\n    fi\n  elif [[ -f \"${HOME}/GIT/qlb/dist/cli.js\" ]]; then\n    qlb_cmd=(node \"${HOME}/GIT/qlb/dist/cli.js\")\n  else\n    return 0\n  fi\n  local json=\"\"\n  json=\"$(\"${qlb_cmd[@]}\" resolve --model \"$model\" --harness dispatch --json 2>/dev/null)\" || return 0\n  [[ -z \"$json\" ]] && return 0\n  node -e '\n    let d;\n    try { d = JSON.parse(process.argv[1]); } catch { process.exit(0); }\n    if (!d || d.error === \"EXHAUSTED\" || !d.accountId) process.exit(0);\n    const buckets = (d.snapshot && d.snapshot.buckets) || {};\n    const bits = [];\n    for (const k of [\"5h\", \"7d\", \"weekly\", \"secondary\", \"primary\"]) {\n      if (buckets[k] && buckets[k].usedPct != null) bits.push(k + \" \" + buckets[k].usedPct + \"%\");\n    }\n    const label = (d.snapshot && d.snapshot.label) || d.accountId;\n    const extra = bits.length ? \" (\" + bits.join(\", \") + \")\" : \"\";\n    console.error(\"[qlb] advisory: use account \" + label + extra);\n  ' \"$json\" 2>/dev/null || true\n}";

const PI_HOOK_RELATIVE = 'scripts/hooks/pi-advisory.sh';

const PI_HOOK_HEADER = `# qlb_advisory — sourceable Pi dispatch helper.
# Usage: source scripts/hooks/pi-advisory.sh
#        qlb_advisory "$model"
# Call it BEFORE any dispatch/exec line. Purely informational — never changes
# which provider/model/account is actually dispatched.
`;

export function piAdvisoryFileContents(): string {
  return `${PI_HOOK_HEADER}\n${QLB_ADVISORY_FUNCTION}\n`;
}

export function findQlbRepoRoot(fromDir: string = __dirname): string | null {
  let dir = fromDir;
  for (let i = 0; i < 8; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (parsed.name === 'qlb') return dir;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function writePiAdvisory(repoRoot: string): string {
  const dest = join(repoRoot, PI_HOOK_RELATIVE);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, piAdvisoryFileContents(), { encoding: 'utf8' });
  return PI_HOOK_RELATIVE;
}

function piInstructions(snippetWritten?: string): string {
  const written = snippetWritten
    ? `Wrote ${snippetWritten} (source it, then call qlb_advisory "$model").`
    : `Save the function below as scripts/hooks/pi-advisory.sh, source it, then call qlb_advisory "$model".`;
  return [
    'QLB setup — Pi',
    '',
    'NON-DESTRUCTIVE: this command does not edit your dispatch script.',
    'Paste the function into your Pi dispatch script, or source the copy in this repo.',
    'Call qlb_advisory "$model" BEFORE any dispatch/exec line.',
    written,
    '',
    QLB_ADVISORY_FUNCTION,
    '',
    'Example:',
    '  source /path/to/qlb/scripts/hooks/pi-advisory.sh',
    '  qlb_advisory "$model" || true',
    '  exec pi --model "$model" ...',
  ].join('\n');
}

function claudeCodeInstructions(): string {
  return [
    'QLB setup — Claude Code',
    '',
    'NON-DESTRUCTIVE: copy these exports into the shell that launches Claude Code.',
    'QLB never auto-edits Claude Code config.',
    '',
    '1. Start the loopback proxy:  qlb proxy',
    '   It binds 127.0.0.1:<ephemeral-port> and writes ~/.qlb/proxy.json',
    '   (override with QLB_PROXY_INFO_PATH) mode 0600: { port, token, pid, startedAt }.',
    '',
    '2. Point Claude Code at the proxy. The proxy authenticates FIRST via',
    '   Authorization: Bearer <token>  OR  x-api-key: <token>',
    '   (see extractClientToken in src/proxy.ts). Allowed Claude paths:',
    '   POST /v1/messages  and  POST /v1/messages/count_tokens.',
    '   Host must be 127.0.0.1:<port> or localhost:<port>.',
    '',
    'Snippet:',
    '',
    'PROXY_JSON="${QLB_PROXY_INFO_PATH:-$HOME/.qlb/proxy.json}"',
    'if [ ! -f "$PROXY_JSON" ]; then',
    '  echo "start qlb proxy first (missing $PROXY_JSON)" >&2',
    '  return 1 2>/dev/null || exit 1',
    'fi',
    'PORT="$(node -e \'const i=require(process.argv[1]); process.stdout.write(String(i.port))\' "$PROXY_JSON")"',
    'TOKEN="$(node -e \'const i=require(process.argv[1]); process.stdout.write(String(i.token))\' "$PROXY_JSON")"',
    'export ANTHROPIC_BASE_URL="http://127.0.0.1:${PORT}"',
    '# Bearer (ANTHROPIC_AUTH_TOKEN) and x-api-key (ANTHROPIC_API_KEY) are both accepted.',
    'export ANTHROPIC_AUTH_TOKEN="$TOKEN"',
    'export ANTHROPIC_API_KEY="$TOKEN"',
    '',
    'Then start Claude Code in that same shell. Map virtual models with:',
    '  qlb policy set --harness claude-code --virtual-model <name> --real-model <id> --effort <lvl>',
  ].join('\n');
}

function codexCliInstructions(): string {
  return [
    'QLB setup — Codex CLI',
    '',
    'NON-DESTRUCTIVE: paste this into ~/.codex/config.toml yourself. QLB never writes that file.',
    '',
    '1. Start the loopback proxy:  qlb proxy',
    '   Reads ~/.qlb/proxy.json (or QLB_PROXY_INFO_PATH) for { port, token }.',
    '',
    '2. Codex CLI talks OpenAI-shaped POST /v1/responses. qlb-proxy accepts that',
    '   path and translates it to https://chatgpt.com/backend-api/codex/responses',
    '   (see ALLOWED_PATHS + upstreamUrl in src/proxy.ts). Auth is',
    '   Authorization: Bearer <token> or x-api-key: <token>.',
    '   Host must be 127.0.0.1:<port> or localhost:<port>.',
    '',
    'Shell (fills port + token, then print the snippet):',
    '',
    'PROXY_JSON="${QLB_PROXY_INFO_PATH:-$HOME/.qlb/proxy.json}"',
    'PORT="$(node -e \'const i=require(process.argv[1]); process.stdout.write(String(i.port))\' "$PROXY_JSON")"',
    'TOKEN="$(node -e \'const i=require(process.argv[1]); process.stdout.write(String(i.token))\' "$PROXY_JSON")"',
    'export QLB_PROXY_TOKEN="$TOKEN"',
    '',
    '~/.codex/config.toml snippet (substitute PORT from proxy.json):',
    '',
    '[model_providers.qlb]',
    'name = "QLB"',
    'base_url = "http://127.0.0.1:PORT/v1"',
    'env_key = "QLB_PROXY_TOKEN"',
    'wire_api = "responses"',
    '',
    '[profiles.qlb]',
    'model_provider = "qlb"',
    '',
    'Then:  export QLB_PROXY_TOKEN="<token from proxy.json>"',
    'Map virtual models with:',
    '  qlb policy set --harness codex --virtual-model <name> --real-model <id> --effort <lvl>',
  ].join('\n');
}

function genericInstructions(): string {
  return [
    'QLB setup — generic (Hermes, cron, CI, any shell job runner)',
    '',
    'NON-DESTRUCTIVE: QLB has no knowledge of other codebases. This is a CLI',
    'call + JSON parse — no special integration, no files written outside this repo.',
    '',
    'Snippet:',
    '',
    '# Works for ANY shell-based job runner (cron jobs, CI, custom orchestrators):',
    '# qlb resolve --json, then parse the account/model decision.',
    'MODEL="${MODEL:-claude-sonnet-5}"',
    'FALLBACK="${FALLBACK:-claude-sonnet-5,grok-4.6}"',
    'decision="$(qlb resolve --model "$MODEL" --fallback "$FALLBACK" --json)" || true',
    'account="$(printf \'%s\\n\' "$decision" | jq -r \'.accountId // empty\')"',
    'served="$(printf \'%s\\n\' "$decision" | jq -r \'.servedModel // empty\')"',
    'if [ -z "$account" ] || [ "$(printf \'%s\\n\' "$decision" | jq -r \'.error // empty\')" = "EXHAUSTED" ]; then',
    '  echo "qlb: no account (exhausted or unavailable); using caller default" >&2',
    'else',
    '  echo "qlb: account=$account served=$served" >&2',
    '  # hand $account / $served to your runner',
    'fi',
    '',
    'Without jq, a tiny inline parser:',
    '  node -e \'const d=JSON.parse(process.argv[1]); if(!d||d.error||!d.accountId) process.exit(1); console.log(d.accountId+" "+d.servedModel)\' "$decision"',
  ].join('\n');
}

export interface SetupOptions {
  /** Tests pass a temp repo root. CLI omits this and walks up from __dirname. */
  repoRoot?: string | null;
}

export function setupHarness(harness: SetupHarness, opts: SetupOptions = {}): SetupResult {
  if (harness === 'pi') {
    const root = opts.repoRoot === undefined ? findQlbRepoRoot() : opts.repoRoot;
    const snippetWritten = root ? writePiAdvisory(root) : undefined;
    return {
      harness,
      instructions: piInstructions(snippetWritten),
      ...(snippetWritten ? { snippetWritten } : {}),
    };
  }
  if (harness === 'claude-code') {
    return { harness, instructions: claudeCodeInstructions() };
  }
  if (harness === 'codex-cli') {
    return { harness, instructions: codexCliInstructions() };
  }
  return { harness, instructions: genericInstructions() };
}
