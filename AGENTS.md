# AGENTS.md — QLB

Guide for coding agents working in this repo. Start with `README.md` (what QLB is and how it is run), `docs/ARCHITECTURE.md` (the pipeline and credential ownership) and `docs/CREDENTIAL-SAFETY.md` (the rules credential code must keep). `CONTRIBUTING.md` holds the development setup.

## Build and test

- Node.js 22 or newer. `npm ci`, then:
  - `npm run build`: cleans the registry output, compiles `src/` to `dist/`, writes the build stamp.
  - `npm run typecheck:pi`: typechecks this package, then `extensions/qlb-pi` against the installed Pi.
  - `npm test`: rebuilds, compiles `tsconfig.test.json` to `dist-test/`, and runs every `dist-test/test/*.test.js` with `QLB_TEST_MODE=1` and a temporary `QLB_HOME`.
  - `npm run build:helper`: builds the signed macOS Keychain helper in `native/keychain-helper/` (needed for `release install`, not for tests; its default run requires exact owner approval).
- One file: `export QLB_TEST_MODE=1 QLB_HOME="$(mktemp -d)"`, `npm run build && node scripts/clean-registry-output.cjs dist-test/src && npx tsc -p tsconfig.test.json`, then `node --test dist-test/test/<name>.test.js`.
- `QLB_TEST_MODE=1` swaps in the in-process credential backend (`src/credential-backends.ts`) and points `qlbHomeDir()` (`src/home.ts`) at `QLB_HOME`. Tests must never touch the live `~/.qlb`, `~/.pi/agent` or the Keychain.
- CI (`.github/workflows/ci.yml`) pins the Pi it installs (`PI_VERSION`) and requires `skipped 0` for `dist-test/test/qlb-pi-*.test.js` and `dist-test/test/keychain-client.test.js`. Keep those files runnable on that Pi.
- Known local-only failures: in a git worktree (where `.git` is a file), the two T-SCEN head checks in `test/accounts-prune.test.ts` fail. The Python oracle tests need Python 3.12+, which they find through `uv` under your real `HOME`.
- Lean models live in `proofs/`; check them with `scripts/check-lean-model.sh`.

## Module map

- `src/cli.ts` → `src/app.ts`: argument parsing and the older commands. `src/registry.ts` discovers the newer commands in `src/commands/` and the doctor checks in `src/checks/` (the build clears their `dist/` output first, so a removed module never lingers).
- `src/adapters/`: built-in provider adapters (the `Adapter` interface is in `src/types.ts`; register in `src/adapters/index.ts`).
- `src/store.ts`: the SQLite store. `src/lifecycle.ts`: the cutover lifecycle row and `PHASE_RULES`, the admission table for every lifecycle-governed command (including `qlb gate`).
- `src/migration.ts`: the generic `qlb migrate` state machine (NATIVE → MIRRORED → VALIDATED → QLB_OWNED, plus rollback and resume). `src/pi-migrate.ts`: the separate `qlb pi migrate` path; the two refuse each other.
- `src/pi-gate.ts` and `src/gate/`: `qlb gate <provider>`, the only path that hands a credential to the Pi extension. `src/token/`, `src/oauth/` and `src/single-consume.ts`: reading and the fenced refresh of QLB-owned grants.
- `src/keychain.ts`: Keychain access and the QLB item names (`qlb:<provider>:<account>`).
- `src/diagnostics.ts`: `qlb doctor`. `src/release.ts`: `qlb release install`. `src/pi-deploy.ts`: `qlb pi deploy`.
- `extensions/qlb-pi/`: the Pi extension. Deployed, it sits in `~/.pi/agent/extensions/qlb-pi` beside a shared `~/.pi/agent/src/` holding `src/redact.ts` and `src/pi-owner-document.ts`.
- `native/keychain-helper/`: the Swift helper. `harness/`: harness integrations. `test/oracle/claude-swap-v0.28.0/`: the vendored oracle for the claude-swap ports; its LICENSE is in `third_party/claude-swap/`.

## Live state: hands off

These change the owner's live machine. Never run them from an agent session unless the owner has approved that exact run:

- `qlb release install`, `qlb pi deploy`, `qlb switch`, `qlb cutover`, `qlb consume`, `qlb keychain`;
- `qlb migrate stage|rehearse|commit|rollback|resume` and `qlb pi migrate|rollback`;
- LaunchAgent edits, and anything that writes `~/.qlb/qlb.db` or a Keychain item.

From an agent session, run `qlb` or `node dist/cli.js` only with `QLB_TEST_MODE=1` and a temporary `QLB_HOME`, unless the owner has approved that exact live-state run. That approval is required for every live-state command, including `qlb doctor`, `qlb report cutover`, migrations with temporary input paths, and default `npm run build:helper`. Agents never run `qlb gate` or `qlb token`: they print a live credential, and S30 (`docs/CREDENTIAL-SAFETY.md`) reserves them for the Pi extension.

## Changes and pull requests

- TDD: a behaviour change starts with a failing test. A characterization test shows it is live by a named mutation.
- Keep TypeScript strict and the existing style. Prefer Node built-ins over new dependencies. Credential code stays read-only unless a migration command owns the write.
- One slice per pull request, Conventional Commits. Run `npm run build`, `npm run typecheck:pi` and `npm test` before opening it, and say what you ran.
- The owner merges. Do not merge, approve, enable auto-merge or force-push.
- Never commit credentials, account addresses, machine-specific absolute paths, or `dist/` / `dist-test/` output.
