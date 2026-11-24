# Codex go-live runbook

Owner steps for taking Codex multi-account switching from dark to live in two stages, and for returning to dark when a stage stops. Commands, flags and refusal codes match `src/` on `main`; `docs/CLI.md` has the full reference for each command. Paths use `~/`. This page contains no account identifiers or credentials.

Every `qlb` command below changes or reads the owner's live store (`~/.qlb/qlb.db`). Run them on the owner's machine only, never from an agent session. `test/codex-go-live-runbook.test.ts` runs them against latched test homes.

## How the stages work

- **Dark** is the shipped state: `CODEX_SWITCH_COMMAND_ENABLED` in `src/codex-flag.ts` is `false`, and every Codex switch, manual or automatic, is refused.
- **Stage 1** is manual switches only. It starts with a PR that flips the flag to `true`, the owner's install of that build, and a `qlb codex stage start --stage 1`.
- **Stage 2** adds automatic switches by `qlb-auto`. It starts once the report shows Stage 1 as `PASS`.

The stage markers are admitted only in the `cutover` lifecycle phase. Today no stage can start yet: the `auto-tick-wired` and `l13-receipt` preconditions fail for both stages, and `decide-and-switch-tick` fails for Stage 2, because the Codex automatic tick (`src/auto/openai-codex.ts`) is not wired into `qlb auto` and no build writes the L13 receipt. `qlb codex stage report` lists each precondition as `PASS` or `FAIL`.
- **Live** follows when the report shows Stage 2 as `PASS` and the owner closes the stage.

A stop during either stage sets the stop latch. While it is set, qlb refuses every new Codex switch and every refresh qlb starts of an owned Codex token. The answer to a stop is always the same: go back to dark with a working native login, fix the cause in an ordinary PR, then restart. The latch never clears itself, and only the owner clears it.

## One time: install this feature and initialize the stage log

The first build with the stage tables creates them on first open. On a home that already has Codex switch history, it also marks the latch state unknown (`initialize-required`). Every Codex switch and every qlb refresh of an owned Codex token treats an unknown latch as set, so initialize right after installing:

```bash
qlb codex latch clear --initialize --reason "first install of the stop latch"
```

`qlb doctor` shows `codex:stop-latch` as a WARN naming `--initialize` until this runs. The command is refused with `not-required` when the log is already readable, which is the normal case on a home with no Codex switch history.

## Starting a stage

Before Stage 1:

1. Merge the PR that sets `CODEX_SWITCH_COMMAND_ENABLED = true` in `src/codex-flag.ts`, with the current `qlb codex stage report` output attached.
2. Install that build from a clean checkout of `main`. Every installed `qlb`, including the `qlb-auto` LaunchAgent, runs `~/.qlb/app/current`, so the next run uses the new build.
3. Read `qlb doctor --json` and note every WARN code from `codex:slots` and `codex:first-switch` that you accept for this run. A FAIL is never accepted.
4. Start the stage, naming each accepted WARN as `<check>:<code>`:

```bash
npm ci
npm run build
node dist/cli.js release install
qlb codex stage report
qlb codex stage start --stage 1 --allow <check>:<code>
```

Repeat `--allow` once per accepted warning, and drop it when you accept none. A current `codex:first-switch` WARN already fails the `codex-first-switch-pass` precondition at start, so the list matters mostly for warnings that appear during the run. A refused start records no stage-start row, though the stop sweep it runs first can record a stop. It is refused when the flag is off (`flag-off`), the phase is not `cutover`, the latch is set or unknown, a run is still open (`run-open`), a watch is open, a recovery fence is set, a precondition fails, a Codex check FAILs, a check WARNs with a code not on the list, or a Codex lock is held (`codex-lock-busy`). The refusal names the reason after `refused:`; `docs/CLI.md` lists every code.

When the report shows Stage 1 as `PASS`, promote to Stage 2. Stage 2 takes no `--allow`: it inherits Stage 1's list, and records Stage 1's frozen result:

```bash
qlb codex stage start --stage 2
```

When the report shows Stage 2 as `PASS`, close it. The close freezes the result; a stop recorded later does not change it, but it still sets the latch:

```bash
qlb codex stage close
```

## Reading the stage report

```bash
qlb codex stage report
```

The report opens the store read-only and never records anything, so it is safe to run at any time and to attach to a public PR. It prints the preconditions, the latch (`unarmed`, `armed`, `latched`, or `latch state unknown (<why>)`), each recorded stop with its evidence row, any stop the next sweep would record but has not yet, and each stage's result: `PASS`, `NOT YET`, `STOP`, `NOT STARTED`, or `UNKNOWN`.

## How a stop reaches you

A stop is recorded when the sweep finds a forced relogin (an `identity-replaced`, `wiped` or `dead` relogin row), a half-finished switch (one that ended neither committed nor cleanly rolled back), an unconfirmed switch (a watch verdict of `reverted` or `inconclusive`), an unexplained refusal (a persisted refusal outside qlb's named refusal set), or an evidence row it cannot read. The report and the stop's `auto.log` line name the rule. It reaches you three ways:

- `qlb switch openai-codex` exits `3` with `codex-stop-latched`, printing `latched by stop <id> (evidence <table>:<id>)`;
- `~/.qlb/auto.log` gains one `codex:stop-latched stop=<id> rule=<rule> evidence=<pointer> at=<ms>` line per recorded stop;
- `qlb doctor` shows `codex:stop-latch` as a WARN naming the stop and its evidence.

A request already on its way when the stop is recorded completes. The next switch or refresh is refused.

## Back to dark after a stop

Use this path in the `cutting-over` or `cutover` lifecycle phase. In the `retired` phase, use the next section instead. None of these steps is refused by the latch.

1. **Revert the flag.** Open and merge a PR that sets `CODEX_SWITCH_COMMAND_ENABLED = false` in `src/codex-flag.ts`. Attach the `qlb codex stage report` output. This is a forward PR on `main`; never reinstall an older release, because a build without the stage tables ignores a set latch.
2. **Install that build** from a clean checkout of `main`. From then on, every `qlb` run, `qlb-auto` included, is dark.
3. **Log in natively if the live login is not working.** Run `codex login` (the Codex CLI's own login) so Codex runs on a native login while you fix the cause. Codex refreshes its own login; qlb's refresh stays latched.
4. **Import the live login** so qlb records it as the active slot. The import sends no refresh request, so the latch admits it.
5. **Probe the latch** once without `--through`. It runs recovery and the due-watch runner, sweeps, and prints the latch state, the newest stop id and anything else that blocks a clear, as `blocked by: open-watch:<until>` or `fence-set:<reason>`. It records no clear. It can record what recovery, the watch runner or the sweep settle, including a newer stop, which is why you read the newest stop id from the probe rather than from the first refusal.
6. **Fix the cause in an ordinary PR.** Name the stop id and its evidence row in the PR.
7. **Read the report again** and confirm the stop you reviewed is the newest one.
8. **Clear through the newest stop**, with a one-line reason. The clear is refused with `newer-stop: <id>` when a newer stop exists, `open-watch` while a watch is open, and `fence-set` while a recovery fence is set.
9. **Restart** as described under "Restarting after the fix".

```bash
npm ci
npm run build
node dist/cli.js release install
codex login
qlb codex import-active
qlb codex latch clear
qlb codex stage report
qlb codex latch clear --through <stop-id> --reason "<one line: what the stop was and what fixed it>"
```

`codex-lock-busy` from the probe or the clear means a Codex switch, refresh or `codex add` holds a lock. No clear was recorded; retry.

## Back to dark in the retired phase

The `retired` lifecycle phase does not admit `qlb codex import-active` (it is refused with `phase=retired`). It does admit `qlb codex add` and `qlb codex latch clear`, so the slot is re-added instead:

1. Revert the flag and install that build, as in steps 1 and 2 above.
2. Run `codex login` natively so Codex keeps working.
3. Re-add the slot with `qlb codex add`. It runs its own isolated `codex login`, so the native login is untouched. When a slot with the same identity already exists, use `qlb codex add --replace <slot-id>`. A replace records an `identity-replaced` relogin, which the sweep records as a new stop.
4. Probe the latch, read the report, fix the cause, and clear through the newest stop the probe names, as in steps 5 to 8 above.

The stages cannot restart in `retired`: `qlb codex stage start` and `qlb codex stage close` are admitted only in `cutover`, so they are refused with `phase=retired`. After the clear, Codex stays dark. Taking it live again from `retired` needs a lifecycle decision outside this runbook.

```bash
codex login
qlb codex add
qlb codex add --replace <slot-id>
qlb codex latch clear
qlb codex stage report
qlb doctor
qlb codex latch clear --through <stop-id> --reason "<one line: what the stop was and what fixed it>"
```

## Restarting after the fix

This section applies in the `cutover` phase. A clear does not start a stage. Restarting needs the flag flip merged again, that build installed, and a new stage start, with the report attached to the flag-flip PR. The new run's evidence window opens at the new start.

Which stage restarts:

- A stop during Stage 1 restarts at Stage 1.
- A stop during Stage 2 restarts at Stage 2 only if the fix left the Codex switch, watch or refresh code alone. When the fix touches switch, watch or refresh code, the restart is at Stage 1, because the manual stage is what proves the switch path before `qlb-auto` acts on it.

```bash
qlb codex stage report
qlb codex stage start --stage 1 --allow <check>:<code>
qlb codex stage start --stage 2
```

A Stage 2 restart needs a passing Stage 1 run (`stage-1-not-passed` otherwise).

## What the latch refuses and admits

In a dark build, `qlb switch openai-codex` stops earlier with its not-enabled text and `qlb codex stage start` with `flag-off`; the rows below are what a build with the flag on does.

| Command | While latched |
|---|---|
| `qlb switch openai-codex`, and every automatic switch | Refused: `codex-stop-latched` |
| `qlb codex refresh --force`, the scheduled refresh of the active login, and the pre-switch refresh | Refused: `codex-stop-latched` |
| `qlb codex stage start` | Refused: `latched` (and `phase=<state>` outside `cutover`) |
| `qlb codex import-active` | Admitted in `cutting-over` and `cutover`; `retired` refuses it |
| `qlb codex add` | Admitted |
| Adopting a successor login already stashed, attribution mirroring and stash | Admitted: they send no request |
| `qlb codex stage report`, `qlb doctor` | Admitted: the report writes nothing; doctor writes only its usual `health_log` row |
| `qlb codex latch clear` (probe, `--through`, `--initialize`) | Admitted in `cutting-over`, `cutover` and `retired`, with the flag off or on |
| `qlb codex stage close` | Admitted in `cutover` |
