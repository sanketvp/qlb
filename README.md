# QLB — Cross-Provider Quota Load Balancer

**The headline feature: if you have multiple Claude accounts, multiple Codex accounts, or both, QLB automatically load-balances your usage across all of them.** Run out of headroom on one Claude account and QLB routes the next request to whichever of your other Claude accounts still has room — same for Codex — so you stop babysitting which login is about to hit its 5-hour or weekly limit and manually switching. It picks the best account for every request based on real, live usage data (not guesses), spreads normal usage so no single account gets drained first, and only reaches for a genuinely different model/provider as a fallback when you've explicitly said that's OK.

QLB extends the same account-pooling idea to Grok, Kimi K3, and OpenRouter too — the same load-balancing engine works across any number of accounts on any provider, not just Claude and Codex.

QLB ships with five built-in provider adapters (Claude/Anthropic, Codex, Grok/xAI, Kimi K3, OpenRouter) and can load additional providers as local JavaScript plugins for anything else you use. It never modifies your existing credentials unless you explicitly opt in to full account ownership (see [Credential Safety](docs/CREDENTIAL-SAFETY.md)), and one unavailable provider or broken plugin never crashes the overall status/routing commands.

## Requirements

- Node.js 22 or newer
- macOS for Keychain-backed credentials (other status and configuration features remain usable elsewhere)

## Quickstart

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js status
```

After installing the package globally, use `qlb` instead of `node dist/cli.js`:

```bash
qlb init --json
qlb doctor
qlb status --json
qlb resolve --model claude-sonnet-5 --json
```

Or run the idempotent installer (Node.js >= 22, `npm ci`/`npm install`, build, optional global `npm link`, then `qlb init`):

```bash
bash scripts/install.sh
```

If `npm link` cannot write a global bin, the script prints fallbacks (`PATH`, `sudo`, or `npx`) and still bootstraps via `node dist/cli.js init`.

`qlb init` detects existing credential sources, reports anything missing, and writes a reviewable starter file at `~/.qlb/config.json`. It never prompts, so it is safe to use in scripts and CI. `qlb doctor` performs local checks only by default; add `--live` to opt into provider network calls.

## Status views

`qlb status` (default human view) is a **dashboard**: one block per account with a health glyph, credential-ownership state, and any active override, then indented bucket rows.

| Glyph | Meaning |
|---|---|
| ✓ | every bucket under 80% |
| ⚠ | any bucket 80–99% |
| ✗ | any bucket at 100%, or the account has an error |

Ownership is `NATIVE` / `MIRRORED` / `VALIDATED` / `QLB_OWNED` / `RETIRED` from `qlb migrate status` for that provider. Overrides show `none` unless a row already exists in the `overrides` table (no pin/reserve/drain-first CLI is wired yet).

```bash
qlb status                 # dashboard (default)
qlb status --dashboard     # same as default
qlb status --flat          # original provider | account | bucket table
qlb status --json          # additive JSON: existing fields kept; adds ownership, override, health, healthGlyph
```

`--json` does not remove or rename fields, so existing parsers of `qlb status --json` keep working.

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
| `openrouterKeychainService` | `QLB_OPENROUTER_KEYCHAIN_SERVICE` | `--openrouter-keychain-service` |
| `dbPath` | `QLB_DB_PATH` | `--db-path` |
| `pluginsDir` | `QLB_PLUGINS_DIR` | `--plugins-dir` |
| `proxyInfoPath` | `QLB_PROXY_INFO_PATH` | `--proxy-info-path` |
| `claudeCodeCredentialsPath` | `QLB_CLAUDE_CODE_CREDENTIALS_PATH` | `--claude-code-credentials-path` |

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
