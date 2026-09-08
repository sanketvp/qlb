# Credential safety

QLB can optionally take **ownership** of your provider credentials — holding OAuth grants itself, refreshing them, and injecting them per request. That is the most useful thing it does and the most sensitive, so its rules around credentials are deliberately strict. This document explains exactly what QLB will and will not do, and what happens if it crashes at the worst possible moment.

## The default is read-only

Out of the box, QLB never modifies a credential. The provider adapters *discover* credential sources — a pool JSON file, an `auth.json` entry, a Keychain service — and read them to fetch usage numbers. They do not write, move, rename, or refresh anything. If a grant is expired, QLB reports the account as needing re-login rather than trying to refresh a grant it doesn't own.

Ownership only ever changes through the explicit `qlb migrate` flow, and every mutating step is gated.

## The gates

1. **Explicit confirmation for real cutovers.** Any `qlb migrate stage|rehearse|commit|rollback|resume` that resolves to your real credential files is refused with exit code 2 unless you also pass `--confirm-real-cutover`:

   ```console
   $ qlb migrate stage
   REFUSED: resolved native / owner path is inside ~/.pi/agent/.
   This would perform a REAL Pi credential cutover.
   Pass --pool-file / --auth-json and --owner-file pointing at a temp copy,
   or pass --confirm-real-cutover if you truly intend to cut over live Pi.
   ```

   Tests and dry runs point the same commands at temp copies via `--pool-file` / `--auth-json` / `--owner-file` (or `--target-dir`) — the flag is not needed and not honored implicitly.

2. **A rehearsal before any real cutover.** The sequence is `stage → rehearse → commit`. Staging copies credentials into QLB's Keychain *in addition to* your native store (nothing native is touched) and writes a staging owner file that no consumer reads. Rehearsal makes a live authenticated call per account through the new path — **without refreshing anything** — and aborts with the native store untouched if any account fails. Only after a passing rehearsal does `commit` flip the switch.

3. **One atomic commit point.** "Who owns the credentials?" is decided by the existence of a single small owner file. The commit is an atomic rename of `qlb-owner.json.staging → qlb-owner.json` — a POSIX operation that either fully happens or does not happen. Everything before it is reversible staging; everything after it is idempotent cleanup (renaming the native store to `.pre-qlb`, writing sidecar metadata) that can be safely re-run by `qlb migrate resume`.

4. **A documented rollback path.** `qlb migrate rollback` restores a working native setup from QLB's *current* grants (not from a stale backup — see below), verifies them, renames the native files back into place, and only then removes the owner file. `qlb migrate resume` converges from any interrupted state in either direction.

## The crash-safety guarantee

The migration state machine (`src/migration.ts`) enumerates eleven crash points — seven on the way in, four on the way back — and proves the same invariant at each one: **a crash at any point resolves to "the native store still works" or "QLB works," never neither.** The mechanism is ordering, not luck:

- The native store is renamed to `.pre-qlb` only *strictly after* the owner-file commit. So there is no crash point where the owner file is absent (native harness inactive) *and* the native store has been renamed away.
- Rollback restores the native store *strictly before* unlinking the owner file. Same invariant in reverse.
- A crash mid-rehearsal or mid-staging leaves only a `.staging` file, which consumers ignore; `resume` cleans it up and the native store was never touched.
- A crash right after the commit leaves the owner file present and the native store merely unused — QLB works; `resume` finishes the bookkeeping idempotently.

`qlb migrate status` reports this state honestly — `state`, `ownerFile` (`absent`/`staging`/`present`), `nativeStore` (`intact`/`pre-qlb`/`both`/`missing`), and `piAtNextLaunch` (`native works` / `QLB works`) — so you can always see where you are before doing anything.

## Shared files are shadow-retained, not moved

Providers differ in how their credentials are stored, and QLB adapts rather than forcing one shape:

- **Anthropic pool file** (a dedicated multi-account file): QLB-owned on commit, and the native file is renamed to `.pre-qlb` as cleanup.
- **Shared `auth.json` entries** (xai, kimi-coding, openai-codex live as keys in one file used by other providers too): QLB **never deletes or renames that shared file**. The native entry is shadow-retained on disk; ownership is recorded in a per-provider owner file and the migration journal, and QLB's consumers prefer the Keychain copy for that provider.
- **OpenRouter's static API key**: lives in your Keychain under its original service name. QLB reads it and never writes that service at all.

## Concurrent refreshes: fenced, not hopeful

Once QLB owns a grant, several processes may need to refresh it at once (a token is single-use under rotation, so only one refresher may talk to the provider). Two mechanisms protect this (`src/refresh-lease.ts`):

- **Generation CAS (correctness).** Every grant has a monotonically increasing generation number, journaled in SQLite *and* stored inside the Keychain payload itself. A refreshed grant is written only if a compare-and-swap on the generation succeeds inside the same SQLite transaction that writes the Keychain. A refresher that was frozen mid-flight comes back to find the generation moved and discards its result — it can never overwrite a newer grant with an older one.
- **Heartbeat lease (de-duplication only).** A bounded, heartbeat-renewed lease stops N processes from each making the same refresh call. Losing the lease aborts the in-flight HTTP call. If the lease mechanism itself fails, correctness is unaffected — the CAS catches it.

Every crash point in the refresh protocol has a named resolution: crash before the refresh call (lease lapses, next caller takes over), crash after the provider consumed a rotated token but before persisting (surfaced loudly as `auth_revoked` — re-login required, a residual window of roughly one HTTP round-trip that is documented rather than hidden), crash after the Keychain write but before commit (repaired automatically on next read: the Keychain is ahead of the journal, and the journal catches up without another network call), crash after commit (done).

## Proxies fail closed, too

The loopback proxy injects a credential per request — but only for providers whose migration journal says `QLB_OWNED` (or `RETIRED`). For anything else it returns a clear "not yet owned by QLB" error instead of silently falling back to reading native credential files. The proxy itself is loopback-only, token-authenticated, and its token is never written to the database.

## Retiring a native store comes last

Even after QLB owns your credentials, the original native stores for harnesses like Claude Code or Codex CLI are left in place until a production soak gate passes: `qlb retire status` checks for `QLB_OWNED` state, at least 7 days since commit, and at least 20 clean decisions with zero auth errors — and `qlb retire execute` additionally demands `--confirm-real-retirement`. Until then, "turn QLB off" is just "stop pointing the harness at it," and the native credentials work exactly as before.

## Summary

| Concern | Mechanism |
|---|---|
| Accidental credential changes | Adapters are read-only by construction; ownership only via `qlb migrate` |
| Real cutovers | Refused without `--confirm-real-cutover` (exit 2) |
| Trying before committing | `stage` (reversible) → `rehearse` (live proof, no refresh) → `commit` |
| Crash during cutover | Single atomic rename as commit point; 11 enumerated crash points each resolve to "native works" or "QLB works"; `resume` converges |
| Changing your mind | `rollback` restores native from current grants, verified, before the owner file is removed |
| Concurrent refreshes | Generation CAS inside the write transaction; heartbeat lease for de-duplication only |
| Stale backups | Never trusted: rollback re-exports QLB's *current* grants; backups are used only with a fingerprint proving they were never rotated |
| Proxy credential access | Fails closed unless the journal says `QLB_OWNED`/`RETIRED` |
| Native store removal | Last step, gated on a 7-day / 20-clean-decision soak plus an explicit flag |
