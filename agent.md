# ChyAI · CHYAI 打新（staged sale）· Agent guide

You are an AI agent with the **Binance Agentic Wallet** (`baw` CLI, always append `--json`). This guide buys CHYAI in the
staged sale for your user and, for past ChyAI miners, claims the 10,000 CHYAI airdrop. The airdrop-credential, mining
and check-in flow has **ended** (2026-10-30); its endpoints answer 410.

API base: `https://agentpad-api.onrender.com/v1` · chain: BSC (binanceChainId 56) · site: https://chyai.onrender.com/#/sale · official X: https://x.com/ChyAI_Official
Contracts: sale `<SALE — published after deployment>` · token `<published after deployment>` · airdrop `<published after deployment>`

Rules: never invent calldata — always use what the API returns. Every `baw contract-call` is two-step: `preview`, show the
user the parsed tx and risks, wait for an explicit yes, then `execute --requestId`. The contracts are **not audited**; no
returns are promised; the price after the pool opens may be lower than the sale price.

## The sale (fixed in the contract)
| Stage | USDT per share (100,000 CHYAI) | Shares |
|---|---|---|
| 1 | 1 | 1,000 |
| 2 | 2 | 1,500 |
| 3 | 4 | 2,000 |
| 4 | 8 | 2,500 |
| 5 | 16 | 3,000 |
| 6 | 24 | 3,500 |
| 7 | 32 | 4,000 |
| 8 | 48 | 4,500 |

The earlier, the lower the price. Stages 1-7 last 24h; unsold shares roll into the next stage; a stage that sells out early
starts the next one at once. Stage 8 runs until every remaining share is sold or the **30-day deadline** passes. Max **10 shares per .ai
Agent ID per stage**. Each payment: 20% to the treasury 0x972be707B4e070aC290206221e90Ff837eC14E9B, 80% held in the contract. The tx that sells the last
share opens the PancakeSwap CHYAI/USDT pool automatically (>= 0.00048 USDT per CHYAI), burns the LP, enables trading and
ends all admin rights. If it is not sold out within 30 days of the start, the sale closes for good (no pool) and only the
treasury can withdraw everything the contract holds — there are no buyer refunds. The start time is announced by the team (the sale is deployed paused).

## 0. Wallet
```
baw wallet address --json          # BSC address = <WALLET>
baw wallet settings --json         # devMode.enabled must be true (contract calls)
```
The wallet must hold a Binance .ai Agent ID (checked on-chain). Without one the sale contract rejects the purchase.

## 1. State
`GET https://agentpad-api.onrender.com/v1/chyai` → `sale` (started / paused / finished, stage, priceUsdt, stageEnd, stageCap, stageSold).

## 2. Buy (agent; user approves each tx)
```
curl -s "https://agentpad-api.onrender.com/v1/chyai/buy?wallet=<WALLET>&shares=<1-10>&pay=usdt"     # or pay=bnb
```
Run every `steps[].baw` in order (USDT: `approve_usdt` only when the allowance is short, then `buy`; BNB: one
`buy_bnb` with value — excess BNB is refunded in the same tx), show each preview, execute after the user's yes. If the
stage changed in between, `buy` reverts with OverMaxCost: fetch new steps. Errors: `no_agent_id`, `over_limit`,
`not_started`, `paused`, `finished`.

## 3. Past-miner airdrop (10,000 CHYAI)
```
curl -s https://agentpad-api.onrender.com/v1/chyai/airdrop/<WALLET>   # → eligible, proof, calldata, baw, opensAt, endsAt, claimed
```
Eligible = minted a ChyAI credential and/or had mining points at the 2026-10-30 snapshot. Claims open when the sale sells
out (pool opens) and close 30 days later; the unclaimed rest then goes to the treasury. Run the returned `baw` (value 0).

## 4. After the pool opens
Trading on PancakeSwap: 1% buy / 1% sell tax on the pool only (wallet transfers untaxed; use the fee-on-transfer swap
functions / slippage >= 1%). The tax is swapped to BNB: 80% to the Binance Charity wallet 0x8B99F3660622e21f2910ECCA7fBe51d654a1517D, 20% BNB dividends
to holders of >= 100,000 CHYAI (paid automatically; `claim()` on the token pays the rest).

ChyAI is independent and not affiliated with Binance. The AI-agent launchpad is coming soon.
