# Architecture

## What QLB is

QLB (Quota Load Balancer) is a local command-line tool for people who use more than one AI coding account or provider. Each provider enforces several independent limits at once — a short rolling window (typically 5 hours), a weekly window, and sometimes per-model-family pools — and each account hits its own ceilings independently. Without a cross-provider view, a session can stall on "one model family exhausted" while the same account still has weekly headroom, or while another account of the same provider is barely touched.

QLB gives one answer to the question *"which account should serve this request?"* It reads real, live usage gauges from each provider, scores every eligible account by remaining headroom, and can additionally act as a loopback proxy that selects the account and injects the right credential per request. It is a single-machine tool: a TypeScript CLI plus library, backed by a local SQLite database. It ships with five provider adapters and can load additional providers as local JavaScript plugins (see [plugins.md](plugins.md)).

## The core pipeline

```
 provider adapters          SQLite store               selection
┌───────────────────┐   ┌────────────────────┐   ┌──────────────────────┐
│ anthropic  (poll) │   │ accounts           │   │ scoring (Rule S)     │
│ kimi-coding(poll) │──▶│ snapshots (cache)  │──▶│ headroom → all-in    │
│ xai      (headers)│   │ decisions (audit)  │   │  → fallback walk     │
│ openai-codex(hdrs)│   │ poll_claims        │   │  → EXHAUSTED         │
│ openrouter (poll) │   │ leases/migrations  │   └──────────┬───────────┘
│ + ~/.qlb/plugins  │   │ policies/overrides │              │
└───────────────────┘   └────────────────────┘   ┌──────────▼───────────┐
                                                 │ consumers:           │
         credentials ────────────────────────▶   │  qlb resolve (CLI)   │
         macOS Keychain (grants, CAS-fenced      │  qlb proxy (loopback │
         refresh lease)                          │   HTTP for harnesses)│
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

Each adapter returns `AccountSnapshot`s containing named **buckets** (`5h`, `7d`, `7d:Fable`, `weekly`, `primary`, `tokens`, `credits`, …). Every bucket reading carries a `confidence` level and a `fetchedAt` timestamp, and those two fields drive everything downstream.

## Live-query only: why QLB does not count your usage

QLB never meters usage locally. It holds no request counters, no cost estimates, and no reservations. The only capacity data it keeps is a **cache of the last real gauge reading per `(account, bucket)`** — from a usage GET endpoint (Anthropic, Kimi, OpenRouter), from response headers of a request that actually went through (Codex, xAI), and nothing else.

This was a deliberate simplification, made after an earlier design (local usage self-accounting plus a reservation/heartbeat system to handle request bursts) could not be made crash-safe across two review rounds. The details are in [DESIGN-HISTORY.md](DESIGN-HISTORY.md); the short version:

- **Providers already meter usage.** Duplicating that metering locally means guessing request costs, tracking in-flight work, and reconciling estimates against gauges — every one of those is a place where a crash or a lag produces silently wrong decisions.
- **Gauge lag is bounded and self-correcting.** A burst of simultaneous requests may briefly pile onto the currently-best account, because no decision's own effect shows up in a gauge until the provider reports it. The pile-on lasts exactly one round-trip of real data: the next poll (or the first response's headers) sees the consumption and scoring diverges again.
- **What's lost is bounded by the caller, not QLB.** QLB enforces no concurrency limit; the practical bound is the caller's own concurrency. This is stated rather than hidden.

The consequence in code: a `resolve` has no side effect on capacity data other than possibly *reading* a fresh gauge. The only thing it writes is an audit row in `decisions`.

## Confidence levels

Every bucket reading carries one of four confidence levels (`src/types.ts`):

| Level | Meaning | Role in scoring |
|---|---|---|
| `authoritative` | Value came from the provider's own gauge and is the freshest observation | Scored at full weight |
| `stale` | An authoritative value that has aged past its freshness bound | Scored at half weight (`STALE_DISCOUNT = 0.5`) |
| `advisory` | Provider gauge exists but is unproven to be the billing meter (all xAI buckets today) | Never scored; tie-breaker only |
| `unknown` | Never observed | Gates candidacy only; cannot exclude an account |

The xAI case is the concrete example of why `advisory` exists: xAI's rate-limit headers describe a refilling developer-API bucket with no reset timestamp, and there is no evidence it matches the in-app meter a user actually sees. QLB displays those numbers (`~NN%`) but never lets them exclude an account — a reactive `429` from the provider is the authoritative signal there.

## Scoring: headroom-then-all-in

Selection is a min-of-headrooms rule ("Rule S" in the design spec), implemented in `src/scoring.ts`:

```
score = min over scored buckets b of ( discount_b × headroom_b × f_b )

headroom_b = ceiling − usedPct_b            ceiling defaults to 80
discount_b = 1.0 (5-hour-class buckets)
           = 0.6 (weekly-class buckets)     WEEKLY_SCARCITY
f_b        = 1.0 (authoritative) | 0.5 (stale)
score      = UNKNOWN_SCORE (1) when no bucket is scored
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
| G | authoritative, 50 used → 30 | stale, 40 used → 40 | unknown | min(1.0×30, 0.6×40×0.5=12) | **12** |
| H | authoritative, 60 → 20 | authoritative, 30 → 50 | authoritative, 45 → 35 | min(20, 30, 21) | **20** |
| I | unknown | unknown | advisory ~40% | nothing scored | **1** (unknown account) |

H wins (20 > 12). G's stale weekly bucket is neither ignored nor disqualifying — it is scored at half its discounted headroom. G's unknown pool bucket neither helps nor hurts. I is only a candidate when no other account scores above `UNKNOWN_SCORE` (1), so a cold-start account still gets tried, last.

Selection then proceeds in a fixed ladder (`src/resolve.ts`):

1. Score at ceiling 80. Any candidate with `score > 0` wins (ties: advisory headroom, then least-recently-decided).
2. None → **all-in mode**: recompute at ceiling 100, pick the max. Logged as `mode: "all-in"`.
3. Still none → walk the caller's fallback list (`--fallback m1,m2`), repeating per model. The served model is always reported (`servedModel` vs `requestedModel`); effort is never silently downgraded.
4. Still none → `EXHAUSTED` with the earliest known reset across all candidates and buckets.

Every decision is persisted to the `decisions` table with a per-bucket `snapshot_json` (value, confidence, source, `ageMs`) so any past decision can be audited after the fact.

## Single-flight poll coalescing

Without coordination, N processes that notice the same stale cache at the same instant would each fire their own usage GET. QLB coalesces them with a TTL-only claim (`poll_claims` table, `src/single-flight.ts`):

1. Read the cache. If a reading newer than the one you last saw is present, use it — no network call (the common path).
2. Otherwise, take a short claim row inside one `BEGIN IMMEDIATE` transaction. Losers of the race wait (bounded by the claim's TTL) for the winner's result to appear.
3. The winner fetches *outside* any transaction and writes results back only if its claim is still current at write time ("Rule W": a slow holder whose claim expired or was taken over has its late response silently discarded, so a takeover's fresher read always wins).
4. If a holder crashes, nothing is corrupted: the claim simply expires after its TTL and the next process takes over. A lost cache refresh costs one GET to redo — which is exactly why this mechanism deliberately uses a plain TTL claim rather than the heartbeat-and-generation fencing that credential refreshes need (see below).

The same claim coalesces N concurrent callers *inside one process* as well: the holder id is per-operation (`processUuid:opId`), not per-process, so two async callers in one process cannot mistake each other's live claim for their own.

## Credential ownership and the fenced refresh

When a user opts in (always via an explicit migration flow), QLB takes ownership of OAuth grants: each grant lives as a JSON payload in a macOS Keychain item (`service qlb:<provider>:<accountId>`), and the journal in SQLite records a monotonically increasing `grant_generation` per account.

Two mechanisms with two distinct jobs protect concurrent refreshes (`src/refresh-lease.ts`):

- **The generation is the correctness mechanism.** Every write of a refreshed grant is a compare-and-swap on `grant_generation`, evaluated *inside* the same SQLite `BEGIN IMMEDIATE` transaction that performs the Keychain write. The generation number also travels inside the Keychain payload itself, so the write can be verified against it. A refresh computed from generation `g0` can never land after another process committed `g1` — the CAS fails and the stale result is discarded.
- **The lease is only de-duplication.** A bounded (15 s) heartbeat-renewed lease prevents N processes from each making the same refresh HTTP call. Losing it aborts the in-flight call via `AbortController`. Correctness never depends on the lease.

The crash analysis is explicit (C1–C4 in `refresh-lease.ts`): every crash point resolves to either "the old grant still works" or "the new grant is committed and readable" — the single genuinely unrecoverable window (crash after the provider consumed a rotated refresh token but before it was persisted, roughly one HTTP round-trip) is documented and surfaces loudly as an `auth_revoked` state requiring re-login, never as a silent wrong decision.

Reads are lock-free and fast-path: if the cached grant doesn't expire within 60 s, no lock is taken at all.

## Storage

`src/store.ts` uses Node's built-in `node:sqlite` (synchronous, so a `BEGIN IMMEDIATE` transaction is a straight-line code block with no awaits). The database (default `~/.qlb/qlb.db`) runs in WAL mode with `busy_timeout` and holds:

- `accounts` — accounts discovered by adapters (plus `grant_generation` for owned grants)
- `snapshots` — the gauge cache, one row per `(account, bucket)`, upsert-guarded by `fetched_at` so a late-landing older reading never overwrites a newer one
- `decisions` — audit of every resolve (inputs, reason, mode, per-bucket ages)
- `poll_claims` / `leases` — the two single-flight mechanisms above
- `migrations` — the credential-ownership journal
- `policies` — virtual-model → real-model mappings for the proxy
- `overrides` — pin/reserve/drain-first rows (the table exists; **no override CLI is wired yet** — status shows `override=none` unless a row was inserted manually)

Snapshot caching is *politeness*, not correctness: a caller reuses its last observation rather than re-fetching, and any newer reading from any source replaces it. No decisions ever depend on data QLB generated itself.

## The proxy

`qlb proxy` starts a loopback-only HTTP helper (`src/proxy.ts`) that harnesses such as Claude Code or Codex CLI can be pointed at instead of their provider's endpoint:

- Binds `127.0.0.1` on an OS-assigned port; refuses any non-loopback bind.
- Generates a 32-byte random token per launch, persisted mode-0600 in `~/.qlb/proxy.json`; client tokens are compared constant-time; wrong `Host` headers and non-loopback peers are rejected; auth-failure rate limiting is local.
- Per request: resolves the harness's virtual model name against the `policies` table, runs the same selection path as `qlb resolve`, injects the selected account's credential, and forwards. Unmapped models fail closed with the exact remediation command in the error body — never a silent default.
- It is an on-demand helper, not a daemon: it exits after an idle timeout with zero in-flight requests, and never exits mid-stream.

Credentials for the proxy come from the Keychain **only** when that provider's migration journal says `QLB_OWNED` (or `RETIRED`); otherwise the proxy fails closed with a "not yet owned by QLB" error rather than silently falling back to reading native credential files.

## Design provenance

The design went through six rounds of adversarial review before implementation, including one mid-design pivot that replaced the local usage-tracking subsystem with the live-query model described above. That history, and what it fixed, is recorded in [DESIGN-HISTORY.md](DESIGN-HISTORY.md).
