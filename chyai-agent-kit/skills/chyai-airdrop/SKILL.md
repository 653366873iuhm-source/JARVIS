---
name: chyai-airdrop
description: >
  Use when the user asks an AI agent to join the ChyAI airdrop, mint the ChyAI credential, start mining,
  do the daily ChyAI check-in, get an invite link, or claim ChyAI BNB promotion rewards on BNB Chain.
  Requires the Binance Agentic Wallet (`baw` CLI) holding a .ai Agent ID. Signing always stays in the user's wallet.
metadata:
  author: chyai
  version: 0.1.0
  homepage: https://chyai.onrender.com
  instructions: https://agentpad-api.onrender.com/agent.md
  requires:
    bins: [baw]
---

# ChyAI airdrop → credential → mining (agent skill)

ChyAI is an agent-only launchpad on BNB Chain (chainId 56). Only Binance Agentic Wallets holding a .ai Agent ID
can mint the airdrop credential. ChyAI is independent, not affiliated with Binance. Contracts are verified on
BscScan but not audited. Points are not tokens; no promised returns.

**Source of truth:** fetch https://agentpad-api.onrender.com/agent.md and follow it exactly. When unsure what to do
next, call `GET https://agentpad-api.onrender.com/v1/agent/flow?wallet=<WALLET>` (or the MCP tool `chyai_agent_flow`).

## Rules
- Always append `--json` to `baw`. Never invent calldata: send exactly what the API returns.
- Every `baw contract-call` / `baw sign-message` is two-step: `preview` → show the user → explicit yes → `execute --requestId`.
- Never ask for or handle private keys. ChyAI never asks for funds or keys by DM.
- All API calls are idempotent; re-running a step is safe.

## Steps
0. `baw wallet address --json` → `<WALLET>`; read the .ai name from baw. No .ai name → the wallet cannot take part.
1. Human: follow https://x.com/ChyAI_Official and **quote or reply to** the pinned post
   https://x.com/ChyAI_Official/status/2115430735167607129. Ask for the X handle and the link of that quote/reply.
2. Apply: `POST /v1/airdrop/claim` `{"xHandle","wallet","agentName":"<name>.ai","repostUrl","ref"?}`.
   `approved` → step 3; `pending_verification` → poll `GET /v1/airdrop/status?wallet=` every 10 min.
3. Mint: `GET /v1/airdrop/voucher?wallet=` → for each `steps[]` item with `simulation.ok`, run its `baw` command
   (preview → user approves → execute). Gas only, usually < 0.0001 BNB.
4. Mining starts automatically ~2 minutes after the mint: `GET /v1/mining/<WALLET>` → `mining:true`.
5. Daily check-in (once per UTC day, +5 points): run `checkin.baw.preview` from `GET /v1/mining/<WALLET>`
   (EIP-712, no funds move), execute after approval, then `POST /v1/mining/checkin`
   `{"wallet","signType":"eip712","signature","signatureRecovery"}`. 409 `already_checked_in` = done.
6. Invites (optional): `GET /v1/airdrop/invites/<WALLET>` → `link`. +5% mining speed per qualified invitee, max +50%.
7. BNB promotion rewards (optional): `GET /v1/rewards/<WALLET>/proof` → send each unclaimed item's `calldata` to
   `rewardPool` with baw (preview → approve → execute). Skip amounts smaller than the gas fee.

API base: https://agentpad-api.onrender.com/v1 · Site: https://chyai.onrender.com/#/airdrop
