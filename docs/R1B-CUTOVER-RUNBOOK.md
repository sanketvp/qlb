# R1b cutover runbook

Operator steps for the live QLB-owned Pi pool. Commands, flags, and exit codes below match `src/` on `main` after Gate 6 (PRs #439, #441, #442, #443, and #440). Paths use `~/` and `<uid>` (`id -u`). This page does not contain account identifiers, machine pids, or credentials.

The steady state after Gates 5, 6, and 7:

- Journal store `pi-pool` is `QLB_OWNED`, with `ownerFile` `present`, `detail.anthropicPoolExtension` `disabled`, and `piAtNextLaunch` `QLB works`.
- LaunchAgent `com.modus.qlb-auto` is bootstrapped and writes `~/.qlb/auto.log`.
- Journal store `cswap-anthropic` is `NATIVE`. LaunchAgent `com.modus.claude-pool-refresh` stays unloaded. This repository does not install that agent.

`pi-pool` ownership and cswap consume exclude each other. The rule is under Gate 7 below.

## Prerequisites and release install

- Node.js 22 or newer, on macOS for the LaunchAgent steps.
- A clean git checkout. `qlb release install` reads `HEAD` only when `git status --porcelain` is empty.
- Pi's agent directory at `~/.pi/agent/` (`anthropic-pool.json`, `auth.json`, `qlb-owner.json`).

`scripts/install.sh` builds the checkout and optionally `npm link`s it. The production binary is the release tree:

```bash
npm ci
npm run build
node dist/cli.js release install
qlb pi deploy
```

`node dist/cli.js release install` is `qlb release install [--sha <sha>]` (`src/commands/release.ts`). It copies the build to `~/.qlb/app/<sha>`, writes `release.json`, and points `~/.qlb/app/current` at that directory. A dirty worktree exits 1 with `qlb release: source tree is dirty`. A `--sha` that disagrees with the compiled build stamp exits 3.

`qlb pi deploy` (`src/commands/pi-deploy.ts`, optional `--dry-run` and `--json`) copies `extensions/qlb-pi`, `src/redact.ts`, and `src/pi-owner-document.ts` from `~/.qlb/app/current` into `~/.pi/agent/extensions/qlb-pi`. Shared sources are written beside the real extensions directory. It records `pi.deployedAt` and `pi.extensionHash`. When `qlb` is not on `PATH`, run `node ~/.qlb/app/current/dist/cli.js pi deploy`. A missing `current` tree exits 1 and tells you to run `qlb release install` first. After a deploy that matches the release, `qlb doctor` reports:

- `pi:extension` `PASS`
- `pi:extension-drift` `PASS` (`installed qlb-pi deployment hash matches the current release`)

Use the `qlb` on `PATH` when it is this release. The LaunchAgent always runs `~/.qlb/app/current/dist/cli.js`.

## Gate 5 (cutover)

Live paths under `~/.pi/agent/` require `--confirm-real-cutover`. Without it, `qlb migrate` exits 2 and prints `REFUSED: resolved native / owner path is inside ~/.pi/agent/.` Default `--provider` is `anthropic`. Default files are `~/.pi/agent/anthropic-pool.json`, `~/.pi/agent/auth.json`, and `~/.pi/agent/qlb-owner.json`.

Forward migrate exits 1 with `DUAL_OWNERSHIP_REFUSED` while `cswap-anthropic` is `CONSUMED`. `qlb consume status --provider anthropic` must print `cswap-anthropic: NATIVE` before stage.

```bash
qlb migrate stage --provider anthropic --confirm-real-cutover
qlb migrate receipt --provider anthropic --phase stage --json
qlb migrate rehearse --provider anthropic --initial-active <alias> --confirm-real-cutover
qlb migrate receipt --provider anthropic --phase rehearse --json
qlb migrate commit --provider anthropic --confirm-real-cutover
qlb migrate receipt --provider anthropic --phase commit --json
qlb migrate status --provider anthropic --json
```

`<alias>` is required on Anthropic rehearse. Aliases are `member-0001`, `member-0002`, and so on, in pool order (`memberAlias` in `src/anthropic-complete-set.ts`). The stage receipt lists them. Pass the alias whose member is the current Anthropic `active_login`. Omitting `--initial-active`, or passing any other alias, prints `qlb migrate rehearse: initial-active-invalid` and exits 3. The journal is rewritten to `MIRRORED` with `rehearseRefusal.code` `initial-active-invalid`. `--initial-active` is rejected on `stage`, `commit`, and any provider other than `anthropic`.

Each receipt exits 0 when `disposition` is `success` and exits 1 when it is `refused`. A successful rehearse receipt includes one `5h` and `7d` pair per member. Receipts print aliases. They do not print tokens or account ids.

Commit parks `~/.pi/agent/extensions/anthropic-pool` at `~/.pi/agent/extensions-disabled-by-qlb/anthropic-pool` and journals `anthropicPoolExtension: "disabled"` (`disableAnthropicPoolExtension` in `src/migration.ts`). Both directories present refuses with `anthropic-pool-dir-ambiguous` and moves nothing.

`qlb migrate status --provider anthropic` then includes these lines (it also prints `native` and `resume`):

```text
store:     pi-pool
state:     QLB_OWNED
owner:     present
pi next:   QLB works
```

The JSON fields are `store`, `state`, `ownerFile` (`present`), `piAtNextLaunch` (`QLB works`), and `detail.anthropicPoolExtension` (`disabled`).

## Gate 6 (live smoke and S30 guard)

Gate 6 is PRs [#439](https://github.com/sanketvp/qlb/pull/439), [#441](https://github.com/sanketvp/qlb/pull/441), [#442](https://github.com/sanketvp/qlb/pull/442), [#443](https://github.com/sanketvp/qlb/pull/443), and [#440](https://github.com/sanketvp/qlb/pull/440):

- #439 accepts interactive Pi after `process.title = "pi"` hides argv (`INTERACTIVE_PI_PROCESS_TITLE` in `src/commands/token.ts`). On macOS, `ps` `comm` and `command` become `pi` while `ucomm` stays `node`.
- #442 adds `src/pi-rpc-guard.ts`. `piRpcCallAllowed` accepts a parent titled `pi-rpc` only when `QLB_PI_TOKEN_CALL` is `1`, stdio is not a TTY, and the kernel comm, Node text executable, Pi env signals, and an RPC entry under the located Pi package agree.
- #443 calls `piRpcCallAllowed` from `tokenCallAllowed` before the interactive-title checks.
- #441 keeps `token-call-refused` on the fixed cause list in `extensions/qlb-pi/active-access.ts`, so the extension shows that cause instead of `unknown`.
- #440 is the macOS `process.title` regression suite, `test/token-guard-process-title.test.ts`.

`gate` is admitted in lifecycle phases `cutting-over`, `cutover`, and `retired` (`src/lifecycle.ts`). Another phase exits 3 first, with stderr `qlb gate: refused: …`, and never reaches the token guard.

### Live smoke

Start one Anthropic Pi turn with smoke mode set:

```bash
QLB_PI_OWNED_SMOKE=1 pi
```

The extension (`extensions/qlb-pi/index.ts`) then calls `qlb gate anthropic --json --no-refresh` with `QLB_PI_TOKEN_CALL=1`. `ownedSmokeResync` in `extensions/qlb-pi/auth-retry.ts` returns `owned-smoke-no-retry`, so a 401 does not open a second gate read.

Confirm the smoke receipt and the outcome log:

```bash
qlb migrate receipt --provider anthropic --phase smoke --json
```

Exit 0 when `disposition` is `success`. A success object has `phase` `smoke`, `servedAlias`, `matchesInitialActive`, and `servedAfterCommit: true` while the journal state is `QLB_OWNED`. Exit 1 when `disposition` is `refused`. The served account id is used for matching and is not printed.

`~/.qlb/outcomes.jsonl` (mode 0600) gains one JSON object per owned turn: `ts`, `accountId`, `model`, and `outcome`, plus `error` when the turn failed (`recordOutcome` in `extensions/qlb-pi/index.ts`). `after_provider_response` lines add `kind`, `provider`, and `status`. The file is an audit log. It does not store tokens.

### S30 negative shell check

A shell is not Pi, so the same env var must be refused. From a normal shell:

```bash
stdout=$(mktemp)
stderr=$(mktemp)
set +e
QLB_PI_TOKEN_CALL=1 qlb gate anthropic --json --no-refresh >"$stdout" 2>"$stderr"
code=$?
set -e
test "$code" -eq 3
test ! -s "$stdout"
grep -qx 'token-call-refused' "$stderr"
rm -f "$stdout" "$stderr"
```

`tokenCallAllowed` returns false when stdio is a TTY or the parent is not Pi (`src/commands/token.ts`). `runPiGate` (`src/pi-gate.ts`) writes `token-call-refused` to stderr and returns 3 before it opens the store or reads a credential. `--json` is accepted and does not change that refusal. `--no-refresh` is valid only for `anthropic`. Stdout stays empty because `deliverSecret` runs only after the guard passes. The stderr line is the fixed cause code, so the check prints no secret.

## Gate 7 (`com.modus.qlb-auto` activation)

Run this only after Gate 5 shows `pi-pool` `QLB_OWNED` and `cswap-anthropic` `NATIVE`.

```bash
qlb auto install-agent
launchctl bootstrap gui/<uid> ~/Library/LaunchAgents/com.modus.qlb-auto.plist
```

`qlb auto install-agent` (`src/commands/auto.ts`) writes `~/Library/LaunchAgents/com.modus.qlb-auto.plist` (mode 0600). `ProgramArguments` are the current Node, `~/.qlb/app/current/dist/cli.js`, and `auto`. `StandardOutPath` and `StandardErrorPath` are both `~/.qlb/auto.log`. The label is `com.modus.qlb-auto`. `RunAtLoad` is true and `ThrottleInterval` is 60, matching the agent's 60-second loop (`INTERVAL_MS` in `src/auto.ts`).

Confirm the agent:

- `~/.qlb/auto.log` grows with lines `auto: stay(…)`, `auto: switch(…)`, or `auto: parked(…)`.
- In lifecycle phase `cutover` or `retired`, `qlb doctor` includes `[PASS] auto:agent: automatic agent heartbeat is current`. The check reads config key `auto.heartbeatAt`. It fails when that value is missing, more than 60 seconds in the future, or older than 5 minutes (`src/checks/auto-agent.ts`).
- `qlb consume status --provider anthropic` prints `cswap-anthropic: NATIVE`.
- `qlb doctor` exits 0. Exit 1 means overall is `FAIL` (`src/app.ts`). `WARN` still exits 0.

### `cswap-anthropic` stays `NATIVE`

`qlb consume enable --provider anthropic` while `pi-pool` is `MIRRORED`, `VALIDATED`, `QLB_OWNED`, or `RETIRED`, or while `~/.pi/agent/qlb-owner.json` claims Anthropic, exits 1. Stderr is:

```text
qlb consume enable: DUAL_OWNERSHIP_REFUSED — Pi's Anthropic accounts are QLB-owned (pi-pool QLB_OWNED). Roll back with `qlb migrate rollback --provider anthropic` first.
```

The journal is left unchanged. `decidePiMode` (`extensions/qlb-pi/consume.ts`) returns `owned` only when the owner file claims QLB and the consume journal is `NATIVE`. `CONSUMED`, or an unreadable journal, with that owner file returns `conflict`. Pi then registers an error-only Anthropic provider (`CONSUME_ERRORS.conflict`).

Leave `com.modus.claude-pool-refresh` unloaded for the same reason: cswap must not refresh Claude pool credentials beside a QLB-owned Pi pool.

`qlb consume` requires `--provider anthropic`. `status` with no row prints `cswap-anthropic: NATIVE`. `--json` prints `{"provider":"anthropic","store":"cswap-anthropic","state":"NATIVE"}`.

## Post-cutover `qlb doctor`

```bash
qlb doctor
```

Exit 0 when `Overall` is `PASS` or `WARN`. Exit 1 when `Overall` is `FAIL`. Default doctor does not call providers; `--live` opts into network reads.

Expect these after the steps above:

| Check | Expected |
|---|---|
| `pi:extension` | `PASS` when doctor can see this checkout and the deployed files match it |
| `pi:extension-drift` | `PASS` when the installed hash matches `~/.qlb/app/current` |
| `auto:agent` | `PASS` once `com.modus.qlb-auto` has written a fresh `auto.heartbeatAt` in phase `cutover` |
| `native-sync:<account>` | May be `WARN` until the follow-up below lands |

`native-sync` is `inspectOwnedNativeDrift` (`src/native-resync.ts`), called from `src/diagnostics.ts`. It selects every `accounts` row whose provider store is `QLB_OWNED` or `RETIRED`. Anthropic's store name is `pi-pool`, so an owned pool also compares Claude Code switching accounts and historical Anthropic rows. A missing owned or native read is reported as unreadable (`QLB Keychain copy unreadable`, or `native credential unreadable` for shadow-retain providers). A separate change, still in progress, will limit that scan to owned `pi-pool` members and will report a missing Keychain label separately from an unreadable one. That change does not delete database rows or credentials. A `WARN` on `native-sync:*` does not by itself make `qlb doctor` exit 1.

## Rollback

Stop the switching agent before hand-back so a tick cannot run during restore. `<uid>` is `id -u`:

```bash
launchctl bootout gui/<uid>/com.modus.qlb-auto
qlb migrate rollback --provider anthropic --confirm-real-cutover
```

`launchctl bootout gui/<uid>/com.modus.qlb-auto` is the command in `src/commands/auto.ts` and `src/commands/undo-cswap.ts`. A job that is already gone makes `launchctl` exit 3; `qlb auto drill-begin` treats that status as stopped.

`qlb migrate rollback` on the live `~/.pi/agent/` files needs `--confirm-real-cutover` (exit 2 without it). `status` and `rollback` still run while consume is enabled. `stage`, `rehearse`, `commit`, and `resume` do not.

Post-commit rollback (`continueRollback` in `src/migration.ts`):

1. Restores `~/.pi/agent/anthropic-pool.json` from `anthropic-pool.json.pre-qlb` when the native file is absent and the `.pre-qlb` file exists.
2. Moves `extensions-disabled-by-qlb/anthropic-pool` back to `extensions/anthropic-pool` when commit had parked it there (`restoreAnthropicPoolExtension`). Both directories present refuses with `anthropic-pool-dir-ambiguous`.
3. Removes the Anthropic owner claim, then journals `VALIDATED` with `rolledBackFrom` `post-commit`.
4. With the owner file absent and the native pool file present, `piAtNextLaunch` is `native works`.

A crash after rollback intent is journaled resumes with:

```bash
qlb migrate resume --provider anthropic --confirm-real-cutover
```

`resume` continues a rollback that already has `intent` `rollback`. It does not start one.

Pre-commit rollback (journal still `MIRRORED`, owner file only at `qlb-owner.json.staging`) deletes the staging Keychain copies and the staging file, journals `NATIVE` with `rolledBackFrom` `pre-commit`, and leaves the native pool file in place.

Confirm:

```bash
qlb migrate status --provider anthropic
qlb consume status --provider anthropic
```

Expect `owner` `absent`, `pi next` `native works`, and `cswap-anthropic: NATIVE`.
