# Claude switching

Claude Code switching and Pi's Anthropic pool are separate owners. After Gates 5, 6, and 7, both are live and each keeps its own journal.

## Two journals

| Store | Verified state | Who it serves |
| --- | --- | --- |
| `pi-pool` | `QLB_OWNED` (`ownerFile: "present"`, `detail.anthropicPoolExtension: "disabled"`, `piAtNextLaunch: "QLB works"`) | Pi, through `qlb-pi` and `qlb gate anthropic` |
| `cswap-anthropic` | `NATIVE` | Claude Code switching. Consume is not enabled. |

`qlb auto` under LaunchAgent `com.modus.qlb-auto` is the Pi pool's auto-switcher. It is not a Claude Code switcher. `com.modus.claude-pool-refresh` stays disabled so a second scheduler does not refresh or rotate Claude Code alongside the owned Pi pool.

`qlb switch anthropic <account_id> [--trigger manual] [--republish] [--json]` remains the Claude Code switch. It does not write `pi-pool` and it does not require `cswap-anthropic=CONSUMED`.

## Why consume stays off

`qlb consume enable --provider anthropic` is the command that would journal `cswap-anthropic=CONSUMED` and point Pi at the active Claude Code Keychain item. `src/app.ts` refuses that command while Pi already owns Anthropic. With `pi-pool` at `QLB_OWNED` the refusal is exit `1`, empty stdout, and:

```text
qlb consume enable: DUAL_OWNERSHIP_REFUSED — Pi's Anthropic accounts are QLB-owned (pi-pool QLB_OWNED). Roll back with `qlb migrate rollback --provider anthropic` first.
```

The same code refuses `MIRRORED`, `VALIDATED`, and `RETIRED`, and an owner file that is present or unreadable. Leaving `cswap-anthropic` at `NATIVE` is the steady state, not a half-finished migrate. The forward migrate commands (`stage`, `rehearse`, `commit`, `resume`) are the mirror image: they exit `1` with `DUAL_OWNERSHIP_REFUSED` if consume is enabled. `qlb migrate status` and `qlb migrate rollback` still run.

Pi enforces the same split at load. `decidePiMode` in `extensions/qlb-pi/consume.ts` returns `owned` when the Anthropic owner file is valid and the consume journal is `NATIVE`. That is the Gate 5/6/7 mode: Pi registers the QLB Anthropic source and keeps calling `qlb gate`. If an owner file (or `QLB_PI_REHEARSAL=1`) is ever combined with `CONSUMED`, or with a journal Pi cannot read, `decidePiMode` returns `conflict`. A malformed owner file is `conflict` too. Conflict registers an error-only Anthropic stub. It does not fall back to `anthropic-pool`, and it does not read the Claude Code Keychain item. The stub's text says to run `qlb consume disable --provider anthropic` or `qlb migrate rollback --provider anthropic`, then restart Pi.

Do not clear `DUAL_OWNERSHIP_REFUSED` by deleting `pi-pool` rows or by enabling consume "just for Claude Code." Claude Code switching already has its `NATIVE` journal. Pi already has `QLB_OWNED`.

## Provenance

QLB's Claude switching implementation ports selected behavior from
[claude-swap v0.28.0](https://github.com/realiti4/claude-swap). The vendored
oracle at `test/oracle/claude-swap-v0.28.0/` is the pinned reference for that
port.

The ports preserve the behavior identified in the module mapping table in
spec §3.1, including Claude lock coordination, OAuth handling, line
calculation, polling policy, and atomic file publication.

QLB deliberately differs where the specification says it must: its
transaction and credential-safety boundaries are defined in §§4.1–4.2, its
auto policy integration is defined in §4.3, and its lifecycle, admission, and
migration behavior is defined in §§4.7.3 and 4.15. Those requirements take
precedence over upstream behavior; this page does not restate them.

See `NOTICE` for the included upstream license text and
`docs/templates/ported-module-header.txt` for the per-module attribution
format.
