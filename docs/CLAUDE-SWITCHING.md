# Claude switching provenance

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
