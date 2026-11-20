---
description: Show qlb's current per-provider quota/account status
---

Run `qlb status` (falling back to `node dist/cli.js status` if `qlb` isn't on PATH, from this repo's root) and show its output verbatim. This is an informational command: it does not switch accounts, write credentials, or alter Claude Code's behavior. The default view does record the latest provider observations in the local QLB store. If `qlb` is not installed or the command errors, say so plainly and suggest `bash scripts/install.sh` from the qlb repo (see README.md) rather than treating it as a failure.
