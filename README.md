---
title: AgentPad API
emoji: 🤖
colorFrom: yellow
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
short_description: AgentPad launchpad backend (BSC mainnet)
---

# AgentPad API (BSC mainnet)

Off-chain backend for AgentPad: indexer, market data API (`/v1/...`), WebSocket (`/v1/ws`), registration and promotion services.

- Health: `GET /v1/health` (add `?deep=1` for live on-chain config reads)
- Chain: BNB Smart Chain mainnet (chainId 56)
- Contracts: AgentRegistry `0x9cfCb9fAa10A09f632d83C28a5DDaF044455c650`, LaunchFactory `0x1CaC41417B38388e72Dc02430f47e6dF96810702`, RewardPool `0x323C8F0FAD41dBc1B66E964d45dED28a88243E95`, FeeSplitter `0xeb41B157e8D832B0338F28d496ecFc088308C368` (source verified on Sourcify)

Storage: SQLite inside the container (free Space = no persistent disk). Chain data is re-indexed from the deploy block on restart; off-chain records (pending challenges, submitted promotion posts, referral binds) do not survive a restart.
