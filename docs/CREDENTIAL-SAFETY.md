# Credential safety

QLB can optionally take **ownership** of your provider credentials — holding OAuth grants itself, refreshing them, and injecting them per request. That is the most useful thing it does and the most sensitive, so its rules around credentials are deliberately strict. This document explains exactly what QLB will and will not do, and what happens if it crashes at the worst possible moment.

## Where QLB stores the secrets it owns

QLB-owned grants (the `qlb:<provider>:<accountId>` items written by `qlb migrate`) live in an OS-specific backend. The public API (`keychainSet` / `keychainGet` / `keychainDelete`) is the same on every platform; only the storage changes.

| Platform | Backend | What actually protects the secret |
|---|---|---|
| macOS | Keychain via the `security` CLI | The macOS Keychain, unlocked with your login keychain. Strongest of the three. |
| Windows | DPAPI via PowerShell (`ConvertTo-SecureString` / `ConvertFrom-SecureString`), blobs in `%USERPROFILE%\.qlb\credentials-windows.json` | Data Protection API, bound to the Windows user login. Comparable in intent to Keychain: another logged-in user on the same machine cannot decrypt the blobs. |
| Linux (preferred) | `secret-tool` (libsecret / GNOME Keyring) when `secret-tool` is on `PATH` | The session keyring. Similar idea to Keychain, but only if a libsecret daemon is actually running. |
| Linux (fallback) | AES-256-GCM file at `~/.qlb/credentials-linux.json`, key in `~/.qlb/.credkey` (both mode 0600) | **Encrypted at rest, not OS-keychain-protected.** The key is a random 32-byte file created on first use. Anyone who can read both files — the same user, root, or a copied home directory — can decrypt the secrets. There is no passphrase, TPM, or login-session binding. Prefer `secret-tool` when you can install it. |

The Linux file fallback exists so QLB still runs on servers and distros without GNOME Keyring. Do not treat it as equivalent to Keychain or DPAPI. Native (non-QLB) OpenRouter keys are looked up in the same backend (macOS: Keychain service `pi-openrouter`; Linux/Windows: service `pi-openrouter`, account `qlb`). QLB never writes that native item.

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

## Native credential drift: the shadow-retain tradeoff

For the shadow-retain providers (**xai, kimi-coding, openai-codex, openrouter** — and for any provider whose migration is only partially rolled out), QLB's owned credential is a *copy* of a credential that still exists natively and may still be used by native tooling. If anything else on the machine refreshes the same underlying account independently — a native extension, another CLI, a scheduled job — the provider may rotate the access token on each refresh, and each rotation silently invalidates QLB's frozen copy. The symptom is an authentication error (for example, `401 ... token has been revoked` or `401 token expired`) on a QLB-owned account, with QLB's own refresh machinery showing no involvement.

This is a known, **structural property of sharing credentials with native tooling**, not a bug to be fully eliminated. QLB's refresh fencing (generation CAS, heartbeat lease) coordinates QLB's own processes; it cannot coordinate with a refresher that doesn't know QLB exists. The risk is mitigated, not removed:

- **Detection and auto-resync (shipped).** When an authentication failure occurs on a QLB-owned credential (for example a `401` in the proxy path), QLB compares its owned copy against the provider's current native credential — a SHA-256 fingerprint of the access token, never the token material itself. If the fingerprints **differ**, the native store refreshed independently: QLB overwrites its Keychain copy with native's current credential and retries the request **exactly once**. If the fingerprints are **identical**, the credential was genuinely revoked externally: QLB does **not** retry and surfaces the real error, because a retry would fail identically — the fix is re-authenticating the account through the **native tool's own login flow**. Each resync attempt (recovered or genuine-revocation) is written to the audit trail so the two cases stay distinguishable after the fact. The same compare-and-resync can be triggered manually at any time with `qlb native-resync --provider <p> --account <id>` (see [CLI.md](CLI.md#qlb-native-resync)).
- **`qlb doctor` surfaces drift proactively (shipped).** Doctor compares owned vs. native fingerprints for every QLB-owned account before anything fails, so drift is visible as a warning rather than discovered as an auth error:

  ```console
  $ qlb doctor
  [WARN] native-sync:acct-kimi: QLB Keychain copy DIFFERS from native for acct-kimi (kimi-coding) — native may have refreshed independently; next 401 will auto-resync
  ```

  (Account id illustrative; the message text is exactly what the code emits. A matching fingerprint prints a `[PASS]` line instead, and for rename-strategy providers like Anthropic whose native store is intentionally gone, doctor reports that no comparison is possible rather than warning.)
- **Immediate manual fallback**: re-authenticate the affected account through the **native tool's own login flow**, then bring QLB's ownership of that credential back to a clean state. The credential-safety design has always treated native re-auth as the ultimate fallback — QLB never blocks the native tool from re-authenticating its own accounts, which is exactly what makes recovery straightforward when drift bites.

If you run both QLB-owned and native consumers against the same accounts simultaneously, treat an unexpected auth error on the QLB side as a likely native drift event first, and a QLB-side refresh failure second — check `qlb status` / `qlb doctor`, and check whether a native tool refreshed the account recently.

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
| Native refresh invalidating QLB's copy (shadow-retain providers) | Structural risk of shared credentials, mitigated not eliminated; see [Native credential drift](#native-credential-drift-the-shadow-retain-tradeoff) — drift is fingerprint-detected and auto-resynced (one retry) on the next 401, surfaced proactively by `qlb doctor`, and manually triggerable via `qlb native-resync`; a fingerprint-identical (genuinely revoked) credential still requires native re-auth |
