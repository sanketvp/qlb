# Design history

This is an honest account of how QLB's design was produced, including a decision that removed a large subsystem from the spec shortly before implementation. It is written down because two of the choices that look unusual in the final design — "QLB never counts your usage locally" and the very small commit surface of the credential cutover — only make sense with this history.

## Six rounds of adversarial review

The design went through **six spec revisions before a line of implementation was written**. The process for each round was the same: write the spec, hand it to an independent adversarial reviewer (a different model with instructions to find holes, races, and contradictions), then revise the spec against every finding and re-review. Rounds were repeated until a review came back clean rather than "needs revision."

What that process caught, in rough order of severity:

- **A backwards scoring formula.** The first version weighted the 5-hour window at 0.6 and weekly at 1.0, which *shrank* the 5-hour term in a `min()` — the opposite of the intended "weekly capacity is scarcer" behavior. The fix (multiplying the weekly headroom by 0.6 instead) is subtle enough that the spec now carries three worked numeric examples where the old formula picks the wrong account, plus a property test for the swapped-headrooms invariant.
- **Undefined semantics for missing or untrusted data.** What should a score do with a bucket that was never observed, or a gauge that can't be proven to be the billing meter? The four confidence levels (`authoritative` / `stale` / `advisory` / `unknown`) and the rule that only scored buckets can enter the `min()` came directly out of that review.
- **Concurrency holes.** Races in credential refresh (two processes refreshing the same grant), non-atomic cutovers (a crash leaving neither the native store nor QLB working), and late-arriving stale poll results overwriting fresher data each got a named mechanism and a named test, not a prose assurance.
- **An underspecified proxy.** Authentication, loopback binding, replay safety (never retry a request that may have been processed), and policy resolution from model strings were all added or sharpened by review rounds.

## The pivot: local usage tracking was removed

The biggest change was not a fix — it was a deletion.

**The original design** (spec versions 1–3) included a local usage-accounting subsystem. The idea: when QLB selected an account for a request, it would write a *reservation* — an estimate of the request's cost against that account's buckets — so that a burst of simultaneous requests would not all see the same untouched gauges and pile onto one account. Reservations would be kept alive by heartbeats, settled when requests completed, and calibrated over time against the providers' real gauges.

Across two review rounds, nearly every finding that resisted resolution traced back to that one subsystem: When does a reservation expire if the holder crashes mid-stream? What does "liveness" mean when a laptop sleeps? How is settlement made exactly-once? Each fix introduced a narrower race underneath it, and the reviewer kept — correctly — finding them.

**The decision:** the subsystem existed to handle exactly one scenario (a burst of simultaneous requests briefly piling onto one account), and the crash-safety machinery it required was disproportionate to that risk. It was removed entirely. Spec version 4 replaced it with the pure live-query model that shipped:

- QLB holds only a cache of the last *real* gauge reading per `(account, bucket)`. No expected-cost estimates, no reservations, no settlement, no heartbeats, no calibration.
- Decisions are made from the freshest real data available, with the reading's age carried alongside it.
- A burst may pile onto one account until real data lands — one round-trip later, the next poll or the next response's headers shows the consumption and scoring diverges. This tradeoff is documented as expected behavior, with the honest caveat that QLB itself enforces no bound on burst size; the practical bound is the caller's own concurrency.

The effect on the rest of the design was disproportionate to the size of the deletion: with no in-flight usage state, the store needs no keeper process, a crash cannot lose un-settled work, and the remaining concurrency problems (poll coalescing, credential refresh) are ones where a lost race merely costs a redundant network call — not ones where it corrupts capacity data.

## What shipped vs. what the spec proposed

The implementation follows the reviewed design's architecture (adapters → live-query capacity model → confidence-based scoring → resolve → SQLite store → Keychain-backed credentials with a generation-CAS-fenced refresh → loopback proxy), with the final implementation as ground truth. Known gaps are documented rather than glossed over — for example, the `overrides` table exists in the store and is displayed by `qlb status`, but no override CLI is wired yet; see the "Not yet wired" section in [CLI.md](CLI.md).

## September 8, 2026: real cutover incident — native/QLB credential drift

The day the first real production cutover happened, it found two bugs and one structural risk that six rounds of adversarial spec review and 106 mocked tests had not. This section records what happened, in the same spirit as the reservation-system story above: real use is the reviewer that never blinks, and the gaps it found are written down rather than glossed over.

**What happened.** Four Claude accounts were moved from the native `anthropic-pool` extension into QLB's Keychain-owned copies through the full `stage → rehearse → commit` flow, and the `qlb-pi` Pi extension was installed to route live traffic through QLB's owned credentials. Two bugs surfaced immediately in live traffic:

1. **`qlb-pi` was missing the request-shaping and header logic the native `anthropic-pool` transport applies.** Anthropic rejected the requests as coming from an unauthorized third-party client (HTTP 400). Nothing in the mocked test suite covered this, because every mocked test exercised QLB's own logic against simulated responses; the missing piece was behavioral parity with the native transport it replaced. Fixed by copying the exact working shaping logic from `anthropic-pool`.
2. **`qlb-pi`'s audit logging recorded failed requests as `"outcome":"ok"`** — a false positive that would have hidden bug #1 from `qlb status`. The failure mode compounding the first one is worth noting: the observability layer that should have caught the outage was itself wrong, in the direction that hides outages. Fixed so the outcome defaults to `"failed"` unless an explicit success is observed.

After fixing both and re-verifying, `qlb-pi` was rolled out across most (not all) of roughly forty live Pi sessions by respawning each session's process in place. This surfaced two further findings:

- **Three respawned sessions lost their entire tmux server**, not just their pane, due to a launch-time race on bare `pi` invocations without an explicit `--session` flag. The conversation history was safe on disk (nothing in the system deletes session files), but the live terminal panes closed and had to be reopened manually via `pi --session <path>`. Disruptive, recoverable, and only reachable by touching real running sessions.
- **One of the four managed Claude accounts began returning `401 OAuth access token has been revoked`.** Root-cause investigation through QLB's own database ruled out a QLB-side refresh race first: `grant_generation` was still 0 and the `leases` table was empty — QLB's own refresh machinery had never touched this credential. The actual cause: the native `anthropic-pool` extension was *still independently refreshing the same account* (not all ~40 sessions had been migrated to `qlb-pi`), and Anthropic's OAuth rotates the access token on every refresh — so each legitimate native refresh silently invalidated QLB's frozen Keychain copy from underneath it. QLB's fencing (generation CAS, heartbeat lease) protects QLB's processes against *each other*; it cannot protect QLB's copy against a refresher that doesn't know QLB exists. Fixed live by re-authenticating the affected account through the native tool's own login flow, then rolling QLB's ownership of that specific credential back to a clean state.

**The structural finding.** The revoked-token failure mode is not a one-off partial-rollout bug. For xai, kimi-coding, openai-codex, and openrouter, QLB uses the **shadow-retain** migration strategy: native credentials are intentionally never removed, because the underlying file or Keychain service is shared with other things or kept native-accessible by design. That means "something native refreshes the same underlying account independently and silently invalidates QLB's owned copy" is a **permanent structural property** of those four providers, not a temporary migration-window risk the way it was for Anthropic. The spec treated cutover as a one-time atomic event with a clean before/after; it did not fully anticipate a long-lived state in which both owners are live simultaneously.

A mitigation — detecting native credential drift and resyncing QLB's owned copy — was identified as necessary during this incident and was in active development as of this writing; see [CREDENTIAL-SAFETY.md](CREDENTIAL-SAFETY.md) for the user-facing guidance in the meantime.

**Lessons taken:**

- **Mocked and synthetic testing cannot substitute for real live verification when credentials and multi-process concurrency are involved.** The 106 mocked tests verified QLB's logic against QLB's model of the world; both bugs lived exactly where QLB meets the world it does not model — a real provider's client validation, and a real second refresher running in another process.
- **A partial rollout across many real concurrent processes is itself a risk category** the original spec didn't fully anticipate — both the tmux respawn race and the native/QLB double-refresh existed only in the gap between "some sessions migrated" and "all sessions migrated," a gap the spec's atomic-cutover framing implied would not exist.

## Why this matters if you're extending QLB

If you're adding a provider, a consumer, or a feature, the single most useful takeaway from this history is: **don't reintroduce local usage accounting.** It's the tempting fix for burst pile-on ("just track in-flight requests!"), and it was tried, reviewed to destruction, and removed on purpose. The documented alternatives — caller-side concurrency limits, or an optional soft admission-control setting that would need its own review round — preserve the property that makes QLB's crash story simple: every capacity input is something a provider actually said, and nothing in the store needs a keeper process to stay correct.
