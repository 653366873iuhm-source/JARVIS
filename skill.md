---
name: chyai-sale
description: >
  Use when the user asks about ChyAI, CHYAI, the CHYAI staged token sale (打新), or wants an AI agent to check the
  sale stage/price, buy CHYAI shares with USDT or BNB, or claim the past-miner CHYAI airdrop on BNB Chain (chainId 56).
  Requires the Binance Agentic Wallet (`baw` CLI) holding a .ai Agent ID. The user approves every transaction.
metadata:
  author: chyai
  version: 1.0.0
---

# CHYAI staged sale (BNB Chain)

ChyAI is building an agent-only AI launchpad on BNB Chain (coming soon). Live now: the CHYAI platform-token staged sale,
only for Binance Agentic Wallets holding a .ai Agent ID. Independent, not affiliated with Binance. Contracts not audited;
no promised returns.

- Site: https://chyai.onrender.com/#/sale · Agent guide: https://agentpad-api.onrender.com/agent.md · llms.txt: https://chyai.onrender.com/llms.txt
- State (JSON): `GET https://agentpad-api.onrender.com/v1/chyai`
- Sale contract `0x0Ada71a9538A89B946AF000b7FF61191f3E54cf1` · token `0xD9874C2c12F44a52B6c7B93FC18A4bA78BB10Cfc` · airdrop `0x9967Aa40d0C05b53004E769C065a1F331BF00AB1`

## Rules of the sale (fixed in the contract)
- 8 stages, 100,000 CHYAI per share, the earlier the lower the price: 1 / 2 / 4 / 8 / 16 / 24 / 32 / 48 USDT per share.
- Max 10 shares per .ai Agent ID per stage. Pay USDT or BNB.
- The transaction that sells the last share opens the PancakeSwap CHYAI/USDT pool automatically, burns the LP and ends all admin rights.
- Read the full rules (treasury share, 30-day treasury valve, taxes) in agent.md before buying and tell the user.

## Steps
1. `baw wallet address --json` → `<WALLET>`; `baw wallet settings --json` → devMode must be enabled.
2. `GET https://agentpad-api.onrender.com/v1/chyai` → check `sale.started`, `stage`, `priceUsdt`, `stageCap`, `stageSold`.
3. Tell the user the stage, price, shares and total cost; get their go-ahead.
4. `GET https://agentpad-api.onrender.com/v1/chyai/buy?wallet=<WALLET>&shares=<1-10>&pay=usdt` (or `pay=bnb`).
   Run each returned `steps[].baw` in order: `baw contract-call preview ...`, show the preview, then `execute` only after the user's yes.
   Never invent calldata. On `OverMaxCost` (stage changed) fetch new steps.
5. Past miners: `GET https://agentpad-api.onrender.com/v1/chyai/airdrop/<WALLET>` → run the returned `baw` once claims are open.

## Safety
- Never plain-transfer funds to the sale or token contract. Errors: `no_agent_id`, `over_limit`, `not_started`, `finished`.
- The airdrop-credential / mining / check-in flow ended on 2026-10-30 (endpoints answer 410).
