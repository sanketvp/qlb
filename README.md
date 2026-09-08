# QLB — Cross-Provider Quota Load Balancer

Coding work is spread across 4 Claude accounts, 1 Codex (ChatGPT Pro) account, 1 Grok (xAI) account, and 1 Kimi K3 account. Each provider enforces several independent limits at once (5-hour, weekly, per-model-family). Today only Claude accounts are rotated, and nothing looks across providers or limit types. QLB is one balancer that reads live quota gauges and (later) routes to the best account+provider.

This repo is **Phase 0 only**: a read-only `qlb status` CLI over a shared adapter contract. No credential writes, no scoring, no request routing.

## Build & run

```bash
npm install
npm run build
node dist/cli.js status
node dist/cli.js status --json
```

Requires Node 18+ (global `fetch`; no runtime dependencies). Spec: `/Users/sanketpatel/DEV_vault/02-Architecture/quota-load-balancer-spec-2026-09-07-v6.md`
