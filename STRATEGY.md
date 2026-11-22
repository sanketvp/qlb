# qlb Strategy

## Vision

<!-- vision: author-approved 2026-11-22 -->

`qlb` exists so that one person with several AI provider accounts never has to babysit which login is about to hit its limit, and their work never stops because one account ran out.
It serves a single operator on the machines they run, from a laptop to a Linux VPS, and it turns that operator's existing logins into one pool per provider that picks the account with the most real headroom for every request.
It owns exactly one thing: the decision of which of the operator's own accounts serves the next request, and the custody of the credentials that decision needs.

### The provider is the authority on quota

A routing decision rests on a fresh, direct provider reading: a provider poll or provider response headers, at most five minutes old.
Cached, imported, derived, plugin, or failed-probe values may be shown and cross-checked, but they never select an account or declare one exhausted.
The one exception is a provider that publishes only advisory limits, today Grok: its own advisory headers may route, labelled as advisory, until it offers exact usage.
When provider and QLB numbers disagree, the provider number wins and the disagreement is recorded for `qlb doctor`.
When no fresh reading exists, the answer is UNAVAILABLE, not a guess.
QLB does not keep usage ledgers, cost estimates, or reservations that need settling.
A short-lived burst tally may spread simultaneous requests across accounts, but it never declares capacity or exhaustion, is discarded on restart, and ships only once it is proven not to break on crash, sleep, or concurrency.
QLB may report past usage from the provider readings it already stores, labelled as sampled readings, never as billing.

### Credentials are borrowed before they are owned

The default is read-only: QLB discovers and reads credential sources and changes nothing.
Taking ownership of a credential is an explicit, staged act: stage, rehearse, commit, with a confirmation flag for real files and a documented rollback and resume.
Every crash point in a cutover resolves to "native still works" or "QLB works", never neither.
Exactly one process refreshes a given grant; QLB never runs a second refresher beside a native one, because rotating tokens punish that with a 401.
Shared credential files are shadow-retained, never deleted or renamed, and native re-login is always the last-resort fallback that QLB never blocks.
A provider add-on may manage logins only after it meets the same bar as built-in code: the same staged flow, the same tests, and the same proofs.

### Fail closed on credentials, fail open on observation

Any path that hands out or injects a credential refuses unless ownership, identity, and caller are proven, and it refuses with a fixed cause code and empty stdout.
Unknown, unreadable, or malformed state is treated as a refusal, never as permission.
Observability defaults to failure: an outcome is "failed" until success is actually observed.
Read-only surfaces degrade instead of crashing: one broken provider, plugin, or harness integration never takes down status, why, or export.
No secret ever reaches stdout, stderr, a log, an event, or a persisted row; all output passes one shared redaction boundary.

### Work keeps moving, and the operator always knows how

When the requested provider has no account with headroom, QLB may switch the request to another provider or model so the work does not stop.
That switch is never silent: the operator sees that it happened and that it happened because no headroom was left.
Request shaping keeps parity with each provider's official client so routed traffic is accepted; that parity is part of the job, not an optional extra.
QLB switches accounts by itself, so advisory displays in a harness are added when operators ask for them, not ahead of demand.

### Proven, then shipped, then shipped live

A behaviour change starts with a failing test, and a characterization test names the mutation that would break it.
Every change that adds or changes stateful logic (a lifecycle, lease, journal, switch, or cutover) is modelled as an explicit state machine, proved in Lean, and tied to the code by a differential check before it merges.
Plans and slices go through adversarial review by other models until no HIGH or BLOCKER remains, and accepted residual risks are written down, not hidden.
Mocked tests are necessary but not sufficient: credential and multi-process behaviour is validated live, in gated stages, and what live use finds is recorded in the design history.
New switching paths ship dark, behind a disabled flag or an unpassed gate, until their live stage is reached.
One slice per pull request, and the owner merges.

### Scope

QLB is not a hosted service, a team account-sharing tool, or a way to pool other people's logins.
It is not a billing or cost-accounting system.
It is not a harness: Pi, Claude Code, Codex CLI, and shell runners integrate through small, opt-in, fail-open adapters, and `qlb setup` prints snippets instead of editing files outside the repo.
macOS and Linux are first-class platforms; Windows support is not a priority and is kept only where it costs little.
Coding agents may run QLB's read-only commands (status, why, doctor, export) on the live machine, but anything that writes live state (release install, deploy, migrate, switch, gate, token, Keychain, LaunchAgents) needs the owner's approval of that exact run.

A change aligns when it keeps the operator's work moving on the headroom they already have, decides from fresh provider readings, tells the operator whenever it switches provider or model, keeps every crash point recoverable to a working login, and arrives as one tested, proven, reviewed slice.
A change should be resisted when it lets a non-provider number declare capacity, adds a ledger or reservation that must settle, introduces a second refresher or an unproven credential writer, switches provider silently, turns an unknown into a permission, leaks a secret into any output, or widens QLB beyond one operator's own accounts.

## Purpose

People who pay for several AI accounts keep hitting one account's limit in the middle of work and have to switch logins by hand. The hard part is knowing which account really has room: every provider reports usage differently, the numbers go stale within minutes, and switching the wrong way can break a login that was working.

## Positioning

qlb switches accounts only on fresh, direct provider readings and never takes over a credential it hasn't proven it can hand back, so switching never rests on a guess and never leaves you without a working login.

## Users

**Primary:** Any developer with two or more AI subscriptions - they're hiring qlb to keep working when one account hits its limit, without tracking usage or switching logins by hand. qlb works for them out of the box in read-only mode on the logins they already have; the staged takeover of a login is an opt-in step for those who want it.

## Boundaries

- Team or shared account pools.
- Windows parity with macOS and Linux.
- Billing or cost accounting.
- Harness add-ons (like a Claude Code status hook) before operators ask for them.

_Resist a change when:_ it breaks a rule in the Vision section.

## Key metrics

- **Work stopped by quota** - requests per week where no account and no allowed fallback had room; should trend to zero. Measured from `decisions` rows whose `snapshot_json` error is `EXHAUSTED`.
- **Forced re-logins** - times per week the operator logged in by hand. Measured from `relogin_events` rows (kinds such as `identity-replaced` and `wiped`).
- **Fresh-reading coverage** - share of routing decisions made on a provider reading at most 5 minutes old. Measured from `decisions.snapshot_json` (`UNAVAILABLE` errors and each bucket's `ageMs`).

## Tracks

### Back-fill Lean proofs

Model the state machines that already ship (cutover and switch journals, leases, lifecycles) in Lean and tie each one to the code with a differential check.

_Why it serves the approach:_ the Vision now requires a proof for every stateful change, and "proven it can hand back" is only true once the existing machines are proven too.

### Codex multi-account switching goes live

Take Codex multi-account switching from shipped-dark to live through its gated stages.

_Why it serves the approach:_ it brings fresh-reading routing and safe custody to the second provider the operator works in every day.

### Visible cross-provider fallback

When no account of the requested provider has room, an opt-in switch to another provider or model that the operator always sees.

_Why it serves the approach:_ work keeps moving without a silent switch or a guess.

### Linux VPS as a first-class home

Credential custody and routing on a Linux VPS to the same standard as macOS.

_Why it serves the approach:_ the Vision names Linux first-class, and the operator's work runs there as well as on the laptop.

## Brand

**One-liner:** Never babysit your AI logins again.
