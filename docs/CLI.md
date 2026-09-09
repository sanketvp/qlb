# CLI reference

Every subcommand of `qlb`. All examples below were captured from real runs of the built CLI; outputs that would depend on real credentials are shown from a sandboxed environment (`QLB_CONFIG_PATH` pointing at a temp config with no live accounts), so account labels are generic and the shapes are exactly what the tool prints.

Global behavior:

- Configuration resolves in this order: CLI flag → environment variable → `~/.qlb/config.json` → built-in default. `--config` or `QLB_CONFIG_PATH` selects a different config file. See the [README](../README.md#configuration) for the full field/env/flag table.
- `qlb <command> --json` always exists where output is structured, and `--json` output is additive (fields are kept, not renamed).
- Exit codes: `0` on success, `1` on "ran but nothing available" (e.g. `EXHAUSTED`, doctor `FAIL`), `2` on a refused destructive operation.

## `qlb init`

Detect existing credential sources, report what's missing, and write a reviewable starter config at `~/.qlb/config.json` (kept if one already exists). Never prompts — safe in scripts and CI.

```console
$ qlb init --json
{
  "command": "init",
  "overall": "WARN",
  "configPath": "/tmp/qlb-docs-demo/config.json",
  "configWritten": false,
  "configured": {
    "anthropicPoolPath": "/tmp/qlb-docs-demo/anthropic-pool.json",
    "dbPath": "/tmp/qlb-docs-demo/qlb.db",
    "pluginsDir": "/tmp/qlb-docs-demo/plugins"
  },
  "providers": [
    {
      "provider": "anthropic",
      "level": "PASS",
      "source": "/tmp/qlb-docs-demo/anthropic-pool.json",
      "envVar": "QLB_ANTHROPIC_POOL_PATH",
      "example": "export QLB_ANTHROPIC_POOL_PATH=~/.pi/agent/anthropic-pool.json",
      "message": "credential source found: /tmp/qlb-docs-demo/anthropic-pool.json"
    },
    {
      "provider": "xai",
      "level": "WARN",
      "source": "/tmp/qlb-docs-demo/auth.json (xai entry)",
      "envVar": "QLB_PI_AUTH_JSON_PATH",
      "example": "export QLB_PI_AUTH_JSON_PATH=~/path/to/pi-auth.json",
      "message": "credential source not found; set QLB_PI_AUTH_JSON_PATH. Example: export QLB_PI_AUTH_JSON_PATH=~/path/to/pi-auth.json"
    }
    // … openai-codex, kimi-coding, openrouter follow the same shape
  ]
}
```

Flags: `[--json]`.

## `qlb doctor`

Local checks only by default: SQLite open + `integrity_check`, incomplete migrations, Keychain reachability, then one line per provider credential source. Add `--live` to opt into provider network calls.

```console
$ qlb doctor
[PASS] sqlite: database opens and integrity_check passes: /tmp/qlb-docs-demo/qlb.db
[PASS] migrations: no incomplete migrations detected
[PASS] keychain: macOS Keychain command is reachable
[PASS] anthropic: credential source found: /tmp/qlb-docs-demo/anthropic-pool.json
[WARN] xai: credential source not found; set QLB_PI_AUTH_JSON_PATH. Example: export QLB_PI_AUTH_JSON_PATH=~/path/to/pi-auth.json
[WARN] openai-codex: credential source not found; set QLB_CODEX_AUTH_JSON_PATH. Example: export QLB_CODEX_AUTH_JSON_PATH=~/path/to/codex-auth.json
[WARN] kimi-coding: credential source not found; set QLB_KIMI_CREDENTIALS_FILE. Example: export QLB_KIMI_CREDENTIALS_FILE=~/path/to/file-containing-sk-kimi-key
[WARN] openrouter: credential source not found; set QLB_OPENROUTER_KEYCHAIN_SERVICE. Example: security add-generic-password -s <service> -a qlb -w '<key>'
Overall: WARN
```

Flags: `[--json] [--live]`. Exit `1` when overall is `FAIL`.

For QLB-owned accounts, doctor also runs a native-credential drift check (one `[PASS]`/`[WARN]` line per owned account, name `native-sync:<accountId>`) — see [CREDENTIAL-SAFETY.md](CREDENTIAL-SAFETY.md#native-credential-drift-the-shadow-retain-tradeoff).

## `qlb native-resync`

Compare a QLB-owned credential with the provider's current native credential and resync QLB's Keychain copy if they differ. This is the manual trigger for the same fingerprint-compare-and-resync the proxy runs automatically on an auth failure — mechanism and the differ-vs-identical semantics are described in [CREDENTIAL-SAFETY.md](CREDENTIAL-SAFETY.md#native-credential-drift-the-shadow-retain-tradeoff). It is one Keychain overwrite at most, never a re-migration, and exits `0` either way:

```console
$ qlb native-resync --provider kimi-coding --account acct-kimi
unchanged: native credential identical to QLB copy (genuine revocation; re-auth required)

$ qlb native-resync --provider kimi-coding --account acct-kimi --json
{"resynced":true,"reason":"native credential differed from QLB copy for kimi-coding/acct-kimi; Keychain updated"}
```

`resynced: true` means native had refreshed independently and QLB's copy was updated — whatever failed with an auth error is safe to retry. `resynced: false` with the "genuine revocation" reason means the credential is dead for real and needs a native re-login; QLB deliberately does not retry in that case.

Flags: `--provider <anthropic|xai|kimi-coding|openai-codex|openrouter>` (required), `--account <id>` (required), `[--db <path>]`, `[--json]`.

## `qlb status`

The dashboard view (default): one block per account with a health glyph, credential-ownership state, and any active override, then indented bucket rows.

| Glyph | Meaning |
|---|---|
| `✓` | every bucket under 80% |
| `⚠` | any bucket 80–99% |
| `✗` | any bucket at 100%, or the account has an error |

```console
$ qlb status
✓  Kimi K3  kimi-coding  NATIVE  override=none
     5h  4%  authoritative  resets in 2h 2m
     weekly  64%  authoritative  resets in 88h 2m
✓  Grok (xAI)  xai  NATIVE  override=none
     requests  0%  advisory  resets -
     tokens  0%  advisory  resets -
✓  alice@example.com  anthropic  NATIVE  override=none
     5h  2%  authoritative  resets in 4h 50m
     7d  31%  authoritative  resets in 124h 40m
     7d:Fable  14%  authoritative  resets in 124h 40m
⚠  bob@example.com  anthropic  NATIVE  override=none
     5h  2%  authoritative  resets in 3h 10m
     7d  60%  authoritative  resets in 67h 40m
     7d:Fable  87%  authoritative  resets in 67h 40m
✗  codex-default  openai-codex  NATIVE  override=none
     error: no valid Codex credentials found in /tmp/qlb-docs-demo/codex-auth.json
```

(First two blocks and the error block are captured output with generic labels; glyph rules and line format are exactly as implemented in `src/dashboard.ts`.)

`--flat` shows the original bucket table:

```console
$ qlb status --flat
provider     | account           | bucket | used | confidence    | resets
kimi-coding  | Kimi K3           | 5h     | 4%   | authoritative | resets in 2h 2m
kimi-coding  | Kimi K3           | weekly | 64%  | authoritative | resets in 88h 2m
xai          | Grok (xAI)        | tokens | 0%   | advisory      | resets -
anthropic    | alice@example.com | 5h     | 2%   | authoritative | resets in 4h 50m
anthropic    | alice@example.com | 7d     | 31%  | authoritative | resets in 124h 40m
anthropic    | bob@example.com   | 7d:Fable | 87% | authoritative | resets in 67h 40m
openrouter   | OpenRouter        | credits | 39.88% | authoritative | resets -
```

An account with a problem shows an `error` row with the reason in the resets column:

```console
anthropic    | bob@example.com   | - | - | error | resets auth expired or invalid — needs re-login
```

`--json` keeps `{fetchedAt, accounts}` and adds `ownership`, `override`, `health`, `healthGlyph` per account (additive — existing fields unchanged):

```json
{
  "fetchedAt": 1788844834325,
  "accounts": [
    {
      "accountId": "acct-a",
      "provider": "anthropic",
      "label": "alice@example.com",
      "buckets": {
        "5h": {
          "usedPct": 2,
          "source": "poll",
          "confidence": "authoritative",
          "fetchedAt": 1788844834100,
          "resetAt": 1788846834100,
          "windowMin": 300
        }
      },
      "ownership": "NATIVE",
      "override": null,
      "health": "ok",
      "healthGlyph": "✓"
    }
  ]
}
```

Flags: `[--json] [--dashboard|--flat]`.

## `qlb resolve`

Ask QLB to pick an account (and possibly a fallback model) for a request. Purely advisory unless something consumes its output: it fetches fresh gauges for the relevant provider(s), scores candidates, records an audit row, and prints the decision.

```console
$ qlb resolve --model claude-sonnet-5 --fallback claude-opus-4 --session <uuid> --harness dispatch --json
```

Successful JSON shape (from `src/resolve.ts`):

```json
{
  "decisionId": 42,
  "provider": "anthropic",
  "accountId": "acct-a",
  "model": "claude-sonnet-5",
  "requestedModel": "claude-sonnet-5",
  "servedModel": "claude-sonnet-5",
  "reason": "headroom score 20 (ceiling 80)",
  "mode": "headroom",
  "snapshot": {
    "accountId": "acct-a",
    "provider": "anthropic",
    "label": "alice@example.com",
    "buckets": {
      "5h":     { "usedPct": 60, "confidence": "authoritative", "source": "poll", "fetchedAt": 1788844834100 },
      "7d":     { "usedPct": 30, "confidence": "authoritative", "source": "poll", "fetchedAt": 1788844834100 },
      "7d:Fable": { "usedPct": 45, "confidence": "authoritative", "source": "poll", "fetchedAt": 1788844834100 }
    }
  }
}
```

`mode` is one of `headroom`, `all-in`, `fallback`, `fallback-all-in` (or `exhausted` in the audit row). When the served model differs from the requested one, the human output prints `⚠ served by <model>` prominently — substitution is never silent.

When every candidate is exhausted:

```console
$ qlb resolve --model claude-sonnet-5 --json
{
  "error": "EXHAUSTED",
  "requestedModel": "claude-sonnet-5",
  "earliestReset": {
    "accountId": "acct-b",
    "at": 1788852000000,
    "limitType": "5h"
  },
  "decisionId": 43
}
```

(`earliestReset` is `null` when no candidate has a known reset time.) Exit code `1`.

Flags: `--model <modelId>` (required), `[--fallback m1,m2,...]`, `[--session <id>]`, `[--harness pi|claude-code|codex|dispatch]`, `[--effort <lvl>]`, `[--strategy headroom|spread|round-robin|failover]` (default `headroom`, or `defaultStrategy` from config), `[--json]`. Model → provider mapping is documented in `src/scoring.ts`: `claude*` → anthropic, `gpt-*`/`*sol*`/`*astra*`/`*luna*`/`*terra*` → openai-codex, `*grok*` → xai, `*k3*`/`*kimi*` → kimi-coding, `openrouter/*`, `z-ai/*`, `*glm*` → openrouter.

Strategies:

- `headroom` — existing Rule-S score, single best account, headroom-then-all-in (default; unchanged).
- `spread` — same scoring, but near-tied candidates (within `SPREAD_MARGIN` = 10) are split across session ids via a deterministic hash of `--session`. No session id → falls back to `headroom`.
- `round-robin` — ignore scores except to skip exhausted/error accounts; cycle in account-id order using a SQLite counter.
- `failover` — stick to the current account while every relevant bucket is under 100%; switch only when it is genuinely exhausted.

## `qlb override`

Explicit pin / reserve / drain-first over the existing `overrides` table. This is what makes **deliberate multi-account parallel use** possible: automatic scoring picks one best account, but you can pin different sessions to different accounts for a guaranteed parallel spread, take an account out of rotation entirely, or bias traffic toward one account to drain it. `--until` is an ISO datetime or a duration like `2h` / `30m` / `1d`. When omitted, the default lifetime is **24 hours from now**.

```console
$ qlb override pin --session synth-session-1 --account acct-a --until 2h --json
$ qlb override reserve --account acct-b --json
$ qlb override drain-first --account acct-c --json
$ qlb override list --json
{ "overrides": [] }
$ qlb override clear --all --json
```

- `pin` — `resolve --session <id>` always returns that account (bypassing scoring). If the pinned account is unusable, resolve fails with `PINNED_UNAVAILABLE` rather than silently substituting.
- `reserve` — exclude the account from automatic selection for every session.
- `drain-first` — consider this account before the others until it is exhausted.
- `clear` — `--session`, `--account`, or `--all`.
- `list` — active (non-expired) rows only.

## `qlb policy`

Virtual-model mapping for the proxy: harnesses like Claude Code can only send a model string, so QLB resolves the whole policy (real model, effort, fallback, session mode) from the name.

```console
$ qlb policy set --harness claude-code --virtual-model 'claude-sonnet-5--qlb-high' \
    --real-model claude-sonnet-5 --effort high --fallback opus
set claude-code claude-sonnet-5--qlb-high → claude-sonnet-5 effort=high

$ qlb policy list
claude-code  claude-sonnet-5--qlb-high  →  claude-sonnet-5  effort=high  fallback=opus  session=header

$ qlb policy list --json
{
  "policies": [
    {
      "harness": "claude-code",
      "virtualModel": "claude-sonnet-5--qlb-high",
      "realModel": "claude-sonnet-5",
      "effort": "high",
      "fallback": ["opus"],
      "sessionMode": "header",
      "createdAt": 1788844843482
    }
  ]
}
```

`qlb policy set` flags: `--harness <claude-code|codex>`, `--virtual-model <name>` (alias `--virtual`), `--real-model <id>` (alias `--real`), `--effort <low|medium|high|max>`, `[--fallback m1,m2]`, `[--session-mode header|anon]`, `[--db <path>]`, `[--json]`.

The proxy enforces policies fail-closed: a request for an unmapped model gets a `400` in the harness's native error shape with the exact fix:

```
QLB: no policy for model 'X' (harness claude-code).
Run: qlb policy set --harness claude-code --virtual-model 'X' --real-model <model> --effort <lvl>
```

## `qlb migrate`

The credential-ownership state machine: `NATIVE → MIRRORED → VALIDATED → QLB_OWNED → RETIRED`. Stage copies credentials into QLB's Keychain as *staging*, rehearse proves them with a live call, commit flips ownership with a single atomic file rename, rollback/resume converge after any interruption. See [CREDENTIAL-SAFETY.md](CREDENTIAL-SAFETY.md) for the guarantees.

```console
$ qlb migrate status --pool-file /tmp/demo/anthropic-pool.json --owner-file /tmp/demo/qlb-owner.json --db /tmp/demo/qlb.db
store:     pi-pool
strategy:  rename
state:     NATIVE
owner:     absent
native:    intact
pi next:   native works
resume:    noop
```

`--json` shape:

```json
{
  "store": "pi-pool",
  "state": "NATIVE",
  "updatedAt": null,
  "ownerFile": "absent",
  "nativeStore": "intact",
  "piAtNextLaunch": "native works",
  "resumeAction": "noop",
  "detail": {},
  "nativeStrategy": "rename"
}
```

Subcommands: `stage`, `rehearse`, `commit`, `rollback`, `resume`, `status`. Common flags: `[--provider anthropic|xai|kimi-coding|openai-codex|openrouter]`, `[--pool-file <path>]`, `[--owner-file <path>]`, `[--auth-json <path>]`, `[--target-dir <path>]`, `[--db <path>]`, `[--json]`.

**The safety interlock** — mutating subcommands that resolve to the real `~/.pi/agent/` credential files are refused unless `--confirm-real-cutover` is also passed:

```console
$ qlb migrate stage
REFUSED: resolved native / owner path is inside ~/.pi/agent/.
This would perform a REAL Pi credential cutover.
Pass --pool-file / --auth-json and --owner-file pointing at a temp copy,
or pass --confirm-real-cutover if you truly intend to cut over live Pi.
(exit 2)
```

Each provider has a different native strategy, shown as `strategy:`: Anthropic's dedicated pool file is `rename` (moved to `.pre-qlb` on commit); the shared multi-provider `auth.json` entries (xai, kimi-coding, openai-codex) are `shadow-retain` (QLB never deletes or renames the shared file); OpenRouter's static Keychain key is `keychain-retain` (read-only, QLB never writes that Keychain service).

## `qlb retire`

Phase-4 gate for moving a native harness credential store aside after QLB ownership has been proven in production.

```console
$ qlb retire status --harness claude-code
harness:    claude-code
eligible:   no
state:      (none)
committed:  (none)
ok:         0 / 20
failed:     0
reasons:
  - no migration recorded for harness 'claude-code'
  - migration state is not QLB_OWNED
  - soak period not met: no migration commit timestamp (need 7 days)
  - only 0 of 20 clean (outcome=ok) decisions recorded for harness 'claude-code'
(exit 1)
```

`retire execute` requires **all** eligibility gates to pass (state `QLB_OWNED`, 7-day soak, 20 clean decisions, live ping through the new path) **and** an explicit confirmation flag:

```console
$ qlb retire execute --harness claude-code
REFUSED: qlb retire execute requires --confirm-real-retirement.
This would retire a native Claude Code / Codex CLI credential store.
Run `qlb retire status --harness <h>` (read-only) first.
(exit 2)
```

Flags: `--harness <claude-code|codex-cli>` (required), `[--confirm-real-retirement]` (execute only), `[--db <path>]`, `[--json]`.

## `qlb accounts`

Maintenance for the local account store. Currently one subcommand, `prune`, for removing a stale/orphaned account row — e.g. a duplicate account ID left behind after a native credential file was hand-edited, whose corresponding `accounts`/`snapshots` rows were never cleaned up.

```console
$ qlb accounts prune --account account-1699999999999 --confirm --json
{
  "ok": true,
  "accountId": "account-1699999999999",
  "removed": { "accounts": 1, "snapshots": 3, "overrides": 0, "pollClaims": 0, "leases": 0 }
}
```

Deletes the account's rows from `accounts`, `snapshots`, `overrides`, `poll_claims`, and the account's refresh `leases` row. `decisions` rows are left untouched (audit history, not live state). **Refused unconditionally** if the account is currently QLB_OWNED / RETIRED or participating in an in-flight migration (`MIRRORED` / `VALIDATED`) — i.e. its ID appears in the `qlbAccountIds` (or `accounts[].id`) list of any `migrations` row in those states, or if such a row's `detail_json` cannot be trusted:

```console
$ qlb accounts prune --account account-1 --confirm
REFUSED: account 'account-1' is QLB_OWNED (via store 'pi-pool', state QLB_OWNED); will not prune a real owned account
(exit 2)
```

Also refused without `--confirm`, or if the account id doesn't exist. Flags: `--account <id>` (required), `--confirm` (required), `[--db <path>]`, `[--json]`.

## `qlb setup`

Non-destructive harness wiring: prints copy-paste snippets only, never edits files outside this repo.

```console
$ qlb setup claude-code
QLB setup — Claude Code

NON-DESTRUCTIVE: copy these exports into the shell that launches Claude Code.
QLB never auto-edits Claude Code config.

1. Start the loopback proxy:  qlb proxy
   It binds 127.0.0.1:<ephemeral-port> and writes ~/.qlb/proxy.json
   (override with QLB_PROXY_INFO_PATH) mode 0600: { port, token, pid, startedAt }.

2. Point Claude Code at the proxy. [...]
export ANTHROPIC_BASE_URL="http://127.0.0.1:${PORT}"
export ANTHROPIC_AUTH_TOKEN="$TOKEN"
export ANTHROPIC_API_KEY="$TOKEN"
```

Harnesses: `pi` (additionally writes a sourceable `scripts/hooks/pi-advisory.sh` inside this repo and reports the path), `claude-code`, `codex-cli` (prints the `~/.codex/config.toml` `[model_providers.qlb]` block), `generic` (a `qlb resolve --json` + `jq` snippet for cron/CI/any shell runner). Flags: `[--json]` → `{ harness, instructions, snippetWritten? }`.

## `qlb gate codex`

The Codex CLI compatibility gate (G0–G4 from the design spec): verifies that Codex CLI requests actually work through the proxy against the real Codex backend with QLB-supplied credentials, and records a `GO` / `NO-GO` verdict. Makes a handful of real quota-consuming requests (uses `~/.codex/auth.json` read-only) — **never run casually**; automated tests never take this path.

Human output shape:

```console
$ qlb gate codex
verdict:  GO
version:  0.42.0
time:     2026-09-08T12:00:00.000Z
path:     path1
  G0  pass  captured request body shape (model, input/instructions, stream)
  G1  pass  3/3 exec pings through proxy
  G2  pass  tool round-trip
  G4  pass  streaming parity
```

(Fields per `CodexGateResult` in `src/codex-gate.ts`: `{ verdict, timestamp, codexVersion, steps: [{ step, passed, skipped?, detail }], path? }`. The exact step list depends on which path passes.) Exit `0` only on `GO`. Flags: `[--json] [--db <path>]`.

## `qlb proxy`

Start the loopback selection proxy (foreground process; `SIGINT`/`SIGTERM` stop it gracefully). Binds `127.0.0.1` on an OS-assigned port, writes `{ port, token, pid, startedAt }` mode-0600 to `~/.qlb/proxy.json`, and exits by itself after an idle timeout with zero in-flight requests (default 10 minutes, never mid-stream).

```console
$ qlb proxy
qlb-proxy listening on 127.0.0.1:52134 (token in /Users/you/.qlb/proxy.json, mode 0600)
```

```console
$ qlb proxy --json
{
  "port": 52134,
  "pid": 41234,
  "startedAt": 1788844900000,
  "infoPath": "/Users/you/.qlb/proxy.json"
}
```

Flags: `[--info-path <path>]`, `[--idle-ms <n>]` (positive integer), `[--db <path>]`, `[--json]`. Security posture: loopback-only bind (refuses anything else), per-launch random 32-byte token, constant-time token comparison, `Host` header allow-list, path allow-list (`/v1/messages`, `/v1/messages/count_tokens`, `/v1/responses`, `/backend-api/codex/responses`, `/qlb/health`), local auth-failure rate limiting, and credentials injected only for providers whose migration journal says `QLB_OWNED` or `RETIRED`.

## `/qlb` (Pi in-session command)

When `qlb-pi` is active (see [README · qlb-pi footer](../README.md#qlb-pi-footer)), Pi registers an in-session `/qlb` command (`extensions/qlb-pi/index.ts`, `pi.registerCommand('qlb', ...)`):

| Command | Effect |
|---|---|
| `/qlb` (no args), or `/qlb status` | Runs `qlb status --json` and shows the result via a Pi notification. |
| `/qlb migrate` | Runs `qlb migrate status --json` and shows the result the same way. |
| `/qlb expand` (alias `/qlb details`) | Toggles the footer's expanded detail panel — the same panel opened by the `ctrl+alt+q` shortcut. |

All three are read-only from the extension's side (they only shell out to `qlb status`/`qlb migrate status`, or toggle a UI panel) and fail open: a failed `qlb` invocation is reported via a notification rather than crashing the session.

## Not yet wired (honest gaps)

- **Probes from the CLI.** Codex/xAI readings in the CLI path come from organic traffic (xAI via its minimal probe inside the adapter, coalesced single-flight) and from the proxy's header parsing; the spec's `qlb refresh --allow-probe` / `qlb audit` / `qlb why` surface is not implemented yet.
