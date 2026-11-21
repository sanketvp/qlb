# CLI reference

Every subcommand of `qlb`. All examples below were captured from real runs of the built CLI; outputs that would depend on real credentials are shown from a sandboxed environment (`QLB_CONFIG_PATH` pointing at a temp config with no live accounts), so account labels are generic and the shapes are exactly what the tool prints.

Global behavior:

- Configuration resolves in this order: CLI flag → environment variable → `~/.qlb/config.json` → built-in default. `--config` or `QLB_CONFIG_PATH` selects a different config file. See the [README](../README.md#configuration) for the full field/env/flag table.
- `qlb <command> --json` always exists where output is structured, and `--json` output is additive (fields are kept, not renamed).
- Exit codes: `0` on success, `1` on "ran but nothing available" (e.g. `EXHAUSTED`, doctor `FAIL`) and on `DUAL_OWNERSHIP_REFUSED`, `2` on a usage error or a refused destructive operation, `3` on a fail-closed refusal that must not print a credential (the S30 gate's `token-call-refused`, and lifecycle refusals such as `qlb gate: refused: <code>`).

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
[WARN] openrouter: credential source not found in fixed pi-openrouter service. Example: security add-generic-password -s pi-openrouter -a qlb -w '<key>'
Overall: WARN
```

Flags: `[--json] [--live]`. Exit `1` when overall is `FAIL`. `qlb doctor --list-checks --json` lists the exact registered check names emitted by `qlb doctor --json`; checks not applicable on this host report as passing skips.

Beyond the core and per-provider lines, doctor also reports provider-usage comparisons and adds integration checks when the thing they inspect is present. QLB reads the Hermes config with the `yaml` package and never writes it:

| Check | Reported when | What it tells you |
| --- | --- | --- |
| `usage:provider-discrepancies` | always; `N/A` when the QLB database does not exist yet | Reads the last 30 days of provider-authority records without changing them. `WARN` reports provider/QLB disagreements or malformed direct-provider percentages; when values disagree, the direct-provider value remains canonical. `PASS` means no such records are retained. |
| `fs:stray-temps` | always | Lists QLB atomic-write temporary files that are over 60 seconds old and whose owner PID is no longer running. It never reads their contents, modifies, or deletes them; `WARN` includes their paths, and also identifies any configured directory it could not inspect. |
| `claude:active` | always; `N/A` in recognized non-cutover phases and when no Claude slots exist, and `WARN` when lifecycle state is unavailable or unknown | During `cutting-over`, `cutover`, or `retired`, verifies without reading credentials that the active Claude login is set and names a live, unarchived slot. `FAIL` means it is unset, missing, dead, or archived; `WARN` means the active slot requires re-login; `PASS` identifies the active account and when it was set. |
| `claude:login-expiry` | always | Reads each live Claude slot through QLB's read-only managed Keychain entry; it never refreshes credentials or writes Keychain state. `FAIL` means a reported login expiry has passed, `WARN` means it is within seven days or the slot credential cannot be read or parsed, and `PASS` means there are no live slots or no reported expiry has passed or is within seven days. This advisory row never blocks S64. |
| `claude:version-drift` | always | Compares the non-secret Claude Code version recorded by `qlb lifecycle sentinels record` with a read-only `claude --version` result. It reports `INFO` when no version is recorded, `PASS` when the installed version equals the recorded sentinel, `WARN` when the values differ or Claude Code cannot run, and never blocks S64. |
| `claude:unclaimed` | always; `N/A` before `cutover` and `WARN` when lifecycle state is unavailable or unknown | During `cutover` or `retired`, reads only non-secret Anthropic successor-stash index metadata; it never opens a Keychain item or fallback body. `WARN` identifies stashes older than 30 days and prints their `qlb claude restore-unclaimed <stash> <slot>` recovery commands; `INFO` counts newer stashes. `FAIL` means the index is unavailable or contains malformed metadata, and blocks S64 retirement until repaired. |
| `claude:unpersisted-token` | always; `N/A` before `cutover` and `WARN` when lifecycle state is unavailable or unknown | During `cutover` or `retired`, reads `switch_log` refusals, durable `usage_polls` evidence, and `auto.log` lines without opening credentials. `FAIL` names live slots whose refresh successor was lost and blocks S64 until the slot is re-logged in or its credential lineage otherwise changes; dead and archived slots are ignored. If `auto.log` cannot be read and database evidence is clean, it reports `WARN`. |
| `claude:switch-journal` | always; `N/A` outside recognized Claude cutover phases and `WARN` when lifecycle state is unavailable | During `cutting-over`, `cutover`, or `retired`, checks the Claude switch journal without changing it. `FAIL` means the journal is malformed or its owner is no longer live before the switch finished; use `qlb claude journal resolve --forward` or `--back` to reconcile it. An invalid journal identity is also a `FAIL`; resolve refuses it. |
| `journal:in-progress` | always; `N/A` outside recognized Claude cutover phases and `WARN` when lifecycle state is unavailable | During `cutting-over`, `cutover`, or `retired`, reports `INFO` for a live, unfinished Claude switch journal or a fresh C-swap import lock; `PASS` means neither is in progress. |
| `journal:orphaned` | always; `N/A` outside recognized Claude cutover phases and `WARN` when lifecycle state is unavailable | During `cutting-over`, `cutover`, or `retired`, reports `FAIL` for a C-swap import journal that requires recovery. In `cutting-over` or `cutover`, reconcile classifiable journals with `qlb import cswap --reconcile`; inspect unclassifiable journals manually. Reconciliation is unavailable in `retired`. `PASS` means no reconciliation is needed. |
| `consume:marker` | cswap consume is enabled, or a consume marker file exists | `PASS` when the journal says `CONSUMED` and the marker is present. `FAIL` when `CONSUMED` but the marker is missing (new Pi sessions will not use cswap). `WARN` when the marker exists without `CONSUMED` (Pi refuses Anthropic until reconciled). |
| `undo:incomplete` | always | `FAIL` while the lifecycle is `undoing`, or when a rolled-back or aborted lifecycle retains the `cswap-restore-pending` fence; resume recovery with `qlb undo cswap --resume`. `PASS` when no incomplete undo remains, and `N/A` outside undo-related lifecycle phases. |
| `undo:lineage-match` | always; `N/A` outside terminal undo phases and `WARN` when lifecycle state is unavailable | Reads QLB and C-swap Keychain credentials without changing either. `PASS` when every lineage matches and no encrypted fallback remains. `WARN` when a readable C-swap credential rotated after a completed hand-back. `FAIL` for malformed hand-back structure, missing or malformed C-swap credentials, required-state/refusal failures, unavailable credential reads, or a leftover encrypted fallback. `N/A` when the lifecycle was not produced by undo or is outside terminal undo phases. |
| `pi:extension` | always, except when Pi and the extension are installed but the QLB repo root cannot be located | `PASS` when the installed `~/.pi/agent/extensions/qlb-pi` tree and its shared sources match this repo, or when Pi / the extension is not installed. Shared sources are `redact.ts` and `pi-owner-document.ts` beside the resolved extensions directory (`~/.pi/agent/src/` when `extensions` is a real directory). `WARN` when the installed copy has drifted (the fix is `qlb pi deploy`, which publishes the current release rather than a hand copy) or the Pi package behind the launcher on `PATH` cannot be located (set `QLB_PI_PACKAGE_ROOT`). |
| `pi:extension-drift` | always | Compares that same install with the extension inside `~/.qlb/app/current`, not with the git checkout. `PASS` when `pi.deployedAt` is recorded and the installed hash, the recorded `pi.extensionHash`, and the current-release hash are the same (`installed qlb-pi deployment hash matches the current release`). `WARN` when nothing has been deployed (`not deployed`), the deployment record cannot be read, or the current release cannot be planned. `FAIL` when the hash differs (`installed qlb-pi deployment hash differs from the current release`), a legacy `.qlb-pi-` staging directory is still under `extensions`, or the installed tree is unavailable. `qlb release install` followed by `qlb pi deploy` makes this row pass. `pi:extension` passes with it when this repo's `extensions/qlb-pi` matches those same bytes. |
| `pi:seam:<name>` | Pi and the extension are installed | One line per Pi API the extension depends on (`anthropicMessagesApi`, `registerProvider`, `model_select`, `after_provider_response`); flags a Pi upgrade that removed one. |
| `pi:typecheck` | `--live` only | Typechecks the extension against the Pi you actually run. |
| `hermes:checkout` | no Hermes checkout at `~/.hermes/hermes-agent` | `PASS`; all other Hermes checks are skipped. |
| `hermes:integration` | Hermes is installed but there is no trace of QLB in it | `WARN`; the other Hermes checks are skipped. This is the "off" state: the config is absent or, when parsed as YAML, has no `qlb-anthropic` / `qlb-codex` key and no `provider: custom:qlb-anthropic` / `custom:qlb-codex` value (including block, flow, and quoted YAML; comments and strings do not count); no QLB plugin directory or `qlb-proxy-token`, `qlb-hermes-watch`, or `qlb-hermes-models` script; and no proxy (`com.sanket.qlb-proxy` / `QLB_LAUNCHD_LABEL`) or watch (`com.sanket.qlb-hermes-watch` / `QLB_WATCH_LABEL`) plist. An unreadable or invalid config is not off. |
| `hermes:config` | there is some trace of QLB in Hermes | `FAIL` when the config cannot be read or parsed as YAML; `providers` is not a mapping; either QLB provider entry is absent or is not a mapping; either is missing `api`, `transport`, `key_cmd`, or `session_affinity_header`; or `qlb-codex.api` is not a URL ending in `/v1`. Repeated keys keep the last value and `<<` merge keys are resolved, as in Hermes' own YAML reader. `WARN` when the entries are intact but `model.provider` is not `custom:qlb-anthropic`. |
| `hermes:plugin` | same | `FAIL` when the QLB Hermes plugin is missing or its last load could not patch Hermes. `WARN` when it has not reported a load yet. |
| `hermes:codex-fix`, `hermes:branch` | same | The local Hermes patch for named custom Codex providers is present, and the checkout is not on `main`. |
| `hermes:proxy-supervisor` | same, macOS | `WARN` when the launchd proxy agent plist (`com.sanket.qlb-proxy`, or the label in `QLB_LAUNCHD_LABEL`) is missing. `qlb setup hermes` passes `QLB_LAUNCHD_LABEL` and `QLB_WATCH_LABEL` to the scheduled watch job, so custom labels are checked there too. `FAIL` when its port differs from the Hermes config. |
| `hermes:models`, `hermes:version` | same | The Hermes `/model` picker lists what QLB policies serve; the Hermes version marker. |
| `hermes:seam:<name>` | same, `--live` only | The Hermes symbols the plugin patches still exist with the expected signature. |

For QLB-owned accounts, doctor also runs the `native-sync` credential-drift check. `qlb doctor --list-checks --json` names the registered check `native-sync`; a live report emits one `native-sync:<accountId>` row per compared account (level and message on that row, with `provider` and `matches` in `detail`). The comparison is `inspectOwnedNativeDrift` in `src/native-resync.ts`. It is read-only: it does not write Keychain items, delete database rows, or otherwise touch credentials. See [CREDENTIAL-SAFETY.md](CREDENTIAL-SAFETY.md#native-credential-drift-the-shadow-retain-tradeoff) for the resync that runs later, on a real 401.

That check is broader than the owned Pi pool today. If `pi-pool` is `QLB_OWNED` or `RETIRED`, every Anthropic row in `accounts` is compared, including valid Claude Code switching accounts and historical rows that are not owned `pi-pool` members. Other providers are included the same way when their own `pi-<provider>` store is `QLB_OWNED` or `RETIRED`. A missing owned Keychain item and an unreadable one are the same WARN: `QLB Keychain copy unreadable`. A follow-up change is in progress so `inspectOwnedNativeDrift` scopes strictly to owned `pi-pool` members and distinguishes a missing Keychain item from an unreadable one. That follow-up still must not delete database rows or touch credentials. Until it lands, treat a `native-sync:<accountId>` WARN on a Claude Code switching account or a historical row as this scoping gap, not as a signal to prune the row or rewrite the Keychain item.

## `qlb report cutover`

Reports the completed Stage-1 cutover window. It lists correctness, coverage, fire-drill, injected-switch, final-24-hour health-history, doctor S64/automatic-agent, and migrated-Pi recent-service evidence; Pi and Codex rows marked `DEFERRED` are deliberate Stage-1 deferrals and do not prevent an otherwise complete Stage-1 report.

When doctor runs, the command appends its health-log row and atomically writes or clears the Stage-1 receipt (`report.receiptAt`, `report.receiptHealthLogId`, and its deferred marker). A failed health-log append adds a failing report row and emits `no receipt (...)` on stderr. A receipt with deliberate deferrals completes Stage 1 but cannot authorize C-swap retirement; retirement requires a later all-PASS receipt. For that deferred lifecycle only, a real Codex switch recorded after `window_end` can satisfy the deferred Codex coverage on the later report. The command may also perform its one-time S55 coverage extension: when fewer than ten qualifying Anthropic automatic switches are recorded and every correctness row passes, the first report after the initial seven-day window extends `window_end` to `cutover_at + 14 days`. The report prints `EXTEND`; collect the remaining coverage and run it again after the extended window ends.

Exit `0` only when every row is `PASS` or `DEFERRED`; exit `1` for `FAIL` or `EXTEND`; exit `3` when the report is refused (for example, before `window_end` or after a rollback). Flags: `[--json]`.

## `qlb auto`

Run QLB's Anthropic autoswitch loop. `--once` performs one live tick; `--dry-run` makes a decision without mutating state or switching credentials. The normal loop refuses to run while an active lifecycle drill is in progress.

On the verified Gate 5 host, `pi-pool` is `QLB_OWNED` and this loop is the Pi auto-switcher. It runs under the per-user LaunchAgent `com.modus.qlb-auto` (`~/Library/LaunchAgents/com.modus.qlb-auto.plist`). `qlb auto install-agent` writes that plist (mode `0600`) and does not call `launchctl`. The plist runs the release CLI:

```text
<node> ~/.qlb/app/current/dist/cli.js auto
```

`RunAtLoad` is true. `KeepAlive` restarts the loop unless it exited successfully (`SuccessfulExit` false), with `ThrottleInterval` 60. Stdout and stderr both append to `~/.qlb/auto.log`. Install `qlb release install` before `install-agent`, because the plist points at `~/.qlb/app/current`. A second live loop exits `3` with `qlb auto: auto-already-running`. `install-agent` prints `installed <plist path>` and exits `0`; a usage error exits `2` (`usage: qlb auto install-agent`) and a write failure exits `1`.

Automatic switching and parking use only fresh, direct provider quota readings. Cached, imported, stale, or advisory rows remain available for display but cannot create a quota verdict; when the active provider measurement is unavailable or a transient usage poll fails, the loop holds rather than switching on a synthetic exhaustion result.

For an authorized fault-injection drill, set `QLB_FAULT_INJECTION=1` and run:

```bash
qlb auto --once --inject usage-5xx anthropic
```

This synthetic active-usage failure records `http-500`, retains the prior usage snapshot, and makes the active reading unknown for that tick so the normal unknown-grace/failover policy is exercised. It does not read a Claude slot or live credentials, and does not make a usage request. The injection is accepted only with live `--once`; it is rejected for `--dry-run`, the continuous loop, and other `qlb auto` subcommands.

The credential-free breaker drill is `qlb auto --once --inject breaker-rows anthropic`. It does not poll, and refuses when a Claude switch journal exists or C-swap is alive. It leaves `auto.anthropic.suspendedUntil` set for one hour; run `qlb auto resume anthropic` to resume normal switching sooner.

`qlb lifecycle sentinels record [--json]` records the redacted, non-secret output of `claude --version` and its timestamp in QLB's store. It never reads credentials and is available in every lifecycle phase.

An active fire drill can finish with `qlb lifecycle drill-done` only after all four facts were recorded after the drill began: an injected `usage-5xx` failover, a rolled-back `qlb switch anthropic <account_id> --inject fail-step 8`, the injected `breaker-rows` refusal, and an undo hand-back plan. Record the last fact without changing credentials with `QLB_FAULT_INJECTION=1 qlb undo cswap --dry-run --record-drill`; `--record-drill` is accepted only with `--dry-run`. If any fact is missing, `drill-done` exits 3 and names the missing facts. `qlb retire cswap` rechecks this same evidence predicate before retirement.

Loop flags: `[--once] [--dry-run] [--json]`. Fault injection additionally requires `QLB_FAULT_INJECTION=1` and exactly `--once --inject <usage-5xx|breaker-rows> anthropic`. `install-agent` takes no flags. The full usage line is `qlb auto [--once] [--dry-run] [--json] | qlb auto --once [--json] --inject <usage-5xx|breaker-rows> anthropic | qlb auto install-agent | qlb auto resume anthropic [--json] | qlb auto scope anthropic [all|<model>] [--json] | qlb auto drill-begin [--json]`.

## `qlb auto scope anthropic`

Inspect or configure which Anthropic model-scoped usage windows participate in automatic switching.
The default `all` scope is fail-safe: every reported scoped window, including `7d:Fable`, can make an account ineligible.
For Opus work, use `opus` so an exhausted `7d:Fable` window does not disqualify an account that still has Opus headroom.
This command changes only QLB's non-secret local configuration.
It never reads credentials, forces a switch, changes account ownership, or bypasses lifecycle admission or the automatic-switch breaker.

```console
$ qlb auto scope anthropic
anthropic automatic model scope: all (unchanged)

$ qlb auto scope anthropic opus --json
{"provider":"anthropic","scope":"opus","changed":true,"parkedCleared":false}

$ qlb auto scope anthropic all
anthropic automatic model scope: all (updated)
```

Setting the current scope is idempotent.
Changing the scope clears only a parked automatic-switch marker calculated from the old candidate set, so the next normally admitted tick can evaluate the new scope without being held by stale parking. Active auto loops read the setting on every tick, so no agent restart is needed.
It does not clear a breaker hold or start a tick.
`all` restores the default scope.
A model name must contain only letters, digits, dots, underscores, or hyphens and must start with a letter or digit.

Apply the same setting independently on both hosts:

```bash
# MacBook Pro
qlb auto scope anthropic opus

# Mac Mini
qlb auto scope anthropic opus
```

Use `qlb auto scope anthropic all` on either host to restore the default/all scope there.
Flags: `[--json]`.

## `qlb refresh`

Poll every enabled adapter for a fresh gauge reading. Without `--allow-probe` this is a no-network no-op (exit 0). Pass `--allow-probe` to invoke each adapter's `fetchSnapshots()` through its bounded provider probe. Use `--provider kimi-coding` or `--provider openai-codex` to explicitly probe only that provider; scoped refresh still requires `--allow-probe` before it makes a request.

`--allow-probe` makes **real provider requests** with your stored credentials. For xAI that is a 1-token completion that consumes quota. Codex's explicit scoped refresh calls its supported usage endpoint, persists provider-reported `primary` and `secondary` quota windows, and records the limited redacted diagnostic described in [`qlb codex usage-diagnostic`](#qlb-codex-usage-diagnostic); it never logs request headers, tokens, or response bodies. Invalid/missing Codex credentials and unavailable usage readings are `error`.

A fetch that fails inside the single-flight TTL keeps cached buckets and is classified **failed** (`probe.outcome = cached-after-failure`). Mixed ok + failed accounts on one provider are `partial` (`ok: false`).

```console
$ qlb refresh
refresh: no probes run (pass --allow-probe to poll providers)

$ qlb refresh --provider kimi-coding --allow-probe --json
{
  "probed": true,
  "results": [{ "provider": "kimi-coding", "status": "ok" }]
}

$ qlb refresh --allow-probe
[OK]   xai (xAI): 1 account(s)
[NONE] openai-codex (Codex (ChatGPT Pro)): no probe available — readings come from proxy traffic (1 account(s) from credentials)
[FAIL] openrouter (OpenRouter): no snapshots returned
Probed 3 provider(s): 1 ok, 0 partial, 0 no-data, 1 no-probe, 1 failed
```

Per-provider statuses:

| Glyph | `status` | Meaning |
|---|---|---|
| `[OK]` | `ok` | At least one account with a bucket reading and no error / cached-after-failure. |
| `[PART]` | `partial` | Some accounts ok and some failed. `ok` is false. One line per failed account. |
| `[NONE]` | `no-data` | Snapshots returned without `error` but none have gauge buckets. |
| `[NONE]` | `no-probe` | Adapter declares `probes: false` (the unscoped Codex adapter and some plugins). Readings come from proxy traffic. |
| `[FAIL]` | `error` | The adapter threw/rejected, returned no snapshots, every snapshot had `error`, or every account was `cached-after-failure`. One failed provider never aborts the others. |

`--json` prints `{ probed, results }` where each result is `{ provider, displayName, ok, status, accounts, accountsOk, accountsFailed, error?, errors, snapshots }`. `status` is one of `ok`, `partial`, `no-data`, `no-probe`, `error`. `errors` is `{accountId, error}[]`. Without `--allow-probe` that is `{"probed":false,"results":[]}`. Plugins that omit `probe` on snapshots are treated as fetched.

Flags: `[--provider kimi-coding|openai-codex] [--allow-probe] [--json]`. Exit `0` always on a completed refresh (a failed provider is a result, not a crash). Unknown arguments exit `1`.

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

## `qlb import cswap`

An interrupted C-swap import leaves a QLB-owned journal in `~/.qlb/backups`. A normal import refuses while a journal needs attention, before it reads source credentials or writes new staging data. Reconcile those journals explicitly:

```console
$ qlb import cswap --reconcile --preview
journals=1; import-run-123:recover
```

`--preview` is read-only and reports each credential-free `runId:action` pair. With `--json`, each journal also includes its `phase` and SHA-256 digest. Run `qlb import cswap --reconcile` to perform the reported action: `recover` restores an uncommitted promotion, `finish-cleanup` removes leftover import staging and backup services after the SQLite commit, and `purge-staging` removes staging services from an import that never began promotion. `unclassifiable` is fail-closed: QLB refuses to reconcile or begin another import until the journal is made safe to classify.

Reconciliation and preview are admitted only while the lifecycle is `cutting-over` or `cutover`. A non-stale import lock also refuses the command as `import-in-progress`; a stale lock is left for the guarded mutation to reclaim. `--preview` requires `--reconcile`; `--reconcile` cannot be combined with `--dry-run` or `--replace`.

Flags: `[--dry-run] [--replace] [--json]`, or `--reconcile [--preview] [--json]`.

## `qlb codex usage-diagnostic`

Read the last persisted, redacted result of an explicitly authorized `qlb refresh --provider openai-codex --allow-probe` attempt.

This command is local and read-only: it opens SQLite read-only, never creates or migrates a database, and does not load adapters or credential stores, read credentials, call a provider, mutate an account, or append a health-log row.

```console
$ qlb codex usage-diagnostic --json
{"provider":"openai-codex","recorded":true,"attemptedAt":1700000000,"networkDispatchAttempted":true,"classification":"rate-limited","entitlementEvidence":"unknown","httpStatus":429,"endpoint":"wham","fallbackAttempted":false,"parserShape":"not-applicable","backoffUntil":1700004500,"authoritativeWindowObserved":false,"stale":false}
```

The finite classification distinguishes local preflight, transport, HTTP, recognized provider-gauge, and successful unrecognized-shape outcomes.

`entitlementEvidence` is evidence from the provider response only; it never claims a subscription plan, OAuth scope, token audience, account eligibility, or capacity.

`recorded: false` means no persisted diagnostic exists, not that a request was made or that quota is unavailable.

The command cannot create capacity or routing authority.

Only provider-reported recognized `primary` or `secondary` windows remain authoritative for snapshots, export, and routing.

Do not use `qlb usage probe` as a diagnostic substitute: it directly probes and does not apply the scoped-refresh backoff gate.

Flags: `[--json]`.

## `qlb export`

Emit the last persisted usage readings as JSON without loading provider adapters or credential stores, making network requests, or migrating the database. The SQLite database is opened read-only and is never created when absent. This is the cache-only interface for status consumers; unlike `qlb status`, it does not refresh readings.

```console
$ qlb export --cache-only --json
{"exportedAt":1788844834325,"readings":[{"accountId":"acct-a","provider":"anthropic","label":"alice@example.com","bucket":"5h","usedPct":2,"used":null,"limit":null,"remaining":null,"resetAt":1788846834100,"fetchedAt":1788844834100,"source":"poll","confidence":"authoritative","status":"active","stale":false,"routingAuthority":"display-only"}],"surfaces":[{"id":"anthropic-pi-pool","source":"pool-inventory","recordedAt":1788844000000,"complete":true,"members":[{"target":"pi-slot-a","accountId":"acct-a","readings":[{"accountId":"acct-a","provider":"anthropic","label":"alice@example.com","bucket":"5h","usedPct":2,"used":null,"limit":null,"remaining":null,"resetAt":1788846834100,"fetchedAt":1788844834100,"source":"poll","confidence":"authoritative","status":"active","stale":false,"routingAuthority":"display-only"}]}]}]}
```

`exportedAt`, `fetchedAt`, `resetAt`, and surface `recordedAt` are Unix timestamps in milliseconds; `fetchedAt` and `resetAt` may be `null`. A reading is `stale: true` when its `fetchedAt` is more than 300 seconds old, including a missing timestamp. The remaining reading fields are the stored account and snapshot values. `routingAuthority` labels an individual persisted row `fresh-provider` only when it is a current direct provider reading with no later persisted failed provider attempt; every other value is `display-only`. Rows superseded by a newer provider poll are `display-only` and ignored by routing. This is provenance for consumers, not a route decision: export never selects an account. It reads persisted account, snapshot, and poll state, including providerless legacy `usage_polls` schemas, but never reads `observed:<provider>`. Failed Kimi or OpenRouter probes recorded only in `observed:<provider>` are therefore not reflected by cache-only export; use `qlb why` to inspect the saved observation or `qlb status` to probe live. An account can route a model only when it has at least one current relevant reading and every present current relevant reading is `fresh-provider`; absent buckets are skipped. `surfaces` is additive: `anthropic-pi-pool` records a non-secret Pi Anthropic inventory with `source: "pool-inventory"`, its `recordedAt`, and `complete` flag. `complete` means every non-empty current inventory member was classified exactly against a current slot; unmatched members and an empty pool make the surface incomplete. Re-running `qlb pi pool-inventory --against slots --record` refreshes the inventory without changing an existing non-empty target mapping. Recording is admitted only during `cutting-over`, `cutover`, or steady `retired` lifecycle states; it writes only the non-secret inventory snapshot. Export emits the pool surface only in those serving lifecycle states after an inventory has been recorded; target mappings alone emit no surface. `recordedAt` is membership-inventory time, not quota freshness. Consumers must reject a surface whose `complete` is false. The surface never includes credential data or lineage fingerprints. A missing database succeeds with `{"exportedAt":...,"readings":[],"surfaces":[]}`. A database with a schema newer than this QLB binary is refused without emitting rows; upgrade QLB before retrying.

The command accepts exactly `qlb export --cache-only --json` (the two flags may be ordered either way). It resolves the database through `QLB_DB_PATH`, config `dbPath`, or the default path; it does not accept per-invocation configuration flags such as `--db-path` or `--config`.

## `qlb status`

The dashboard view (default): one block per account with a health glyph, credential-ownership state, and any active override, followed by optional Anthropic operational details and indented bucket rows.

**`qlb status` reaches the provider adapters** (`runStatus` → `safeFetch` → `adapter.fetchSnapshots()`), so consecutive runs can show usage moving. It is not a cache-only read — unlike `qlb why`, which is non-probing. Do not treat `status` as free.

For QLB-owned Anthropic slots, the dashboard shows `login expires <ISO timestamp>` when the stored OAuth credential has an expiry. When persisted usage is unavailable, it shows `usage: <error>` and, while a retry backoff is active, `, retry <ISO timestamp>`.

Each bucket row reports capacity **both ways** — consumed and remaining — because "81%" alone is ambiguous when you are scanning for headroom:

| Element | Meaning |
|---|---|
| `81% used  19% left` | remaining is `100 - used`, clamped to 0–100 |
| `unknown used  unknown left` | the provider reported the bucket but no number (real case: kimi `5h`) |
| `(presentation-only)` | consumed/remaining values are display math, never routing input |
| `provider authority` | current direct provider reading that is routing evidence for this row |
| `stale cache (display-only)` | confidence explicitly marks the row stale |
| `advisory (display-only)` | confidence explicitly marks the row advisory |
| `<source> (display-only)` | cached, derived, malformed, or failed-probe reading that cannot route |
| `EXHAUSTED` | 0% left |
| `LOW` | 0% < left ≤ 5% |
| `resets in 4h 3m (today 04:20)` | relative **and** absolute local clock time |
| `not reported by <provider>` | that provider does not expose this window at all |

A `5h` and a `7d` row are shown for **every** account, even when the provider reports neither, so a missing window is visible rather than silently absent. Kimi's `weekly` bucket is displayed as `7d` (the raw key is preserved in `--json` and in `--flat`). Providers that report other buckets (`7d:Fable`, `requests`, `tokens`, `credits`) list them after the `5h`/`7d` rows. Account headers repeat any `EXHAUSTED`/`LOW` bucket so a burnt account is identifiable without reading its rows.

Displayed remaining and the `EXHAUSTED`/`LOW` markers are derived from a **single** normalized value (half-up to 1 decimal), so they can never contradict each other: a positive remainder never prints as `0%`, and a remainder above the LOW threshold never prints as exactly `5%`. This `100 - used` arithmetic, its rounding, and the dashboard labels are presentation-only; they cannot admit, exclude, or select an account. `provider authority` identifies a single current direct provider row; an account routes a model only when it has at least one current relevant reading and every present current relevant reading has that label. Absent or superseded buckets are skipped. All other values are display-only.

There is deliberately **no** "window not started" wording. A bucket with `usedPct: 0` and no `resetAt` is indistinguishable from a provider that never reports resets, so both render `not reported by <provider>` rather than guessing a reason.

| Glyph | Meaning |
|---|---|
| `✓` | every bucket under 80% |
| `⚠` | any bucket 80–99% |
| `✗` | any bucket at 100%, or the account has an error |

```console
$ qlb status
✓  Kimi K3  kimi-coding  NATIVE  override=none
     5h  unknown used  unknown left  (presentation-only)  provider-poll (display-only)  resets in 1h 7m (today 01:21)
     7d  57% used  43% left  (presentation-only)  provider authority  resets in 65h 7m (Fri 17:21)
✓  Grok (xAI)  xai  NATIVE  override=none
     5h        not reported by xai
     7d        not reported by xai
     requests  0% used  100% left  (presentation-only)  advisory (display-only)  reset: not reported by xai
     tokens    1.2% used  98.8% left  (presentation-only)  advisory (display-only)  reset: not reported by xai
✓  codex-default  openai-codex  NATIVE  override=none
     5h  not reported by openai-codex
     7d  not reported by openai-codex
✗  alice@example.com  anthropic  NATIVE  override=none  EXHAUSTED (7d:Fable)
     5h        4% used  96% left  (presentation-only)  provider authority  resets in 4h 3m (today 04:20)
     7d        81% used  19% left  (presentation-only)  provider authority  resets in 101h 43m (Sun 06:00)
     7d:Fable  100% used  0% left  (presentation-only)  EXHAUSTED  provider authority  resets in 101h 43m (Sun 06:00)
✗  bob@example.com  anthropic  NATIVE  override=none  EXHAUSTED (7d)  LOW (7d:Fable)
     5h        0% used  100% left  (presentation-only)  provider authority  reset: not reported by anthropic
     7d        100% used  0% left  (presentation-only)  EXHAUSTED  provider authority  resets in 8h 45m (today 09:00)
     7d:Fable  97% used  3% left  (presentation-only)  LOW  provider authority  resets in 8h 45m (today 09:00)
⚠  OpenRouter  openrouter  NATIVE  override=none  LOW (credits)
     5h       not reported by openrouter
     7d       not reported by openrouter
     credits  98.7% used  1.3% left  (presentation-only)  LOW  provider authority  reset: not reported by openrouter
```

(First two blocks and the error block are captured output with generic labels; glyph rules and line format are exactly as implemented in `src/dashboard.ts`.)

Kimi's shown `5h` row has no percentage, so it is display-only; the `7d` row's `provider authority` label does not make Kimi eligible for a model that requires both buckets.

`--flat` shows the original bucket table — raw reported buckets only, with raw bucket names (including kimi's `weekly`), no synthesized `5h`/`7d` rows, no `left` column, and unrounded percentages. It is the escape hatch to the underlying data and is intentionally **not** affected by the dashboard formatting above:

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

`--json` is additive. Its top-level object includes `fetchedAt`, `accounts`, `lifecycle` (`state` and ISO-8601-or-`null` `windowEnd`), `activeLogin` (provider-to-account map), and ISO-8601-or-`null` `parked` and `breaker` timestamps for currently active Anthropic holds. Per account it adds `ownership`, `override`, `health`, and `healthGlyph`; Anthropic slots QLB owns may additionally include ISO-8601-or-`null` `loginExpiresAt`, numeric `threshold`, and, when persisted usage is unavailable, `usageError` and a future ISO-8601 `usageRetryAt`. Per bucket it adds `leftPct` (rounded to 1 decimal), `window` (normalized label, e.g. kimi `weekly` → `7d`), `resetInMs`, and `resetAtLocal`. Existing fields (`usedPct`, `source`, `confidence`, `fetchedAt`, `resetAt`) keep their names, types, and raw precision, and raw bucket keys such as `weekly` are preserved:

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

Ask QLB to pick an account (and possibly a fallback model) for a request. Purely advisory unless something consumes its output: it uses only fresh direct provider quota readings for the relevant provider(s), scores eligible candidates, records an audit row, and prints the decision. When no fresh provider reading is available, it returns `UNAVAILABLE` rather than selecting from cached, imported, advisory, or other non-provider data. Run `qlb refresh --allow-probe` (or wait for a provider poll or eligible proxy header reading) before retrying.

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
      "5h":     { "usedPct": 60, "confidence": "authoritative", "source": "provider-poll", "fetchedAt": 1788844834100 },
      "7d":     { "usedPct": 30, "confidence": "authoritative", "source": "provider-poll", "fetchedAt": 1788844834100 },
      "7d:Fable": { "usedPct": 45, "confidence": "authoritative", "source": "provider-poll", "fetchedAt": 1788844834100 }
    }
  }
}
```

`mode` is one of `headroom`, `all-in`, `fallback`, `fallback-all-in` (or `unavailable` / `exhausted` in the audit row). When the served model differs from the requested one, the human output prints `⚠ served by <model>` prominently — substitution is never silent.

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

Strategies apply after the provider-reading admission gate:

- `headroom` — existing Rule-S score, single best account, headroom-then-all-in (default; unchanged).
- `spread` — same scoring, but near-tied candidates (within `SPREAD_MARGIN` = 10) are split across session ids via a deterministic hash of `--session`. No session id → falls back to `headroom`.
- `round-robin` — ignore scores except to skip unavailable, exhausted, or errored accounts; cycle in account-id order using a SQLite counter.
- `failover` — stick to the current account while every relevant bucket is under 100%; switch only when it is genuinely exhausted.

## `qlb why`

Explain the account the resolver would pick **based on the latest persisted observation per provider**. `qlb why` never probes the network and never writes a decision row or advances round-robin/failover state. Observations are recorded per provider by `qlb resolve`, `qlb refresh --allow-probe`, and `qlb status`. Enough normalized candidate data (including buckets) is stored so the observed pick can be reproduced; later live-store bucket changes do **not** change `why` until a new observation is recorded.

`qlb why` is observation and account-routing **input** for other tools (including Pi's Fable failover policy). It does **not** switch Pi sessions or change Pi's selected model. Exact invocation used by that policy: `qlb why --model claude-fable-5-1 --fallback claude-opus-5-5 --json`. Modes (`headroom`, `all-in`, `fallback`, `fallback-all-in`, `pin`, `spread`, `round-robin`, `failover`, …) describe how QLB would pick an **account**; `mode: failover` means the failover *strategy served Fable*, not that Opus was substituted. Observation `status: ok` reports a stored observation and is **not** a freshness certificate. The `hint` field is documentation data only — never execute it.

`why` is non-probing and does not persist a routing decision or rotate strategy state. It is **not** guaranteed zero-filesystem-write: opening the normal Store can create, migrate, or chmod local state.

Plugins that declare `persistsSnapshots: false` (or observations that fail validation) are excluded from the parity guarantee and labelled `observation: unavailable`.

When `--model` is omitted, `why` uses `requested_model` of the newest routing decision, else `claude-sonnet-5`. Unknown `--model` exits `1` (same as `resolve`). Human output includes `model: X (from last routing decision|default)`, an `observed:` timestamp/generation (or `never probed — store snapshots only`), and a hint to run `qlb refresh --allow-probe` to update. `--json` emits an `observations` array (one entry per provider), not a singular object.

```console
$ qlb why --json
{
  "model": "claude-sonnet-5",
  "modelSource": "default",
  "accountId": null,
  "strategy": "headroom",
  "score": null,
  "error": "EXHAUSTED",
  "reason": "EXHAUSTED",
  "losers": [],
  "observations": [],
  "hint": "run qlb refresh --allow-probe to update"
}
```

Flags: `[--model <modelId>]`, `[--fallback m1,m2,...]`, `[--session <id>]`, `[--strategy headroom|spread|round-robin|failover]`, `[--json]`. Unknown model exits `1`; otherwise `0`.

## `qlb audit`

Read-only listing of recent **routing** decisions (newest first, default `--limit 20`). Non-routing proxy rows (`proxy`, `proxy_error`, `proxy_auth_reject`, `policy_unmapped`, `native_resync`, `proxy_upstream_error`) are filtered **before** LIMIT.

`strategy` and `provider` are persisted on new rows. Legacy v4 rows derive strategy only when unambiguous (`pin|spread|round-robin|failover` → itself; `headroom|all-in` → `headroom`; otherwise `?` / `null`). Provider falls back `recorded` → `accounts` → `snapshot_json` → `providerForModel(requested_model)` → none. JSON includes `strategySource` and `providerSource` ∈ `recorded|derived|accounts|snapshot|model|none`.

The command opens the store with `readOnly: true` and never migrates. A missing path prints `no decisions` / `[]` and exits `0` without creating files. Zero-mutation promise = main-file bytes, mode, `user_version`, and all directory entries other than `<db>-wal` / `<db>-shm` (a WAL-mode DB may require those sidecars for any reader; audit may create or leave them). If the directory is unwritable and SQLite cannot create/map `-shm` for a WAL-mode file, audit does **not** fall back to a writable open: it prints `qlb audit: store is not readable without write access to <dir> (WAL sidecar); run from a writable location or vacuum the store`, exits `1`, prints no stack, and creates no new entries. Other open failures print `qlb audit: cannot open store read-only (<reason>)` and also exit `1`. `--limit` must be a positive safe integer; an invalid value exits `1` with a single stderr line.

Flags: `[--limit N]` (default 20), `[--json]`, `[--db <path>]`.

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

`qlb migrate status` and `qlb migrate status --json` are diagnostic. They report the filesystem and journal view, including `detail`, and are not a receipt. Status omits `completeSetCommitment` (including its digest). That commitment stays in the private journal and staging file. Diagnostic `detail` can still show staged account labels, and after a successful Anthropic rehearsal it can show `identityProof` aliases and the fixed `5h` / `7d` readings. The receipt does not print labels, and status output is not publication authority.

Gate 5's Anthropic path is `stage`, then `rehearse`, then `commit`, with `status` and `rollback` available throughout. After that commit, `pi-pool` is `QLB_OWNED`. The verified status fields are `ownerFile: "present"`, `piAtNextLaunch: "QLB works"`, and `detail.anthropicPoolExtension: "disabled"` (commit moves Pi's `extensions/anthropic-pool` to `extensions-disabled-by-qlb/anthropic-pool` and records that disposition). Human status prints those as `owner: present` and `pi next: QLB works`. `store` stays `pi-pool`, `strategy` stays `rename`, and the JSON object still includes `state`, `updatedAt`, `nativeStore`, `resumeAction`, `provider`, and the rest of `detail`. Once that commit's hygiene has finished, the native pool file is the `.pre-qlb` copy and, with no rollback intent pending, `resume` is `noop (already QLB_OWNED)`. `pi next: QLB works` means the next Pi launch uses QLB. `status` and `rollback` keep working while cswap consume is enabled; `stage`, `rehearse`, `commit`, and `resume` do not (see [`qlb consume`](#qlb-consume)).

### `qlb migrate receipt`

Anthropic-only read-only receipt, and the only operational migration receipt:

```console
$ qlb migrate receipt --provider anthropic --phase stage --pool-file /tmp/demo/anthropic-pool.json --owner-file /tmp/demo/qlb-owner.json --db /tmp/demo/qlb.db --json
```

`--phase` is `stage`, `rehearse`, `commit`, `failure`, `preflight`, or `smoke`. The command reads the pool file, the migration journal, and the staging owner file. It does not stage, rehearse, commit, resume, roll back, write a Keychain item, or call a provider. It does not take `--confirm-real-cutover` because it does not mutate.

`preflight` is read-only. It opens SQLite read-only, classifies each pool member against existing Claude slots (`matched`, `missing`, `ambiguous`, `dead-or-archived`) and expiry (`fresh`, `under-2h`, `expired`, `none`), and prints `disposition: "go"` or `"no-go"`. Email matching is exact. Ambiguity in either direction is `adoption-ambiguous`. It also prints `claudeCodeActiveToken` as `fresh`, `expiring`, `expired`, `expiry-unknown`, or `unreadable` from one in-process read of the live Claude Code credential. The receipt contains the class only, never the token, its expiry, or the account.

`qlb migrate rehearse --provider anthropic --initial-active member-000N` requires that alias to be the current Anthropic active login. R1b does not write `active_login`. An expired staged access token is the fixed code `token-expired`. A successful rehearse receipt adds `adoption: "verified"` and `initialActive`.

`smoke` prints `servedAlias`, `matchesInitialActive`, and `servedAfterCommit` for the account last served by `qlb gate anthropic --no-refresh`. It does not print the account id. `--no-refresh` fails closed with `smoke-token-expired` or `smoke-token-expiry-unknown` and does not refresh or retry.

The printed object is built from an allowlist: `schemaVersion`, `phase`, `disposition` (`success` or `refused`), and, when one applies, `code`, `membership`, `count`, `aliases`, and `buckets`. A stage receipt has `disposition: "success"` only when the journal binding and the staging binding are both readable and equal and the current pool file still admits to that same binding. The success object is:

```json
{
  "schemaVersion": 1,
  "phase": "stage",
  "disposition": "success",
  "membership": "complete",
  "count": 2,
  "aliases": ["member-0001", "member-0002"]
}
```

Aliases are cycle-local labels (`member-0001`), not source identities. The receipt never includes a cycle id, commitment, witness, credential, token hash, email, account id, label, path, Keychain coordinate, provider payload, provider display name, or raw error.

A rehearse receipt succeeds only when that same stage binding still matches and the journal holds a complete current-cycle identity proof. Success adds `buckets`, aligned with `aliases`. Each entry contains only the finite readings `5h` and `7d`:

```json
{
  "schemaVersion": 1,
  "phase": "rehearse",
  "disposition": "success",
  "membership": "complete",
  "count": 1,
  "aliases": ["member-0001"],
  "buckets": [{ "5h": 1, "7d": 2 }]
}
```

`code` is a fixed string. `source-membership-invalid` means the pool membership is rejected, including when a restage fails and the previous recovery files are left in place. `identity-mismatch` means rehearse refused because a profile did not match the admitted member. `proof-unavailable` means the current-cycle identity proof is absent. `source-witness-unavailable` means the journal witness is missing, malformed, or unequal to the source. `proof-stale` means that proof is older than 300000 ms. A commit receipt succeeds only after the private post-owner admission marker is recorded. `status --json` omits account labels, the commitment, and the source witness. Exit `0` only for a success receipt. A refusal still prints the allowlisted JSON with `--json` and exits `1`.

Subcommands: `stage`, `rehearse`, `commit`, `rollback`, `resume`, `status`, `receipt`. Common flags: `[--provider anthropic|xai|kimi-coding|openai-codex|openrouter]`, `[--pool-file <path>]`, `[--owner-file <path>]`, `[--auth-json <path>]`, `[--target-dir <path>]`, `[--db <path>]`, `[--json]`.

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

## `qlb retire native`

Phase-4 gate for moving a native harness credential store aside after QLB ownership has been proven in production.

```console
$ qlb retire native status --harness claude-code
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

`retire native execute` requires **all** eligibility gates to pass (state `QLB_OWNED`, 7-day soak, 20 clean decisions, live ping through the new path) **and** an explicit confirmation flag:

```console
$ qlb retire native execute --harness claude-code
REFUSED: qlb retire native execute requires --confirm-real-retirement.
This would retire a native Claude Code / Codex CLI credential store.
Run `qlb retire native status --harness <h>` (read-only) first.
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
  "removed": { "accounts": 1, "snapshots": 3, "overrides": 0, "pollClaims": 0, "leases": 0, "usageDiscrepancies": 0 }
}
```

Deletes **local account metadata only**: `accounts`, `snapshots`, `overrides`, `poll_claims`, the account's refresh `leases` row, and its provider-usage discrepancy records. Credentials are never removed, moved, or rewritten (Keychain items, native stores, `.pre-qlb` backups, sidecars, owner files). `decisions` / `errors` rows are left untouched (audit history, not live state).

**Refused (exit 2)** with a stable reason token:

- `protected:<STATE>` — the account is named by a trusted `MIRRORED`, `VALIDATED`, `QLB_OWNED`, or `RETIRED` journal row **including after a completed rollback**. Post-rollback prune of `VALIDATED` participants is deferred until a separately reviewed cycle-bound receipt protocol and current-grant rollback both exist.
- `untrusted:<reason>` — some journal row cannot be decoded (malformed JSON, empty/mismatched inventories, bad shape, unknown store/state/version, provider conflict, …).
- `recovery_pending` — `config('migrations.recovery_pending')` is set; destructive maintenance is refused until an explicit reviewed reconciliation clears it.
- `no_such_account` — the id does not exist.
- `not_confirmed` — `--confirm` was not passed.

Usage errors (unknown subcommand/flag, missing `--account`) exit **1**. Infrastructure errors (SQLite, I/O) exit **1** and print the original error `code`/`errcode`/message. Refusals name the store and never print a command that could delete or rewrite credentials.

```console
$ qlb accounts prune --account account-1 --confirm
REFUSED: protected:QLB_OWNED (store 'pi-pool')
(exit 2)
```

Flags: `--account <id>` (required), `--confirm` (required), `[--db <path>]`, `[--json]`.

## `qlb auto resume anthropic`

Clears the Anthropic automatic-switch breaker hold and records the resume so a
concurrent auto tick cannot restore the cleared hold. It is admitted only in a
lifecycle state that permits auto operations; a refusal exits `3` without
changing the stored suspension or resume marker.

With `--json`, a normal cleared hold reports
`{"provider":"anthropic","resumed":true,"suspendedUntil":"<ISO-8601>"}`;
when no hold was present it reports `resumed: false` and `suspendedUntil: null`.
If an older or hand-edited hold contains an invalid timestamp, the command
still clears it and reports `resumed: "cleared-invalid"` with
`suspendedUntil: null` instead of failing after the write.

Flags: `[--json]`.

## `qlb claude journal resolve`

Usage: `qlb claude journal resolve --forward|--back`.

Resolves an unfinished Claude switch journal
(`~/.qlb/journal/switch-anthropic.json`) whose
owner process has died, on the operator's explicit request. Automatic
reconciliation only ever rolls a switch back. This command is the only way to
complete one forward.

- `--back` restores the outgoing account. It puts back the pre-switch
  `oauthAccount` in the Claude config, and restores the live credential only
  when the live item still holds exactly what the switch wrote. It records a
  `rolled-back` switch row.
- `--forward` completes the switch to the target account. It finishes the
  config step and commits the switch row. It needs the live credential to
  still match the target slot's credential.

Both directions take the switch lock, Claude Code's credential locks, the
journal owner lock and the config-path lock, in that order. Both then close
the journal, delete the staged rollback blob, and remove the journal file.

Admission operation: `claude-journal-resolve`, admitted in the `cutting-over`,
`cutover` and `retired` phases.

Exit codes:

- `0`: resolved. It prints `Claude journal resolved forward|back`, with the
  12-character fingerprint prefixes of the credentials involved. When cleanup
  partly failed, it adds the warning
  `completed with cleanup warnings: journal|staged|lock-timeout`. The switch
  itself is still resolved.
- `1`: an unexpected error, for example an unreadable store, or a config file
  that can't be parsed during `--back`. It prints
  `qlb claude journal resolve: failed`.
- `2`: bad usage (not exactly one of `--forward` or `--back`).
- `3`: refused, with `qlb claude journal resolve: refused: <reason>`. Nothing
  is changed. The reasons:

| Reason | Direction | Meaning |
|---|---|---|
| `phase=<state>`, `undo-in-progress` | both | The lifecycle phase does not admit the command. |
| `cutover-begin-in-progress` | both | A `qlb cutover begin` has not finished (its marker is still set). |
| `cswap-process-alive`, `cswap-process-check-failed` | both | A C-swap process is running, or the process check failed (checked before and again under the locks). |
| `journal-absent`, `journal-malformed` | both | There is no journal, or it can't be read. |
| `journal-identity-invalid` | both | The journal names slots the slot inventory does not match. |
| `journal-finished` | both | The journal is already closed or committed. |
| `owner-alive` | both | The switch that wrote the journal is still running, or its owner lock is less than 5 minutes old; retry later. |
| `lock-timeout` | both | A lock wasn't acquired in time, or a held lock was lost. |
| `staged-unreadable` | back | The staged rollback copy of the outgoing credential is missing or can't be read. |
| `live-unreadable` | both | Claude Code's live credential can't be read. |
| `live-not-outgoing` | back | The live credential is neither the switch's written bytes, the staged copy, nor the outgoing account. |
| `credentials-not-written` | forward | The journal does not record that the target credential write finished (the target may already be live), so only `--back` applies. |
| `target-unreadable` | forward | The target slot's credential can't be read. |
| `target-lineage-missing` | forward | The live credential no longer matches the target slot's credential, for example because Claude Code renewed it. |
| `target-invalid` | forward | The target slot has no usable `oauthAccount`. |
| `config-invalid` | forward | The Claude config can't be read or parsed. |
| `config-moved` | forward | The Claude config changed since the switch recorded it. |

### Stuck journal

If Claude Code renews its token after the switch wrote the target credential
but before the journal was closed, both directions can refuse:

- `--back` refuses `live-not-outgoing`, because the live credential is now a
  renewed one;
- `--forward` refuses `target-lineage-missing`, because the live credential
  no longer matches the target slot's copy, or `credentials-not-written` if
  the switch died before recording that write.

While the journal stays in place:

- the doctor row `claude:switch-journal` shows FAIL;
- every Claude switch, manual or made by `qlb auto`, refuses
  `switch-journal-present`, so automatic switching is paused;
- Claude Code itself stays signed in to the target account.

There is a known double-renewal hazard in this state: QLB can renew a grant
that Claude Code also holds. So the owner should resolve the journal promptly.
Recovery is supervised by the owner. Don't delete or move the journal, the
staged blob or any credential by hand.

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

## `qlb codex gate`

The Codex CLI compatibility gate (G0–G4 from the design spec): verifies that Codex CLI requests actually work through the proxy against the real Codex backend with QLB-supplied credentials, and records a `GO` / `NO-GO` verdict. Makes a handful of real quota-consuming requests (uses `~/.codex/auth.json` read-only) — **never run casually**; automated tests never take this path.

Human output shape:

```console
$ qlb codex gate
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

Flags: `[--info-path <path>]`, `[--idle-ms <n>]` (positive integer; `--idle-ms 0` is invalid), `[--no-idle]` (do not arm the idle timer; used by the supervising wrapper), `[--port <n>]`, `[--started-by wrapper|cli]`, `[--db <path>]`, `[--json]`. A second `qlb proxy` on an already-bound `--port` exits 1 and does not rewrite `proxy.json` or mint a token. Security posture: loopback-only bind (refuses anything else), per-launch random 32-byte token minted only after listen in the same `proxy.json` write as `startedBy`/`pid`/`lstart`, constant-time token comparison, `Host` header allow-list, path allow-list (`/v1/messages`, `/v1/messages/count_tokens`, `/v1/responses`, `/backend-api/codex/responses`, `/qlb/health`), local auth-failure rate limiting, and credentials injected only for providers whose migration journal says `QLB_OWNED` or `RETIRED`. Anthropic consume is not one of those injections: the proxy returns unavailable before reading a Claude Code credential. Pi's consume mode is a separate read-only Keychain path (see below).

## `qlb consume`

Code-only journal for Consume Option B. Does **not** enable a live proxy, PATH wrapper, or `settings.json` change by itself.

```console
$ qlb consume enable --provider anthropic
cswap-anthropic: CONSUMED
```

```console
$ qlb consume disable --provider anthropic
cswap-anthropic: NATIVE
```

`--provider` must be `anthropic`. Enable writes `consume-anthropic.json` `{state:"CONSUMED"}` (no tokens) beside the QLB database (`~/.qlb/` by default; `QLB_DB_PATH` / config `dbPath` move it, and Pi resolves it the same way — a per-invocation `--db`/`--db-path` flag is not visible to Pi), then upserts journal store `cswap-anthropic=CONSUMED`. Disable journals `NATIVE` and deletes the marker. Consume is a different store from `pi-pool`. With Gate 5 committed, `pi-pool` stays `QLB_OWNED` and `cswap-anthropic` stays `NATIVE`: Claude Code keeps its own switching path, and Pi keeps the owned pool. Do not enable consume on that host. `com.modus.claude-pool-refresh` stays disabled for the same reason; QLB's Pi loop is `com.modus.qlb-auto`, not that agent.

`qlb consume enable --provider anthropic` then exits `1` with empty stdout and this stderr line. It does not write the marker or the journal:

```text
qlb consume enable: DUAL_OWNERSHIP_REFUSED — Pi's Anthropic accounts are QLB-owned (pi-pool QLB_OWNED). Roll back with `qlb migrate rollback --provider anthropic` first.
```

The same refusal fires for pi-pool `MIRRORED`, `VALIDATED`, or `RETIRED`, or when a Pi owner file is present or unreadable (`pi-pool owner file present` when the journal has no owning state). The other direction matches: `qlb migrate stage|rehearse|commit|resume --provider anthropic` exits `1` with `qlb migrate <sub>: DUAL_OWNERSHIP_REFUSED — cswap consume is enabled for Anthropic.` while consume is enabled. `qlb migrate status` and `qlb migrate rollback` still run.

`decidePiMode` in `extensions/qlb-pi/consume.ts` is the Pi-side half of that guard. A valid Anthropic owner file (or `QLB_PI_REHEARSAL=1`) plus a consume journal of `NATIVE` is `owned`. The same ownership claim plus `CONSUMED`, or plus a journal Pi could not read, is `conflict`, as is a malformed owner file. Conflict replaces Anthropic with an error-only stub. It does not fall back to `anthropic-pool`. The stub tells you to run `qlb consume disable --provider anthropic` or `qlb migrate rollback --provider anthropic`, then restart Pi.

Pi chooses its Anthropic mode at startup, so restart running Pi sessions after a successful `enable` or `disable`. A Pi that starts while the marker and journal disagree (mid-change or after a crash) refuses Anthropic until you re-run `enable` or `disable`. The proxy still fails an Anthropic consume request as unavailable before reading a Claude Code credential, because routing has no credential-attributable provider quota for `cswap-active`. Pi does not use that gate. In consume mode Pi serves the active Claude Code Keychain item (`Claude Code-credentials`) with a read-only `find-generic-password`: it never refreshes or writes the token, it refuses an expired token, and after one HTTP 401 it re-reads the item once and retries only if the access fingerprint changed. A missing quota reading, or a stale, cached, imported, or otherwise non-authoritative one, is `unknown`; the request proceeds and the outcome log records `quota:"unknown"`. Pi refuses before that Keychain read only when a fresh provider reading (`provider-poll` or `provider-headers`, `authoritative`, at most five minutes old) stored for `cswap-active` or for the account named by the anthropic `active_login` row has `usedPct` of at least 100. Readings on other slots are ignored, so a stale fleet cannot block Pi. cswap remains the Claude account brain; QLB does not attribute the Keychain login to a sequence slot, so an `active_login` row is only as accurate as the last account QLB recorded.

## `qlb gate`

S30 credential boundary for Pi. `qlb-pi` calls it per request with `QLB_PI_TOKEN_CALL=1`. A shell that is not that Pi parent never receives a credential.

```text
usage: qlb gate anthropic|openai-codex|xai|kimi-coding|openrouter [--json] [--retry-after-401 sha256-at:…]
```

`--json` is accepted and is how Pi asks for the envelope. A refusal still prints no JSON. `--retry-after-401` takes one `sha256-at:` fingerprint (64 hex digits). `--no-refresh` is accepted only with `anthropic` (the usage line does not list it). It is the bounded smoke path: the gate does not refresh. Combining it with `--retry-after-401` prints `smoke-no-retry` on stderr and exits `1`. An access token with no expiry prints `smoke-token-expiry-unknown` and exits `1`; an expired one prints `smoke-token-expired` and exits `1`. Any other flag, or `--no-refresh` on another provider, is a usage error (exit `2`, the usage line on stderr).

The guard lives in `tokenCallAllowed` (`src/commands/token.ts`) and `piRpcCallAllowed` (`src/pi-rpc-guard.ts`). Both require `QLB_PI_TOKEN_CALL=1`. Either stdin or stdout being a TTY is a refusal. An interactive Pi parent is accepted only when Pi's package root can be located and `process.title` has replaced argv with exactly `pi` while the executable name is still Node (`ps comm` and `ps command` are `pi`, `ps ucomm` stays `node` on macOS). Pi RPC mode is a separate check. A `pi-rpc` title is accepted only when the kernel comm, the Node text executable, Pi's RPC environment, and an RPC entry inside the located package agree. An argv that was not overwritten is accepted only when it is Node running that package's `dist/rpc-entry.js` or `dist/bundle/rpc-entry.js`, with no code-injecting option. A title by itself is not enough. Any uncertainty refuses.

Lifecycle admission runs first. A phase that does not admit `gate` exits `3` with `qlb gate: refused: <code>` and empty stdout. After admission, an unauthorized parent exits `3` with stderr `token-call-refused` and empty stdout, before any credential read. Setting `QLB_PI_TOKEN_CALL=1` does not authorize a plain shell:

```console
$ QLB_PI_TOKEN_CALL=1 qlb gate anthropic --json --no-refresh
# stderr only; stdout is empty; exit 3
token-call-refused
```

`qlb-pi` maps that stderr line through the fixed cause list in `extensions/qlb-pi/active-access.ts`, so Pi shows `QLB unavailable for anthropic — run qlb doctor (token-call-refused)` instead of a raw parent-process dump. The cause list is data: `token-call-refused` is one of the codes safe to display.

A successful call prints one JSON object on the secret channel and nothing else. The object is `{ token, accountId, source }` plus `chatgptAccountId` and `expiresAt` only when the provider supplied them. Do not log it.

## `qlb token`

Same S30 parent check as `qlb gate`, for the three static resolvers that are not pool gates: `xai`, `kimi-coding`, and `openrouter`.

```text
qlb token xai|kimi-coding|openrouter
```

There is no `--json` flag. A missing provider, any extra argument, or a failed `tokenCallAllowed` check exits `3` with empty stdout and empty stderr. It does not print `token-call-refused`; that cause string is the `qlb gate` refusal. A resolver failure after the guard has passed exits `1`. Success prints the credential on stdout and nothing else. Anthropic and OpenAI Codex go through `qlb gate`, not `qlb token`.

`QLB_PI_TOKEN_CALL` must be `1`, the process must not be a TTY, and the parent must pass the interactive `pi` title check or `piRpcCallAllowed`. Interactive `pi` is the `process.title` case above. `pi-rpc` is delegated to `src/pi-rpc-guard.ts` and does not replace that interactive title.

## `qlb release install`

Publishes one immutable build under `~/.qlb/app/<sha>` and atomically points the relative symlink `~/.qlb/app/current` at that directory. `qlb auto install-agent` and `qlb pi deploy` both read `current`.

```console
$ node dist/cli.js release install
installed <sha> at ~/.qlb/app/<sha>
```

`qlb release install` is the same command once `qlb` is on `PATH`. With a clean source tree the SHA is `git rev-parse HEAD`. A dirty tree exits `1` with `qlb release: source tree is dirty`. When git cannot name `HEAD`, pass `--sha <sha>` or the command exits `1` with `qlb release: cannot determine release SHA; pass --sha <sha>`. Usage errors (`qlb release: expected install [--sha <sha>]`) exit `2`. An integrity failure (`ReleaseIntegrityError`: incomplete tree, digest mismatch, unexpected symlink, and the same class of refusal) exits `3` with `qlb release: <message>`.

The command copies the compiled tree, checks the build stamp, writes a manifest of `{ sha, digest }`, and only then swaps `current`. An existing SHA directory is reused only when its manifest matches the bytes just built.

## `qlb pi deploy`

Copies `qlb-pi` from the release selected by `~/.qlb/app/current` onto the Pi agent directory, so doctor can see one installed tree.

```text
qlb pi deploy [--dry-run] [--json]
```

`qlb release install` has to have succeeded first. The source is `~/.qlb/app/<sha>/extensions/qlb-pi` plus that release's `src/redact.ts` and `src/pi-owner-document.ts`. The target is `~/.pi/agent/extensions/qlb-pi`, with the two shared files beside the resolved extensions directory. Deploy replaces the whole directory from a staging dir outside `extensions/` (so a half-published tree is restored), records `pi.deployedAt` (epoch seconds) and `pi.extensionHash`, and is what makes `pi:extension` and `pi:extension-drift` pass when the installed bytes match the current release and, for `pi:extension`, this repo.

```console
$ qlb pi deploy
deployed <hash> from ~/.qlb/app/<sha>/extensions/qlb-pi to ~/.pi/agent/extensions/qlb-pi
```

`--dry-run` prints `would deploy …` and writes nothing. `--json` prints `{ "source", "target", "hash", "dryRun" }` and does not include the timestamp. A repeated or unknown flag exits `2` with `qlb pi deploy: expected [--dry-run] [--json]`. A missing `current` release exits `1` with `qlb pi deploy: current release is missing or invalid under ~/.qlb/app; run qlb release install first`. Publishing across volumes exits `1`. The thrown text is `qlb pi deploy: the Pi extensions folder and ~/.pi/agent are on different volumes; this layout is not supported`, and the command wrapper prefixes `qlb pi deploy:` again.

## `/qlb` (Pi in-session command)

When `qlb-pi` is active (see [README · qlb-pi footer](../README.md#qlb-pi-footer)), Pi registers an in-session `/qlb` command (`extensions/qlb-pi/index.ts`, `pi.registerCommand('qlb', ...)`):

| Command | Effect |
|---|---|
| `/qlb` (no args), or `/qlb status` | Runs `qlb status --json` and shows the result via a Pi notification. |
| `/qlb migrate` | Runs `qlb migrate status --json` and shows the result the same way. |
| `/qlb expand` (alias `/qlb details`) | Toggles the footer's expanded detail panel — the same panel opened by the `ctrl+alt+q` shortcut. |

All three are read-only from the extension's side (they only shell out to `qlb status`/`qlb migrate status`, or toggle a UI panel) and fail open: a failed `qlb` invocation is reported via a notification rather than crashing the session.

## Not yet wired (honest gaps)

- **Organic Codex/xAI gauges.** Codex's supported usage endpoint is called only by `qlb refresh --provider openai-codex --allow-probe`; xAI's CLI probe is a quota-consuming 1-token completion. Otherwise those readings still come from organic traffic (proxy header parsing).
