# Providers

QLB ships with five built-in provider adapters (`src/adapters/`). Each one is read-only with respect to credentials and returns `AccountSnapshot`s — named buckets with a `usedPct`, a `confidence` level, a `source`, and a `fetchedAt` timestamp. Two usage-signal shapes exist:

- **Polled** — the provider exposes a free GET endpoint, so QLB can refresh a reading at decision time (coalesced through the single-flight claim; see [ARCHITECTURE.md](ARCHITECTURE.md)).
- **Header-observed** — the provider only reports usage on real requests, so readings come from response headers of traffic that actually went through QLB's proxy/transport.

An adapter must never throw: failures become an error snapshot on the account (visible in `qlb status`), so one unavailable provider never breaks the overall status command.

---

## Anthropic / Claude (`anthropic`)

- **Credential source:** a multi-account pool JSON file (default `~/.pi/agent/anthropic-pool.json`, configurable via `QLB_ANTHROPIC_POOL_PATH`). Each account entry carries OAuth `access`/`refresh`/`expires`.
- **Usage signal:** real GET — `https://api.anthropic.com/api/oauth/usage` per account, with `Authorization: Bearer <access>` and the `anthropic-beta: oauth-2025-04-20` header. 10-second timeout, no retries.
- **Buckets:** `5h` (`five_hour.utilization`), `7d` (`seven_day.utilization`), and per-model-family weekly buckets `7d:Fable` / `7d:Opus` / `7d:Sonnet` / `7d:Haiku` parsed from `limits[]` entries of `kind: "weekly_scoped"` (with a fallback parser for the older `seven_day_<model>` response shape). Dollar figures (`used_dollars` etc.) are attached when the endpoint provides them.
- **Confidence:** `authoritative` — this is the provider's own gauge, fetched fresh at decision time.
- **Caveats:** an expired or invalid access token surfaces as `auth expired or invalid — needs re-login` on that account only. Phase-0 adapters never refresh tokens themselves; expired accounts need the native harness to log in once.

## OpenAI Codex (`openai-codex`)

- **Credential source:** Codex CLI's own `~/.codex/auth.json` (`tokens.access_token`; account id and label parsed from the `id_token` JWT claims). Configurable via `QLB_CODEX_AUTH_JSON_PATH`.
- **Usage signal:** response headers only. Codex exposes no standalone usage GET; `x-codex-primary-used-percent` (weekly), `x-codex-secondary-used-percent` (5-hour), and related reset/pool headers arrive on real requests to the Codex backend. The adapter itself therefore reports an authenticated account with **no buckets** — numbers populate when real traffic flows through `qlb proxy` (whose `parseUsageHeaders` writes header-derived readings into the same snapshot cache).
- **Buckets:** `primary` (weekly), `secondary` (5-hour).
- **Confidence:** `authoritative` once a header-derived reading exists; `unknown` before that (which makes the account a cold-start candidate only, never excluded by a missing number).
- **Caveats:** because every reading requires a real request, Codex data is exactly as fresh as the last request that went through. There is no free refresh, and QLB does not send probe requests on its own in the CLI path.

## xAI / Grok (`xai`)

- **Credential source:** the `xai` entry (OAuth `access`/`expires`) in Pi's `auth.json` (configurable via `QLB_PI_AUTH_JSON_PATH`). Read-only: if the grant is expired, the adapter reports `xai grant expired — run pi once to refresh it` rather than refreshing it itself.
- **Usage signal:** response headers of a minimal real request — a single 1-token `POST https://api.x.ai/v1/chat/completions` (hard 15-second timeout, no retries), with `x-ratelimit-limit-tokens` / `x-ratelimit-remaining-tokens` and the request-counter equivalents parsed into percentages. There is no free gauge endpoint.
- **Buckets:** `tokens`, `requests`.
- **Confidence:** always `advisory`. This is a deliberate, documented choice: xAI's headers describe a *refilling* developer-API bucket with no reset timestamp, and it is not proven that the numbers match the SuperGrok in-app meter a user actually sees. Advisory buckets are displayed (as `~NN%`) and used only as tie-breakers — they never exclude an account, and a reactive `429` from xAI is treated as the authoritative exhaustion signal.
- **Caveats:** each refresh of the reading consumes a (tiny) real request. Concurrent callers share one probe through the single-flight claim, and readings are cached so repeated `status`/`resolve` calls do not re-probe.

## Kimi Coding (`kimi-coding`)

- **Credential source:** a file containing a static `sk-kimi-…` API key (default path configurable via `QLB_KIMI_CREDENTIALS_FILE`). A static key is used because the OAuth token variant was observed to be rejected by this endpoint. The key is matched out of the file by pattern; the file is never modified.
- **Usage signal:** real GET — `https://api.kimi.com/coding/v1/usages` with `Authorization: Bearer <key>`. 10-second timeout.
- **Buckets:** `weekly` (the top-level `usage` block: `limit`/`used`/`remaining`/`resetTime`), plus one bucket per rolling window in `limits[]` — a 300-minute window maps to `5h`; other durations become `window:<minutes>min`. The account id and membership level come from the response's `user` block.
- **Confidence:** `authoritative` — provider's own gauge, fetched fresh.
- **Caveats:** the endpoint requires the static key (not the OAuth grant). Kimi documents the *shape* of its limits but publishes no numeric plan allowances.

## OpenRouter (`openrouter`)

- **Credential source:** a static API key in the platform credential store (service `pi-openrouter`, configurable via `QLB_OPENROUTER_KEYCHAIN_SERVICE`). On macOS this is a Keychain item read via `security find-generic-password`; on Linux, `secret-tool` or the encrypted-file fallback; on Windows, a DPAPI blob. QLB never writes or rotates that native item.
- **Usage signal:** real GET — `https://openrouter.ai/api/v1/credits` with `Authorization: Bearer <key>`.
- **Buckets:** a single `credits` bucket: `total_usage` / `total_credits` as used percentage, with absolute `used`/`limit`/`remaining` attached.
- **Confidence:** `authoritative` for what it measures — but the reading carries an explicit `detail` note: it is an **account-wide credit balance, not a rolling rate-limit window**. There is no reset time (`resets` shows `-`), and the bucket is classified as a balance rather than a window for scoring purposes.
- **Caveats:** OpenRouter's per-model routing means QLB selects *that you use OpenRouter*; model availability and per-model pricing remain OpenRouter-side concerns.

---

## Custom providers

Additional providers can be added as local JavaScript plugins in `~/.qlb/plugins/` — see [plugins.md](plugins.md) for the exact adapter shape and a complete minimal example. Plugins are loaded alongside the built-ins, and a crashing plugin is contained: it produces a warning and an error snapshot rather than affecting other providers.

## Adding a new provider: what to get right

The design doc's provider matrix (verified against live endpoints before implementation) is the template for onboarding a provider:

1. Identify a **real gauge**: a free usage GET (best), or response headers on real requests (acceptable — but the reading is then only as fresh as the traffic), or nothing (then the account can only be managed reactively, via 429s).
2. Decide the **confidence** honestly: if the gauge cannot be proven to be the billing meter, mark it `advisory` so it can never exclude an account.
3. Map buckets to **window classes** (5-hour vs weekly) so the scarcity discount weights them correctly.
4. Never write credentials; report errors as snapshots, never as throws.
