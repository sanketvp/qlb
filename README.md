# QLB — Cross-Provider Quota Load Balancer

**The headline feature: if you have multiple Claude accounts, multiple Codex accounts, or both, QLB automatically load-balances your usage across all of them.** Run out of headroom on one Claude account and QLB routes the next request to whichever of your other Claude accounts still has room — same for Codex — so you stop babysitting which login is about to hit its 5-hour or weekly limit and manually switching. It picks the best account for every request only from fresh (≤5 min), direct provider readings — never guesses or stale, derived, or external-cache values — spreads normal usage so no single account gets drained first, and today only reaches for a genuinely different model/provider when you've explicitly allowed it (for example `qlb resolve --fallback <model>`). The plan (see [STRATEGY.md](STRATEGY.md)) is for QLB to make that switch by itself when none of your accounts for a provider has room, and always tell you when it does. And when you *want* a specific session on a specific account — deliberate multi-account parallel use — you can pin it explicitly with `qlb override pin` for a guaranteed parallel spread instead of relying on automatic scoring, or switch the automatic policy itself with `qlb resolve --strategy headroom|spread|round-robin|failover` (see the [CLI reference](docs/CLI.md)).

QLB extends the same account-pooling idea to Grok, Kimi K3, and OpenRouter too — the same load-balancing engine works across any number of accounts on any provider, not just Claude and Codex.

QLB ships with five built-in provider adapters (Claude/Anthropic, Codex, Grok/xAI, Kimi K3, OpenRouter) and can load additional providers as local JavaScript plugins for anything else you use. It never modifies your existing credentials unless you explicitly opt in to full account ownership (see [Credential Safety](docs/CREDENTIAL-SAFETY.md)), and one unavailable provider or broken plugin never crashes the overall status/routing commands.

**Live Anthropic model (Gates 5–7).** Pi's Anthropic pool journal `pi-pool` is `QLB_OWNED`. `qlb migrate status --provider anthropic --json` reports `ownerFile` `present`, `piAtNextLaunch` `QLB works`, and `detail.anthropicPoolExtension` `disabled` (commit moves `~/.pi/agent/extensions/anthropic-pool` to `~/.pi/agent/extensions-disabled-by-qlb/anthropic-pool`). Automatic switching runs under LaunchAgent `com.modus.qlb-auto` (`scripts/launchagents/com.modus.qlb-auto.plist`, written by `qlb auto install-agent` and loaded with `launchctl bootstrap`). While `pi-pool` is `QLB_OWNED`, journal store `cswap-anthropic` stays `NATIVE` (`qlb consume status --provider anthropic` prints `cswap-anthropic: NATIVE`) and LaunchAgent `com.modus.claude-pool-refresh` stays unloaded. `qlb consume enable --provider anthropic` in that state exits 1 and prints `DUAL_OWNERSHIP_REFUSED` (`src/app.ts`). `decidePiMode` in `extensions/qlb-pi/consume.ts` then returns `conflict`, and Pi serves an error-only Anthropic stub. Forward `qlb migrate stage|rehearse|commit|resume --provider anthropic` also exits 1 with `DUAL_OWNERSHIP_REFUSED` while `cswap-anthropic` is `CONSUMED`. Operator steps are in the [R1b cutover runbook](docs/R1B-CUTOVER-RUNBOOK.md).

**Consume Option B** is the other Anthropic mode, and the two modes exclude each other. With `cswap-anthropic` at `CONSUMED`, QLB sits on the local request path as the cross-provider selector and cswap remains the Claude account brain. Anthropic status is read from cswap's cache only. That cache cannot establish credential-attributable provider capacity, so consumed Anthropic requests fail unavailable before the proxy reads a Claude Code credential. Pi consume reads the active Claude Code Keychain item and does not fall back to `anthropic-pool`. A Pi owner file, or an unreadable journal or owner file, together with consume is the same `conflict` stub. Leave `harness/claude` off `PATH` and leave `settings.json` pointed away from the helper.

## Current status

`main` includes the five Gate 6 changes, and Gates 5, 6, and 7 have passed on the live QLB-owned Pi pool:

| Change | What landed |
|---|---|
| [#439](https://github.com/sanketvp/qlb/pull/439) | Interactive `pi` process-title guard in `src/commands/token.ts` (`INTERACTIVE_PI_PROCESS_TITLE`, `tokenCallAllowed`) |
| [#441](https://github.com/sanketvp/qlb/pull/441) | Fixed gate refusal cause `token-call-refused` in `extensions/qlb-pi/active-access.ts` |
| [#442](https://github.com/sanketvp/qlb/pull/442) | Standalone S30 module `src/pi-rpc-guard.ts` (`piRpcCallAllowed`) |
| [#443](https://github.com/sanketvp/qlb/pull/443) | `tokenCallAllowed` calls `piRpcCallAllowed` before the interactive-title checks |
| [#440](https://github.com/sanketvp/qlb/pull/440) | macOS `process.title` overwrite regression suite (`test/token-guard-process-title.test.ts`) |

`pi-pool` is `QLB_OWNED` with `com.modus.qlb-auto` bootstrapped and `cswap-anthropic` left `NATIVE`. A follow-up is in progress for `qlb doctor`'s `native-sync` checks. `inspectOwnedNativeDrift` in `src/native-resync.ts` currently walks every `accounts` row whose provider migration store is `QLB_OWNED` or `RETIRED`, so an owned `pi-pool` also flags Claude Code switching accounts and historical rows, and a missing owned Keychain item is reported as unreadable. That fix will limit the check to owned `pi-pool` members and separate a missing label from an unreadable one. It does not delete database rows or credentials. Those rows are `WARN`; `qlb doctor` still exits 0 unless overall is `FAIL`.

## Requirements

- Node.js 22 or newer on macOS, Linux, or Windows
- A per-OS credential backend (QLB picks this automatically):
  - **macOS:** Keychain via the `security` CLI (OS-native, strongest of the three)
  - **Windows:** DPAPI via PowerShell (tied to the Windows user login)
  - **Linux:** `secret-tool` / libsecret when available; otherwise an AES-256-GCM file at `~/.qlb/credentials-linux.json` whose key lives in `~/.qlb/.credkey` (mode 0600). The file fallback is encrypted at rest but **not** OS-keychain-protected — see [Credential Safety](docs/CREDENTIAL-SAFETY.md).

## Quickstart

```bash
npm install
npm run build
# Build clears dist/commands and dist/checks first, so stale registry modules are never discovered.
node dist/cli.js init
node dist/cli.js status
```

After installing the package globally, use `qlb` instead of `node dist/cli.js`:

```bash
qlb init --json
qlb doctor
qlb status --json
qlb resolve --model claude-sonnet-5 --json
qlb why                      # explain the pick, no network
qlb audit                    # recent routing decisions
qlb refresh --allow-probe    # poll providers now (explicit opt-in)
```

See [CLI.md](docs/CLI.md) for all flags.

Or run the idempotent installer (Node.js >= 22, `npm ci`/`npm install`, build, optional global `npm link`, then `qlb init`):

```bash
bash scripts/install.sh          # macOS / Linux
```

```powershell
powershell -File scripts/install.ps1   # Windows
```

If `npm link` cannot write a global bin, the script prints fallbacks (`PATH`, elevated prompt / `sudo`, or `npx`) and still bootstraps via `node dist/cli.js init`.

`qlb init` detects existing credential sources, reports anything missing, and writes a reviewable starter file at `~/.qlb/config.json`. It never prompts, so it is safe to use in scripts and CI. `qlb doctor` performs local checks only by default; add `--live` to opt into provider network calls.

## Release install

The production tree is `~/.qlb/app/current`, which is what `com.modus.qlb-auto` runs. From a clean checkout:

```bash
npm ci
npm run build
node dist/cli.js release install
qlb pi deploy
```

`node dist/cli.js release install` (same command as `qlb release install [--sha <sha>]`) publishes this build under `~/.qlb/app/<sha>` and points the `current` symlink at it. A dirty worktree fails with `qlb release: source tree is dirty` (exit 1). A `--sha` that does not match the compiled build stamp exits 3. `qlb pi deploy` copies that release's `extensions/qlb-pi`, plus `src/redact.ts` and `src/pi-owner-document.ts`, to `~/.pi/agent/extensions/qlb-pi` (shared sources sit beside the real extensions directory) and records `pi.deployedAt` and `pi.extensionHash`. After a matching deploy, `qlb doctor` reports `pi:extension` and `pi:extension-drift` as `PASS`.

On macOS, after Gate 5 has committed `pi-pool` to `QLB_OWNED`, install and load the switching agent. `<uid>` is the numeric user id from `id -u`:

```bash
qlb auto install-agent
launchctl bootstrap gui/<uid> ~/Library/LaunchAgents/com.modus.qlb-auto.plist
```

`qlb auto install-agent` writes `~/Library/LaunchAgents/com.modus.qlb-auto.plist` (mode 0600) with this Node binary and `~/.qlb/app/current/dist/cli.js auto`. Stdout and stderr go to `~/.qlb/auto.log`. The checked-in template with the `REPLACE_WITH_YOUR_USERNAME` placeholders is `scripts/launchagents/com.modus.qlb-auto.plist`; `install-agent` is the command that fills the real paths. Cutover, smoke, and rollback commands are in the [R1b cutover runbook](docs/R1B-CUTOVER-RUNBOOK.md).

## Installing as a Pi extension

QLB ships a Pi extension at `extensions/qlb-pi/index.ts` that lets [Pi](https://github.com/earendil-works/pi) route Anthropic requests through `qlb resolve` for account selection. `package.json` declares it via the `"pi": { "extensions": [...] }` manifest field that Pi's package installer reads, so it installs like any other Pi package:

```bash
pi install https://github.com/sanketvp/qlb          # global (~/.pi/agent/settings.json)
pi install https://github.com/sanketvp/qlb -l        # project-local (.pi/settings.json)
```

This registers the extension file with Pi — **it is a separate step from installing the `qlb` CLI itself**, and both are required for the extension to actually do anything:

1. **Register the extension** with `pi install` (above), or publish the release copy with `qlb pi deploy` (see [Release install](#release-install)).
2. **Make the `qlb` CLI available.** The extension shells out to a `qlb` binary at runtime (`findQlbCli()` in `extensions/qlb-pi/index.ts`): it looks for a built `dist/cli.js` next to the extension first, then falls back to whatever `qlb` resolves to on `PATH`. Installing the Pi extension alone does **not** build or install that CLI — run `bash scripts/install.sh` (or `npm install && npm run build && npm link`) from this repo so `qlb` is on `PATH`, or otherwise ensure a built `dist/cli.js` ships alongside the installed extension. The production agent uses `~/.qlb/app/current/dist/cli.js`.

`qlb pi deploy` (`[--dry-run] [--json]`) is the release deployment. It refuses until `qlb release install` has published a `current` tree that contains `qlb-pi`. A successful deploy is what makes doctor checks `pi:extension` and `pi:extension-drift` pass against that release.

Even fully installed this way, the extension is **inert by default**: it only activates when `~/.pi/agent/qlb-owner.json` exists, which is created solely by QLB's own `qlb migrate ... --confirm-real-cutover` flow — never automatically by `pi install`. See [Credential Safety](docs/CREDENTIAL-SAFETY.md) before running that migration.

Owned Anthropic follows Claude Code's active account. Pool adoption binds each Pi pool member to an existing Claude slot and does not write `active_login`. Commit moves `extensions/anthropic-pool` to `extensions-disabled-by-qlb` so the owned gate can serve. Bounded smoke (`qlb gate anthropic --no-refresh`, or `QLB_PI_OWNED_SMOKE=1`) does not refresh or retry.

Typecheck the extension against the Pi you actually run with `npm run typecheck:pi` (or `qlb doctor --live`); `extensions/qlb-pi/tsconfig.json` deliberately carries no machine-specific Pi paths, so a bare `tsc -p extensions/qlb-pi/tsconfig.json` cannot resolve Pi's packages. If your `pi` is a wrapper QLB cannot trace (e.g. a compiled shim), set `QLB_PI_PACKAGE_ROOT` to the `@earendil-works/pi-coding-agent` package it runs.

## qlb-pi footer

Once active, `qlb-pi` replaces Pi's footer with a compact 2-line status view rendered every session (`extensions/qlb-pi/footer.ts` / `index.ts`):

```
sid:a1b2c3d4 · qlb · main · 42%ctx · claude-opus-5-5
★ user · 5h 12% · 7d 38% · sync ok · cache display · 4 owned · 9 accts
```

- Line 1 is the same identity info Pi's footer already showed: session id, repo, git branch, context-window percent, and the active model.
- Line 2 is QLB's own **cache display**: the last selected account (colored, `★`-marked), its persisted top usage buckets, native-credential drift status (`sync ok`, `N drift`, or `FAIL`), the `cache display` provenance segment, QLB_OWNED store count, and total account count — joined with ` · `. These labels cannot select or retain an account; only a fresh direct provider reading can do that. Email labels are shortened to the local part (`user@example.com` → `user`).

Press **`ctrl+alt+q`** (or run **`/qlb expand`**, alias `/qlb details`) to toggle an expanded detail panel above the compact footer, showing every configured provider grouped by ownership state, each account's full per-bucket usage, any native-sync drift rows from `qlb doctor`, and the last few `qlb resolve` decisions made in this session. Press the same shortcut (or run the command again) to collapse it back to the 2-line view.

## Installing as a Claude Code plugin

QLB ships a `.claude-plugin/` directory so this repo can act as its own [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin marketplace — no central registry, no separate repo to publish. `.claude-plugin/marketplace.json` declares one plugin (`qlb`) sourced from `./`; `.claude-plugin/plugin.json` is that plugin's manifest, plus a single read-only slash command at `commands/qlb-status.md`.

```bash
claude plugin marketplace add https://github.com/sanketvp/qlb   # register this repo as a marketplace
claude plugin install qlb@qlb                                    # install the qlb plugin from it
```

Both commands accept `-s/--scope user|project|local` (default `user`); prefer `--scope local` for a per-checkout test that never touches your global Claude Code config (verified: it writes only to that project's `.claude/settings.local.json`).

What's included, deliberately minimal:

- **`/qlb-status` slash command** — shells out to `qlb status` and shows the output verbatim. Read-only, fail-open: if `qlb` isn't installed or the call errors, it says so plainly instead of failing.

A fuller integration (a hook that surfaces `qlb resolve` advisory info before each request, mirroring the Pi extension and the `qlb_advisory` pattern in `pi-dispatch.sh`) was considered but deferred — Claude Code's hook lifecycle/event shape for this use case wasn't exercised enough in this pass to ship with confidence under the same fail-open safety bar as the rest of QLB's integrations. The slash command above is the safe, minimal starting point; a hook can follow once validated the same way.

As with the Pi extension, this **registers** the plugin — it does not install the `qlb` CLI itself. Run `bash scripts/install.sh` (or `npm install && npm run build && npm link`) from this repo first so `qlb status` has something to call.

## Status views

`qlb status` (default human view) is a **dashboard**: one block per account with a health glyph, credential-ownership state, and any active override; QLB-owned Anthropic accounts can also show login-expiry or unavailable-usage details before their indented bucket rows.

| Glyph | Meaning |
|---|---|
| ✓ | every bucket under 80% |
| ⚠ | any bucket 80–99% |
| ✗ | any bucket at 100%, or the account has an error |

Ownership is `NATIVE` / `MIRRORED` / `VALIDATED` / `QLB_OWNED` / `RETIRED` from `qlb migrate status` for that provider. Overrides show `none` unless a pin/reserve/drain-first row is active (`qlb override …`).

```bash
qlb status                 # dashboard (default)
qlb status --dashboard     # same as default
qlb status --flat          # original provider | account | bucket table
qlb status --json          # additive machine-readable status; see docs/CLI.md#qlb-status
```

`--json` does not remove or rename fields, so existing parsers of `qlb status --json` keep working. Its `usedPct`, derived `leftPct`, rounded labels, and health glyphs are presentation/cross-check data; they cannot affect selection.

### Explaining and auditing decisions

- **`qlb why`** — explains the routing result from the **last persisted observation** per provider. It never probes the network and never writes a decision row; output includes the observation timestamp/generation (or `never probed — store snapshots only`) and a hint to run `qlb refresh --allow-probe`. A persisted observation without fresh direct provider readings reports `UNAVAILABLE`, not a candidate. Providers whose plugin does not persist snapshots are labelled `observation: unavailable`. Pi may call `qlb why --model claude-fable-5-1 --fallback claude-opus-5-5 --json` as observation input for its own Fable→Opus session policy; QLB itself does not switch Pi sessions. `status: ok` is not a freshness certificate. Opening the store may still create or migrate local files. ([CLI](docs/CLI.md#qlb-why))
- **`qlb audit`** — read-only listing of recent routing decisions (default `--limit 20`) with the real strategy/provider used; non-routing proxy rows are filtered. ([CLI](docs/CLI.md#qlb-audit))
- **`qlb refresh --allow-probe`** — the explicit way to poll providers, because it makes real requests. Add `--provider kimi-coding` or `--provider openai-codex` to poll only that provider; the scoped Codex path persists its provider-reported quota windows and a limited redacted diagnostic. (Note: `qlb status` also reaches provider adapters via `fetchSnapshots()`, so it is not a cache-only read either; `qlb why` is non-probing but may still open the normal store.) Per-provider statuses: `ok`, `partial`, `no-data`, `no-probe`, `error`. ([CLI](docs/CLI.md#qlb-refresh))
- **`qlb export --cache-only --json`** — emits the last persisted readings without loading provider adapters or credential stores, migrating the database, or making network requests. It is the read-only cache interface for status consumers. ([CLI](docs/CLI.md#qlb-export))

## Harness setup (`qlb setup`)

Non-destructive. Prints copy-paste snippets only; never edits files outside this repo (the `pi` harness also writes `scripts/hooks/pi-advisory.sh` here so you can `source` it).

```bash
qlb setup pi                 # verbatim qlb_advisory() from Pi dispatch; source scripts/hooks/pi-advisory.sh
qlb setup claude-code        # ANTHROPIC_BASE_URL + Bearer / x-api-key against qlb proxy
qlb setup codex-cli          # ~/.codex/config.toml model_provider pointing at POST /v1/responses
qlb setup generic            # qlb resolve --json + jq, for cron / CI / any shell runner
qlb setup pi --json          # { harness, instructions, snippetWritten? }
```

## Built-in providers

- Anthropic / Claude
- OpenAI Codex
- xAI / Grok
- Kimi Coding
- OpenRouter

Each provider remains responsible for its own account and credential format. QLB reads configured sources and does not include credentials in its configuration file.

## Configuration

Values resolve in this order: command-line flag, environment variable, `~/.qlb/config.json`, then the built-in default. Paths may begin with `~/`.

| JSON field | Environment variable | CLI flag |
|---|---|---|
| `anthropicPoolPath` | `QLB_ANTHROPIC_POOL_PATH` | `--anthropic-pool-path` |
| `piAuthJsonPath` | `QLB_PI_AUTH_JSON_PATH` | `--pi-auth-json-path` |
| `codexAuthJsonPath` | `QLB_CODEX_AUTH_JSON_PATH` | `--codex-auth-json-path` |
| `kimiCredentialsFile` | `QLB_KIMI_CREDENTIALS_FILE` | `--kimi-credentials-file` |
| `openrouterKeychainService` (fixed `pi-openrouter`; overrides are refused) | `QLB_OPENROUTER_KEYCHAIN_SERVICE` | `--openrouter-keychain-service` |
| `dbPath` | `QLB_DB_PATH` | `--db-path` |
| `pluginsDir` | `QLB_PLUGINS_DIR` | `--plugins-dir` |
| `proxyInfoPath` | `QLB_PROXY_INFO_PATH` | `--proxy-info-path` |
| `claudeCodeCredentialsPath` | `QLB_CLAUDE_CODE_CREDENTIALS_PATH` | `--claude-code-credentials-path` |
| `cswapSequencePath` | `QLB_CSWAP_SEQUENCE_PATH` | `--cswap-sequence-path` |
| `cswapUsagePath` | `QLB_CSWAP_USAGE_PATH` | `--cswap-usage-path` |
| `defaultStrategy` | `QLB_DEFAULT_STRATEGY` | `--default-strategy` |

`openrouterKeychainService` is fixed to `pi-openrouter`: QLB never reads an arbitrary native Keychain service. The legacy environment variable and flag are accepted only so `qlb doctor` can identify and explain a stale override; any value other than `pi-openrouter` is refused.

Use `QLB_CONFIG_PATH` or `--config` to select a different JSON config file.

Example:

```json
{
  "anthropicPoolPath": "~/.pi/agent/anthropic-pool.json",
  "codexAuthJsonPath": "~/.codex/auth.json",
  "kimiCredentialsFile": "~/.config/kimi/credentials.md",
  "dbPath": "~/.qlb/qlb.db",
  "pluginsDir": "~/.qlb/plugins"
}
```

## Custom providers

Place `.js` adapter files in `~/.qlb/plugins/`. QLB loads valid plugins alongside its built-in adapters, warns and skips files that cannot load, and contains runtime failures from individual plugins.

See [docs/plugins.md](docs/plugins.md) for the exact adapter shape and a complete example.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the core pipeline: adapters, live-query capacity model, confidence levels, headroom scoring, single-flight poll coalescing, credential refresh, storage, and the proxy.
- [docs/PROVIDERS.md](docs/PROVIDERS.md) — per-provider detail for the five built-in adapters: credential source, usage signal, confidence level, and caveats.
- [docs/CLI.md](docs/CLI.md) — full command reference with real flags and captured example output.
- [docs/CREDENTIAL-SAFETY.md](docs/CREDENTIAL-SAFETY.md) — what QLB will and will not do with your credentials, and the crash-safety guarantees of the ownership migration.
- [docs/DESIGN-HISTORY.md](docs/DESIGN-HISTORY.md) — how the design was reviewed, and why local usage accounting was deliberately removed.
- [docs/plugins.md](docs/plugins.md) — adding custom providers as local JavaScript plugins.
- [docs/R1B-CUTOVER-RUNBOOK.md](docs/R1B-CUTOVER-RUNBOOK.md) — release install, Gate 5 cutover, Gate 6 smoke and the S30 guard, Gate 7 `com.modus.qlb-auto`, doctor checks, and rollback.
- [docs/CLAUDE-SWITCHING.md](docs/CLAUDE-SWITCHING.md) — Claude switching provenance, and where QLB's transaction and credential-safety rules differ from the vendored claude-swap port.

## Design philosophy

Two documents are the most important reads before trusting this tool with real credentials:

- [CREDENTIAL-SAFETY.md](docs/CREDENTIAL-SAFETY.md) — QLB can optionally take ownership of your credentials, but every credential-touching operation requires an explicit confirmation flag, has a rehearsal step before any real cutover, and has a documented rollback path. Every crash point resolves to "native still works" or "QLB works," never neither.
- [DESIGN-HISTORY.md](docs/DESIGN-HISTORY.md) — the design went through six rounds of adversarial review before implementation, including one deliberate pivot: a local usage-reservation system was designed, found to have unfixable crash-safety issues, and replaced with the simpler pure-live-query model that shipped. "Why we don't do local usage reservations" is a real design note for anyone extending this.

## Development

```bash
npm run build
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.

## License

MIT — see [LICENSE](LICENSE).
