# Architecture

## What QLB is

QLB (Quota Load Balancer) is a local command-line tool for people who use more than one AI coding account or provider. Each provider enforces several independent limits at once — a short rolling window (typically 5 hours), a weekly window, and sometimes per-model-family pools — and each account hits its own ceilings independently. Without a cross-provider view, a session can stall on "one model family exhausted" while the same account still has weekly headroom, or while another account of the same provider is barely touched.

QLB gives one answer to the question *"which account should serve this request?"* It reads real, live usage gauges from each provider, scores every eligible account by remaining headroom, and can additionally act as a loopback proxy that selects the account and injects the right credential per request. It is a single-machine tool: a TypeScript CLI plus library, backed by a local SQLite database. It ships with five provider adapters and can load additional providers as local JavaScript plugins (see [plugins.md](plugins.md)).

## The core pipeline

```
 provider adapters          SQLite store               selection
┌───────────────────┐   ┌────────────────────┐   ┌──────────────────────┐
│ anthropic  (poll) │   │ accounts           │   │ scoring (Rule S)     │
│ kimi-coding(poll) │──▶│ snapshots (cache)  │   │ fresh provider only  │
│                  │   │ display/cross-check │──▶│ headroom → all-in    │
│ xai      (headers)│   │ decisions (audit)  │   │  → fallback walk     │
│ openai-codex: both│   │ poll_claims        │   │  → EXHAUSTED         │
│ openrouter (poll) │   │ leases/migrations  │   └──────────┬───────────┘
│ + ~/.qlb/plugins  │   │ policies/overrides │              │
└───────────────────┘   └────────────────────┘   ┌──────────▼───────────┐
                                                 │ consumers:           │
         credentials ────────────────────────▶   │  qlb resolve (CLI)   │
         OS credential store (macOS Keychain /   │  qlb proxy (loopback │
         libsecret / DPAPI; CAS-fenced refresh)  │   HTTP for harnesses)│
                                                 └──────────────────────┘
```

Every adapter implements one small interface (`src/types.ts`):

```ts
export interface Adapter {
  id: string;
  displayName: string;
  /** Read-only: fetch current usage for all accounts this adapter knows about.
      Must NEVER throw — catch internally and return an AccountSnapshot with
      `error` set instead. */
  fetchSnapshots(): Promise<AccountSnapshot[]>;
}
```

Adapters are strictly read-only with respect to credentials: Phase-0 adapters discover credential sources (a pool JSON file, an `auth.json`, a Keychain service) and never modify them. Credential *ownership* — where QLB holds and refreshes a grant itself — is a separate, explicitly confirmed migration flow (see [CREDENTIAL-SAFETY.md](CREDENTIAL-SAFETY.md)).

**Live Anthropic path.** Production keeps the `pi-pool` journal at `QLB_OWNED` and the `cswap-anthropic` journal at `NATIVE`. Switching, the single-owner boundary, the S30 token guard, and extension deploy are described in [Live Anthropic ownership](#live-anthropic-ownership). The operational procedure is [R1B-CUTOVER-RUNBOOK.md](R1B-CUTOVER-RUNBOOK.md).

**Consume Option B** is the alternate read-only Claude Code path, and it stays off while Pi's Anthropic accounts are QLB-owned. Anthropic *status* on that path is a cache-only projection of cswap `sequence.json` + `usage.json` (never `cswap list`, never the Anthropic usage URL). That cache cannot establish credential-attributable provider capacity, so a `cswap-anthropic=CONSUMED` request fails unavailable before the proxy reads a Claude Code credential. Pi consume does not use that admission gate: a missing or stale quota reading is unknown and Pi serves the active Claude Code Keychain item read-only, refusing only a fresh provider reading that shows that login is exhausted. The user-facing journal behavior is documented under [`qlb consume`](CLI.md#qlb-consume).

Each adapter returns `AccountSnapshot`s containing named **buckets** (`5h`, `7d`, `7d:Fable`, `weekly`, `primary`, `tokens`, `credits`, …). Every bucket reading carries a `confidence` level and a `fetchedAt` timestamp. Only a fresh direct provider reading drives routing; all other readings remain display and cross-check data.

## Live-query only: why QLB does not count your usage

QLB never meters usage locally. It holds no request counters, no cost estimates, and no reservations. The only capacity data it keeps is a **cache of the last real gauge reading per `(account, bucket)`** — from a usage endpoint (Anthropic, Kimi, OpenRouter, and explicitly authorized scoped Codex refresh), from response headers of a request that actually went through (Codex, xAI), and nothing else.

This was a deliberate simplification, made after an earlier design (local usage self-accounting plus a reservation/heartbeat system to handle request bursts) could not be made crash-safe across two review rounds. The details are in [DESIGN-HISTORY.md](DESIGN-HISTORY.md); the short version:

- **Providers already meter usage.** Duplicating that metering locally means guessing request costs, tracking in-flight work, and reconciling estimates against gauges — every one of those is a place where a crash or a lag produces silently wrong decisions.
- **Gauge lag is bounded and self-correcting.** A burst of simultaneous requests may briefly pile onto the currently-best account, because no decision's own effect shows up in a gauge until the provider reports it. The pile-on lasts exactly one round-trip of real data: the next poll (or the first response's headers) sees the consumption and scoring diverges again.
- **What's lost is bounded by the caller, not QLB.** QLB enforces no concurrency limit; the practical bound is the caller's own concurrency. This is stated rather than hidden.

The consequence in code: a `resolve` has no side effect on capacity data other than possibly *reading* a fresh gauge. The only thing it writes is an audit row in `decisions`.

## Confidence levels

Every bucket reading carries one of four confidence levels (`src/types.ts`). Confidence affects scoring only after the routing-admission gate has accepted a current direct provider reading:

| Level | Meaning | Role in scoring |
|---|---|---|
| `authoritative` | Value came from the provider's own gauge | Eligible only when direct (`provider-poll` / `provider-headers`) and no more than five minutes old; then scored at full weight |
| `stale` | An authoritative value that has aged past its freshness bound | Display-only for routing |
| `advisory` | Provider gauge exists but is unproven to be the billing meter (all xAI buckets today) | Display-only for routing |
| `unknown` | Never observed | Display-only for routing |

The xAI case is the concrete example of why `advisory` exists: xAI's rate-limit headers describe a refilling developer-API bucket with no reset timestamp, and there is no evidence it matches the in-app meter a user actually sees. QLB displays those numbers (`~NN%`), but they cannot establish capacity or exhaustion.

## Scoring: headroom-then-all-in

Selection is a min-of-headrooms rule ("Rule S" in the design spec), implemented in `src/scoring.ts`:

```
score = min over scored buckets b of ( discount_b × headroom_b × f_b )

headroom_b = ceiling − usedPct_b            ceiling defaults to 80; fresh provider values only
discount_b = 1.0 (5-hour-class buckets)
           = 0.6 (weekly-class buckets)     WEEKLY_SCARCITY
f_b        = 1.0 (fresh direct provider reading)
score      = -Infinity when no bucket is scored; unmeasured accounts are unavailable
```

The scarcity discount is the part that is easy to get backwards, and an earlier revision of the design *did* get it backwards. Weekly capacity recovers slowly (up to 7 days), 5-hour capacity recovers quickly, so a thin *weekly* margin should drive an account's score down faster than a thin 5-hour margin. That is achieved by multiplying the weekly headroom by a number **less than 1** (0.6), which makes the weekly term the first to hit the minimum — not by weighting it above 1.

**Worked example 1 — swapped headrooms** (ceiling 80, all buckets authoritative):

| Account | 5h used → headroom | weekly used → headroom | terms in `min()` | score |
|---|---|---|---|---|
| A | 70 → 10 | 20 → 60 | min(1.0×10, 0.6×60=36) | **10** |
| B | 40 → 40 | 65 → 15 | min(1.0×40, 0.6×15=9) | **9** |

A wins. B's raw headrooms (40 and 15) look fine, but its weekly margin of 15 is the scarcest resource in the system, and the 0.6 discount surfaces that.

**Worked example 2 — mixed confidence** (the case that motivated explicit confidence states):

| Account | 5h | 7d | per-model pool | terms in `min()` | score |
|---|---|---|---|---|---|
| G | authoritative, fresh direct, 50 used → 30 | authoritative, fresh direct, 40 used → 40 | unknown | min(30, 0.6×40=24) | **24** |
| H | authoritative, 60 → 20 | authoritative, 30 → 50 | authoritative, 45 → 35 | min(20, 30, 21) | **20** |
| I | unknown | unknown | advisory ~40% | no eligible direct reading | **UNAVAILABLE** |

G wins (24 > 20). Its unknown pool bucket neither helps nor hurts. I remains visible in status, but is unavailable until it receives a fresh direct provider reading.

Selection then proceeds in a fixed ladder (`src/resolve.ts`):

1. Admit only accounts with a fresh direct provider reading for every available relevant bucket. If a model admits none, continue down the fallback chain.
2. Score admitted candidates at ceiling 80. `headroom` keeps the first candidate in snapshot order when best scores are equal. `spread` treats scores within `SPREAD_MARGIN` as near-tied and hashes the session id across those candidates; neither advisory headroom nor least-recently-decided state affects selection.
3. None → **all-in mode**: recompute at ceiling 100, pick the max. Logged as `mode: "all-in"`.
4. Still none → walk the caller's fallback list (`--fallback m1,m2`), repeating per model. The served model is always reported (`servedModel` vs `requestedModel`); effort is never silently downgraded.
5. Still none → `UNAVAILABLE` if no model admitted an account or any pool was unadmitted; otherwise `EXHAUSTED` with the earliest known reset across all candidates and buckets.

Every decision is persisted to the `decisions` table with a per-bucket `snapshot_json` (value, confidence, source, `ageMs`) so any past decision can be audited after the fact. The dashboard's `100 - used` remaining value and its rounded LOW/EXHAUSTED labels are presentation-only; they are never selection inputs.

## Selection strategies

Rule-S scoring is the engine, not the whole policy. `src/strategies.ts` layers four selectable selection policies on top of it, chosen per resolve via `qlb resolve --strategy <headroom|spread|round-robin|failover>` (default `headroom`; `defaultStrategy` in the config sets a different default persistently):

- **`headroom`** (default) — the scoring section above verbatim: single best account by Rule-S score, headroom-then-all-in, then the fallback-model walk.
- **`spread`** — same scoring, but candidates within `SPREAD_MARGIN` (10 points) of the best score are treated as tied, and the tie is broken by a deterministic hash of the session id. Concurrent sessions with equal-quality options therefore land on different accounts instead of piling onto one; a resolve with no session id falls back to plain `headroom`.
- **`round-robin`** — scores are used only to exclude unavailable, exhausted, and errored accounts; selection cycles through the remaining accounts in account-id order using a persistent per-provider counter in the store.
- **`failover`** — stick with the current account while every relevant bucket with a known reading is under 100%; switch only when it is genuinely exhausted. Minimizes account churn at the cost of even spreading.

`headroom` is the default and the most-tested path. The other three exist because "pick the single best account" is not always the goal: `spread` and `round-robin` deliberately trade peak headroom for parallel multi-account coverage, and `failover` trades spreading for stability. All four share the same override layer (`src/overrides.ts`): a session pin beats any strategy, reserved accounts are removed before selection, and drain-first accounts are tried before the rest — so explicit operator intent always outranks the automatic policy. Every decision still records the strategy used, keeping the audit trail attributable regardless of policy.

## Single-flight poll coalescing

Without coordination, N processes that notice the same stale cache at the same instant would each fire their own usage GET. QLB coalesces them with a TTL-only claim (`poll_claims` table, `src/single-flight.ts`):

1. Read the cache. If a reading newer than the one you last saw is present, use it — no network call (the common path).
2. Otherwise, take a short claim row inside one `BEGIN IMMEDIATE` transaction. Losers of the race wait (bounded by the claim's TTL) for the winner's result to appear.
3. The winner fetches *outside* any transaction and writes results back only if its claim is still current at write time ("Rule W": a slow holder whose claim expired or was taken over has its late response silently discarded, so a takeover's fresher read always wins).
4. If a holder crashes, nothing is corrupted: the claim simply expires after its TTL and the next process takes over. A lost cache refresh costs one GET to redo — which is exactly why this mechanism deliberately uses a plain TTL claim rather than the heartbeat-and-generation fencing that credential refreshes need (see below).

Every fetch resolves to an explicit outcome (`FetchOutcome` in `src/types.ts`): `fetched` (a real provider call), `coalesced` (another caller's fresh result was reused), or `cached-after-failure` (the fetch failed inside the single-flight TTL, so the cached reading was kept). `cached-after-failure` is surfaced by `qlb refresh` (the account is classified `failed`); cached buckets remain visible to `resolve`/`status`, but cannot route until a later direct provider reading succeeds.

The same claim coalesces N concurrent callers *inside one process* as well: the holder id is per-operation (`processUuid:opId`), not per-process, so two async callers in one process cannot mistake each other's live claim for their own.

## Credential ownership and the fenced refresh

When a user opts in (always via an explicit migration flow), QLB takes ownership of OAuth grants: each grant lives as a JSON payload in the platform credential store (`service qlb:<provider>:<accountId>` — macOS Keychain, Linux libsecret or encrypted-file fallback, Windows DPAPI), and the journal in SQLite records a monotonically increasing `grant_generation` per account.

Two mechanisms with two distinct jobs protect concurrent refreshes (`src/refresh-lease.ts`):

- **The generation is the correctness mechanism.** Every write of a refreshed grant is a compare-and-swap on `grant_generation`, evaluated *inside* the same SQLite `BEGIN IMMEDIATE` transaction that performs the Keychain write. The generation number also travels inside the Keychain payload itself, so the write can be verified against it. A refresh computed from generation `g0` can never land after another process committed `g1` — the CAS fails and the stale result is discarded.
- **The lease is only de-duplication.** A bounded (15 s) heartbeat-renewed lease prevents N processes from each making the same refresh HTTP call. Losing it aborts the in-flight call via `AbortController`. Correctness never depends on the lease.

The crash analysis is explicit (C1–C4 in `refresh-lease.ts`): every crash point resolves to either "the old grant still works" or "the new grant is committed and readable" — the single genuinely unrecoverable window (crash after the provider consumed a rotated refresh token but before it was persisted, roughly one HTTP round-trip) is documented and surfaces loudly as an `auth_revoked` state requiring re-login, never as a silent wrong decision.

Reads are lock-free and fast-path: if the cached grant doesn't expire within 60 s, no lock is taken at all.

### Native credential drift and resync

Fencing coordinates QLB's processes against each other; it cannot coordinate with a *native* refresher that doesn't know QLB exists. For the shadow-retain providers (and during a partial Anthropic rollout where a native extension may still be live), native tooling can legitimately refresh the same underlying account and rotate its access token, silently invalidating QLB's frozen Keychain copy — surfacing as a `401` on an account QLB itself never refreshed. When that happens (`src/native-resync.ts`), QLB compares its owned credential to the provider's current native credential by SHA-256 fingerprint of the access token. Fingerprints **differ** → native refreshed independently: QLB overwrites its Keychain item with native's current credential (a single overwrite, preserving the owned grant's generation — no re-migration) and retries the request exactly once. Fingerprints are **identical** → the credential was genuinely revoked externally: QLB does not retry and surfaces the real error, since re-authentication through the native tool is the only fix. The same comparison runs read-only in `qlb doctor` (`native-sync:<accountId>` checks) so drift is visible before any request fails, and can be triggered manually via `qlb native-resync`. Every attempt lands in the audit trail, distinguishing "recovered via resync" from "genuine revocation." While `pi-pool` is `QLB_OWNED`, that doctor check still walks every Anthropic `accounts` row and reports a missing Keychain item with the same wording as an unreadable one. A follow-up scopes it to owned `pi-pool` members and separates those two outcomes; see [CREDENTIAL-SAFETY.md](CREDENTIAL-SAFETY.md#native-credential-drift-the-shadow-retain-tradeoff).

## Live Anthropic ownership

The R1b cutover left Anthropic on one owner. `qlb migrate status` for `pi-pool` reports state `QLB_OWNED` and `ownerFile: present`. Commit's hygiene step (`disableAnthropicPoolExtension` in `src/migration.ts`) moves `~/.pi/agent/extensions/anthropic-pool` to `~/.pi/agent/extensions-disabled-by-qlb/anthropic-pool` and journals `anthropicPoolExtension: disabled`, so Pi's native pool extension is not refreshing the same grants. Automated switching is `qlb auto`, kept running by the per-user LaunchAgent `com.modus.qlb-auto` (`renderAutoLaunchAgent` in `src/commands/auto.ts`; plist at `~/Library/LaunchAgents/com.modus.qlb-auto.plist`). The agent invokes `~/.qlb/app/current/dist/cli.js auto` and does not inherit the installing shell's environment. On the cutover host the native Claude pool refresh agent `com.modus.claude-pool-refresh` stays disabled, so it cannot rotate those grants beside `qlb auto`. Doctor's in-tree check of the former C-swap agent is a different label, `com.cswap.auto` (`cswap:agent` in `src/checks/cswap-agent.ts`). The cutover procedure itself is [R1B-CUTOVER-RUNBOOK.md](R1B-CUTOVER-RUNBOOK.md).

### One owner: `QLB_OWNED` and `NATIVE` stay apart

Two live OAuth refreshers on the same Anthropic grants rotate each other's access tokens. The September 8 cutover showed that failure, and the R1b boundary keeps it from recurring: `pi-pool` is `QLB_OWNED` and `cswap-anthropic` stays `NATIVE`. The code enforces that in both directions (`DUAL_OWNERSHIP_REFUSED` in `src/app.ts`):

- `qlb consume enable` returns exit 1 when the `pi-pool` journal is `MIRRORED`, `VALIDATED`, `QLB_OWNED`, or `RETIRED`, or when the Pi owner file claims Anthropic (`providers.anthropic.mode === "qlb"`, or a legacy owner entry). A malformed or unreadable owner file is treated as a claim; an absent file is not. The error names `qlb migrate rollback --provider anthropic` as the way back.
- `qlb migrate stage|rehearse|commit|resume --provider anthropic` returns exit 1 with the same code while the `cswap-anthropic` journal is `CONSUMED`. `status` and `rollback` still run. The error names `qlb consume disable --provider anthropic`.

`extensions/qlb-pi/consume.ts` `decidePiMode` applies the same rule when Pi loads. `QLB_PI_REHEARSAL=0` is `inert`. A malformed owner file is `conflict`. A valid owner file, or Anthropic rehearsal `QLB_PI_REHEARSAL=1`, is `owned` only when the consume journal is provably `NATIVE`; `CONSUMED` or an unreadable journal beside that claim is `conflict`. With no ownership claim, `CONSUMED` is `consume`, and a present consume marker beside any other journal is `conflict`. In `conflict`, `extensions/qlb-pi/index.ts` replaces Anthropic with a stub that returns an error (`conflictMessage`) and leaves the native pool extension out of the session.

### S30: who may call `qlb gate` and `qlb token`

`qlb gate` and `qlb token` print a credential only for a verified Pi parent. `tokenCallAllowed` in `src/commands/token.ts` is the shared predicate. `runPiGate` in `src/pi-gate.ts` calls it before opening the store or reading a grant. A gate refusal writes the bare cause `token-call-refused` to stderr and returns exit 3. Stdout stays empty: `QLB_PI_TOKEN_CALL=1 qlb gate anthropic --json --no-refresh` from an unauthorized shell (a TTY, or any parent that is not verified Pi) produces that cause code and no token. `--json` and `--no-refresh` are parsed and then never reached, so the refusal is not a JSON body. `qlb token` uses the same predicate for `xai`, `kimi-coding`, and `openrouter` and returns exit 3 with empty stdout when the parent is refused; the cause string is written on the gate path. `extensions/qlb-pi/active-access.ts` lists `token-call-refused` in `FIXED_CAUSE_CODES`. `qlbUnavailable` therefore shows `QLB unavailable for anthropic — run qlb doctor (token-call-refused)` instead of collapsing the cause to `unknown`.

`tokenCallAllowed` fails closed on any uncertainty:

- `QLB_PI_TOKEN_CALL` is exactly `1`.
- stdin and stdout are not TTYs.
- Interactive Pi sets `process.title` to `pi` (`INTERACTIVE_PI_PROCESS_TITLE`). On macOS, libuv's title overwrite replaces the argv `ps` prints, so `ps comm` and `ps command` are both `pi` while `ps ucomm` stays `node` (`darwinParent`). On Linux, `prctl` renames comm, so the executable name is the `/proc/<pid>/exe` basename (`linuxParent`). The parent is accepted when comm and command are exactly `pi` and that executable name is `node`, `nodejs`, or `node.exe`, and `locatePi` resolves a package root. A snapshot whose `ucomm` is the title, with Node proved only by a separate executable field, is refused. An argv that was not overwritten is accepted only when it is Node running a script inside that package's `dist`, with no code-injecting option (`-e`, `-r`, `--require`, `--eval`, `--import`, `--loader`, including the same shapes in `NODE_OPTIONS`).

Pi RPC is a separate verifier. Pi v1.5.2 sets `process.title` to `pi-rpc` in `dist/rpc-entry.js` or `dist/bundle/rpc-entry.js`, and that title is never sufficient on its own. `piRpcCallAllowed` in `src/pi-rpc-guard.ts` requires all of the following for the overwritten path: `comm` and `command` exactly `pi-rpc`, `ucomm` of `node` or `nodejs` (the kernel name, which `process.title` does not change on macOS), exactly one ELF or Mach-O Node text executable from `lsof -a -p <pid> -d txt -Fn`, `PI_CODING_AGENT=true` and `AI_AGENT=pi`, and a regular `dist/rpc-entry.js` or `dist/bundle/rpc-entry.js` inside the realpath of `@earendil-works/pi-coding-agent`. An argv that was not overwritten is accepted only when its script is one of those two entries and the command carries no code-injecting Node option. The module reads no credentials and writes no logs. `ucomm` equal to `pi-rpc` is refused even when a Node text executable is also present.

`tokenCallAllowed` calls `piRpcCallAllowed` after the marker and TTY checks and before the interactive `pi` checks. Production omits `parent`. `parentProcess()` has no `lsof` text executable, and feeding that incomplete snapshot in would fail closed on a real RPC parent. The RPC guard reads `process.ppid` itself. An injected parent is forwarded unchanged and still has to satisfy every RPC check.

`test/token-guard-process-title.test.ts` is the macOS overwrite regression suite. A live `process.title` of `pi` or `pi-rpc` makes `ps` argv the title, with `node` absent from that command line, while the text executable stays `node`. On macOS, `ps ucomm` stays `node`. A live `pi-rpc` title whose `ucomm` is the title and whose text executable is absent is refused.

### Release install and extension drift

`node dist/cli.js release install` (`qlb release install` in `src/commands/release.ts`) installs the compiled build into `~/.qlb/app/<sha>` and atomically swaps the relative symlink `~/.qlb/app/current` onto that sha (`installRelease` / `publishCurrent` in `src/release.ts`). `qlb pi deploy` (`src/pi-deploy.ts`) refuses to run until `current` names a release that contains `extensions/qlb-pi`, `src/redact.ts`, and `src/pi-owner-document.ts`. It then publishes those bytes to `~/.pi/agent/extensions/qlb-pi` (shared sources land beside the resolved extensions directory) and records `pi.deployedAt` and `pi.extensionHash`.

`qlb doctor` checks that the installed extension still matches what was published:

- `pi:extension` (`piIntegrationChecks` in `src/pi-integration.ts`), when a QLB checkout is on disk, compares `~/.pi/agent/extensions/qlb-pi` with that checkout's `extensions/qlb-pi` plus the two shared sources. A difference is `WARN` and the recorded fix is `qlb pi deploy`.
- `pi:extension-drift` (`src/checks/pi-extension-drift.ts`) hashes the installed extension and the two shared sources and compares that digest, and the recorded `pi.extensionHash`, with the extension inside `~/.qlb/app/current`. A mismatch is `FAIL` (`installed qlb-pi deployment hash differs from the current release`). No deployment record is `WARN` (`not deployed`).

## Codex go-live stages and the stop latch

Codex multi-account switching ships dark: `CODEX_SWITCH_COMMAND_ENABLED` (`src/codex-flag.ts`) is `false`, and the switch engine (`src/codex-switch.ts`) refuses every switch. It goes live in two stages, manual switches then automatic ones, each opened by an owner marker (`qlb codex stage start`) and judged from rows qlb already keeps: `switch_log`, `relogin_events` and the per-switch watch verdict.

The rules live in one pure module, `src/codex-stage.ts`: which rows are stops, what the latch admits, and whether a stage passed. The stop sweep (`src/codex-stop.ts`) runs those rules over the evidence and records each new stop once as a `latch-set` row. A recorded stop latches qlb: every new Codex switch and every refresh qlb starts of an owned Codex token is refused with `codex-stop-latched`, while the owner's recovery commands stay admitted. A latch log that cannot be read counts as set. Only the owner clears it, through the newest stop they reviewed (`qlb codex latch clear --through`). `qlb codex stage report` reads the same rules read-only. The Lean model in `proofs/codex-stop-latch/` states the latch properties, and its replayed cases run against `src/codex-stage.ts`.

The owner's steps, including the return to dark after a stop, are [CODEX-GO-LIVE-RUNBOOK.md](CODEX-GO-LIVE-RUNBOOK.md).

## Storage

`src/store.ts` uses Node's built-in `node:sqlite` (synchronous, so a `BEGIN IMMEDIATE` transaction is a straight-line code block with no awaits). The database (default `~/.qlb/qlb.db`) runs in WAL mode with `busy_timeout` and holds:

- `accounts` — accounts discovered by adapters (plus `grant_generation` for owned grants)
- `snapshots` — the gauge cache, one row per `(account, bucket)`; among non-provider readings it is upsert-guarded by `fetched_at`, while a direct provider reading replaces a non-provider reading regardless of order
- `usage_discrepancies` — retained provider-authority records for disagreeing provider and QLB-side percentages, plus malformed direct-provider percentages; `qlb doctor` reports their aggregate
- `config` — a generic `key`/`value` table; besides round-robin and failover state it holds one **persisted per-provider observation** under the key `observed:<provider>` (`observationConfigKey()` in `src/candidates.ts`), written by `qlb resolve`, `qlb refresh --allow-probe`, and `qlb status`. Each entry carries a monotonically increasing generation counter, the fetch outcome (`ok` / `failed`), and the normalized snapshots QLB saw — including per-account bucket readings — with a per-account `failed` flag set by refresh when a probe failed (`cached-after-failure` or an error snapshot). `qlb why` reproduces a pick from exactly this record.
- `decisions` — audit of every resolve (inputs, reason, mode, per-bucket ages), with the **additive** `strategy` and `provider` columns persisted on new rows (added by `ensureDecisionColumnsOn()` in `src/store.ts` via `ALTER TABLE`; the schema stays version-neutral so `user_version` remains 4, and legacy rows fall back to derived strategy/provider)
- `poll_claims` / `leases` — the two single-flight mechanisms above
- `migrations` — the credential-ownership journal
- `policies` — virtual-model → real-model mappings for the proxy
- `codex_stage_events` — the Codex go-live log: stage starts and closes, stops (`latch-set`, one per evidence pointer), clears and initializations; the stop latch is derived from it
- `codex_watch_verdicts` — one verdict per committed Codex switch (such as `confirmed`, `reverted` or `inconclusive`), written when its watch ends
- `overrides` — pin/reserve/drain-first rows, written and managed by `qlb override pin|reserve|drain-first|clear|list`; `qlb status` displays any active row, and `resolve` honors them (pin beats any strategy, reserved accounts are excluded, drain-first accounts are tried first)

Snapshot caching is *politeness*, not correctness: a caller reuses its last observation rather than re-fetching. Direct provider readings are authoritative over QLB-derived readings, so QLB keeps the provider value when the two disagree and records the conflict for `qlb doctor`; QLB-derived values remain display/cross-check data. Routing relies only on fresh direct provider readings; it never depends on data QLB generated itself.

The `qlb-pi` Pi extension's footer (`extensions/qlb-pi/footer.ts`) is a live, read-only view into this same store — the same `accounts`/`snapshots`/`decisions`/`migrations` rows described above, just rendered in Pi's status bar instead of `qlb status`. See [README · qlb-pi footer](../README.md#qlb-pi-footer) and [CLI.md · /qlb](CLI.md#qlb-pi-in-session-command) for what it shows and how to expand it.

## The proxy

`qlb proxy` starts a loopback-only HTTP helper (`src/proxy.ts`) that harnesses such as Claude Code or Codex CLI can be pointed at instead of their provider's endpoint:

- Binds `127.0.0.1` on an OS-assigned port; refuses any non-loopback bind.
- Generates a 32-byte random token per launch, persisted mode-0600 in `~/.qlb/proxy.json`; client tokens are compared constant-time; wrong `Host` headers and non-loopback peers are rejected; auth-failure rate limiting is local.
- Per request: resolves the harness's virtual model name against the `policies` table, runs the same selection path as `qlb resolve`, injects the selected account's credential, and forwards. Unmapped models fail closed with the exact remediation command in the error body — never a silent default.
- It is an on-demand helper, not a daemon: it exits after an idle timeout with zero in-flight requests, and never exits mid-stream.

Credentials for the proxy come from the Keychain **only** when that provider's migration journal says `QLB_OWNED` (or `RETIRED`); otherwise the proxy fails closed with a "not yet owned by QLB" error rather than silently falling back to reading native credential files.

## Design provenance

The design went through six rounds of adversarial review before implementation, including one mid-design pivot that replaced the local usage-tracking subsystem with the live-query model described above. That history, and what it fixed, is recorded in [DESIGN-HISTORY.md](DESIGN-HISTORY.md).
