# QLB — Cross-Provider Quota Load Balancer

QLB is a local command-line tool that gives one view of quota and usage across multiple AI coding providers. It discovers credentials without modifying them, caches provider readings in SQLite, and can select an account or fallback model using available headroom.

QLB ships with five provider adapters and can load additional providers as local JavaScript plugins. Network-backed usage checks are isolated so one unavailable provider or broken plugin does not crash the overall status command.

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

`qlb init` detects existing credential sources, reports anything missing, and writes a reviewable starter file at `~/.qlb/config.json`. It never prompts, so it is safe to use in scripts and CI. `qlb doctor` performs local checks only by default; add `--live` to opt into provider network calls.

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

## Development

```bash
npm run build
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.

## License

MIT — see [LICENSE](LICENSE).
