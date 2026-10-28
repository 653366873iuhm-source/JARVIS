# ChyAI 空投 → 凭证 → 挖矿 · Agent 一键流程

You are an AI agent with the **Binance Agentic Wallet** (`baw` CLI, always append `--json`). Run the whole ChyAI
airdrop for your user. Manual clicks on the website alone never mint a credential and never start mining: the
credential must be minted **from the Agentic Wallet that holds the user's .ai Agent ID**.

API base: `https://agentpad-api.onrender.com/v1` · chain: BSC (binanceChainId 56) · official X: https://x.com/ChyAI_Official · pinned post: https://x.com/ChyAI_Official/status/2115430735167607129

Rules: never invent calldata — always use what the API returns. Every `baw contract-call` / `baw sign-message` is
two-step: run `preview`, show the user the parsed tx / message and risks, wait for an explicit yes, then `execute`
with the `requestId`. If preview fails, stop and report the error. Re-running any step is safe (all endpoints are idempotent).

## 0. Wallet (agent)
```
baw wallet address --json          # BSC address = <WALLET>
baw wallet settings --json         # devMode.enabled must be true
```
If Developer Mode is off → **human step**: enable it in the Binance App (Agentic Wallet → settings → Developer Mode).
The wallet's .ai name: `GET https://agentpad-api.onrender.com/v1/agent/flow?wallet=<WALLET>` → `agentName` (read on-chain from the Binance Agent ID registry).
No .ai name → this wallet cannot take part (only Binance Agent ID wallets can mint).

## 1. X post (human, unless you control the user's X account)
Follow https://x.com/ChyAI_Official, then **quote** or **reply to** the pinned post https://x.com/ChyAI_Official/status/2115430735167607129. Plain retweets have no link and are rejected.
Ask the user for the X handle and the link of that quote/reply.

## 2. Apply (agent)
```
curl -s -X POST https://agentpad-api.onrender.com/v1/airdrop/claim -H 'content-type: application/json' \
  -d '{"xHandle":"<handle>","wallet":"<WALLET>","agentName":"<name>.ai","repostUrl":"https://x.com/<handle>/status/<id>","ref":"<inviter>.ai"}'
```
`ref` is optional: the inviter's .ai name (or wallet) from the user's invite link (`…/airdrop?ref=<inviter>.ai`).
Leave it out when the user has none. It is bound once, on the first application; the response's `invite` says whether it was bound.
201 = new claim, 200 = already applied (returns the same claim; `existing:true`). `status`: `approved` → step 3;
`pending_verification` → poll `GET https://agentpad-api.onrender.com/v1/airdrop/status?wallet=<WALLET>` every 10 min; 422 → read `error.message`, fix the link, submit again.

## 3. Mint the credential (agent; user approves)
**Approved ≠ credential.** Approval only unlocks the voucher; the credential exists after this transaction.
```
curl -s "https://agentpad-api.onrender.com/v1/airdrop/voucher?wallet=<WALLET>"
```
For each item of `steps[]` in order: check `simulation.ok == true`, run its `baw` field exactly
(`baw contract-call preview --binanceChainId 56 --from <WALLET> --to <to> --value 0 --inputData <data> --json`),
show the preview, then `baw contract-call execute --requestId <requestId> --json`. If `requireConfirmation=true` →
**human step**: approve the order in the Binance App. Gas ≈ 200k gas (< 0.0001 BNB) is paid by the wallet.
`minted:true` in the voucher response = already done. The voucher expires (`deadline`); just fetch a fresh one.

## 4. Mining (automatic)
Mining starts by itself within ~2 minutes of the mint. Check: `GET https://agentpad-api.onrender.com/v1/mining/<WALLET>` → `mining:true`,
`credential.active:true`. `status:"no_credential"` means the mint has not landed yet (未 mint 凭证 → 不挖矿).

## 5. Daily check-in (agent, once per UTC day; user approves the signature)
```
curl -s https://agentpad-api.onrender.com/v1/mining/<WALLET>      # → checkin.checkedInToday, checkin.baw.preview
```
Run `checkin.baw.preview` exactly (EIP-712, signs only today's date — no funds move), show it, then
`baw sign-message execute --requestId <requestId> --json` (if PENDING_CONFIRMATION: user approves in the Binance App,
then `baw sign-message result --order-id <orderId> --json`). Submit:
```
curl -s -X POST https://agentpad-api.onrender.com/v1/mining/checkin -H 'content-type: application/json' \
  -d '{"wallet":"<WALLET>","signType":"eip712","signature":"<signature>","signatureRecovery":"<signatureRecovery>"}'
```
409 `already_checked_in` = done for today. Repeat daily (schedule it if you can).

## 6. Invites (optional)
Once the credential is minted, the user has an invite link: `GET https://agentpad-api.onrender.com/v1/airdrop/invites/<WALLET>` → `link`
(`…/airdrop?ref=<name>.ai`). Each invitee who applies with that ref, mints a credential, has an X account at least
30 days old and checks in on 7 days adds +5% mining speed (up to +50%). No self-invites. Leaderboard: `GET https://agentpad-api.onrender.com/v1/airdrop/invites/leaderboard`.

## 7. Claim promotion rewards (agent; user approves the tx)
Reward roots are posted on-chain by the platform in the daily settlement, but only once the reward pool
(RewardPool.unallocated) reaches 0.01 BNB. Below that nothing is posted and the pool rolls over; the settlement that
reaches it pays out the whole accumulated pool, scored over every day since the last settlement.
（BNB 奖励在奖励池达到 0.01 BNB 时才结算；未达到时顺延累积，达到后一次结算全部累积的奖励池，未结算的每一天的推广/推荐都计入。）
Pool and threshold: `GET https://agentpad-api.onrender.com/v1/rewards` → `pool`. Check what the wallet can claim:
```
curl -s https://agentpad-api.onrender.com/v1/rewards/<WALLET>/proof   # → rewards[]: { epoch, amount (wei), proof, claimed, rewardPool, calldata }
```
For each item with `claimed:false`, send the returned `calldata` to `rewardPool` with value 0 — never build it yourself:
`baw contract-call preview --binanceChainId 56 --from <WALLET> --to <rewardPool> --value 0 --inputData <calldata> --json`,
show the preview, then `baw contract-call execute --requestId <requestId> --json`. The amount is paid in BNB to the wallet.
Claim within the epoch's claim window (RewardPool.CLAIM_WINDOW; afterwards unclaimed amounts may return to the pool). Claiming costs gas — skip amounts smaller than the fee.

## One call for the current state
`GET https://agentpad-api.onrender.com/v1/agent/flow?wallet=<WALLET>` → `steps[]` (done / todo / waiting / blocked) and `next` with the exact command.

Points convert to the platform token by rules announced later; no promised returns. ChyAI is independent of Binance.
