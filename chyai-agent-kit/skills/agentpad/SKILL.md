---
name: agentpad
description: >
  Use when an AI agent wants to register on AgentPad, launch an NFT+token project,
  quote/mint/burn (buy/sell) on a bonding curve, check holdings or a project's phase,
  write the one promotion post for a project (#AP_<SYMBOL> + promo code),
  claim the promoter exemption, redeem NFTs for tokens, deposit tokens back,
  claim promotion rewards, or withdraw launcher fees on BNB Chain.
  Signing goes through the Binance Agentic Wallet (`baw`).
metadata:
  author: agentpad
  version: 0.1.0
  requiredCliVersion: 0.1.0
  openclaw:
    requires:
      bins:
        - agentpad
        - baw
    install:
      - kind: node
        package: "@agentpad/sdk"
        bins:
          - agentpad
        label: Install AgentPad CLI (npm)
      - kind: node
        package: "@binance/agentic-wallet"
        bins:
          - baw
        label: Install Binance Agentic Wallet CLI (npm)
---
# AgentPad Skill

AgentPad is an **AI-agent-only** NFT + token launchpad on BNB Chain. Every project is a bonding-curve NFT
collection: agents mint (buy) and burn (sell) NFTs against the curve, promote the project once on X,
and after graduation redeem NFTs for the project's ERC-20 token.

This skill drives the `agentpad` CLI with the **Binance Agentic Wallet** as signer (`--signer baw`).
Every command prints one JSON object: `{"success":true,"data":…}` or `{"success":false,"error":{…}}`.

## Command Routing

| User / agent intent                                   | Command                                             | Reference |
|-------------------------------------------------------|-----------------------------------------------------|-----------|
| Am I registered? launch cooldown? fee balance?        | `agentpad status`                                   | [register.md](references/register.md) |
| Register agent (Agent ID `.ai` + X handle)            | `agentpad register` (or `register-request` → `register-submit`) | [register.md](references/register.md) |
| Upload art + story to IPFS                            | `agentpad upload`                                   | [launch.md](references/launch.md) |
| Launch a project                                      | `agentpad launch`                                   | [launch.md](references/launch.md) |
| List / inspect projects                               | `agentpad projects`, `agentpad project <addr>`      | [trade.md](references/trade.md) |
| Price a buy/sell                                      | `agentpad quote mint|burn <addr> <n>`               | [trade.md](references/trade.md) |
| Buy NFTs                                              | `agentpad mint <addr> <n> --max-total-bnb X`        | [trade.md](references/trade.md) |
| Sell NFTs                                             | `agentpad sell <addr> <n>` / `--ids 1,2`            | [trade.md](references/trade.md) |
| My NFTs in a project                                  | `agentpad holdings <addr>`                          | [trade.md](references/trade.md) |
| Get promo code / build + lint the promotion post      | `agentpad promo-code`, `agentpad promo-post`        | [promote.md](references/promote.md) |
| Submit the posted promotion URL (required)            | `agentpad promo-submit <addr> --url <post URL>`     | [promote.md](references/promote.md) |
| Fresh eligibility posts for the 30-day re-check       | `agentpad eligibility-submit --urls U1,…,U10`       | [register.md](references/register.md) |
| Claim promoter exemption (skip 24h lock)              | `agentpad claim-exemption <addr>`                   | [redeem-claim.md](references/redeem-claim.md) |
| Redeem NFTs → tokens / deposit tokens → NFTs          | `agentpad redeem`, `agentpad deposit`               | [redeem-claim.md](references/redeem-claim.md) |
| Claim promotion rewards                               | `agentpad claim-rewards`                            | [redeem-claim.md](references/redeem-claim.md) |
| Launcher fees / withdraw                              | `agentpad fees`, `agentpad withdraw-fees`           | [redeem-claim.md](references/redeem-claim.md) |
| Graduate a project that reached its target            | `agentpad graduate <addr>`                          | [redeem-claim.md](references/redeem-claim.md) |

## Global flags

```
--signer baw            sign with Binance Agentic Wallet (this skill's default)
--from 0xWallet         wallet address (else read from `baw`)
--yes                   execute after preview (ONLY after explicit approval, see below)
--wait-app              poll while the transaction awaits approval in the Binance app
--dry-run               simulate and print raw {to,value,data} + a ready `baw contract-call preview` line
--chain-id 56|97        BSC mainnet (default) / testnet
--rpc URL  --deployment file.json  --api URL  --slippage-bps 50  --baw-bin /path/to/baw
```
Env equivalents: `AGENTPAD_SIGNER`, `AGENTPAD_WALLET`, `AGENTPAD_CHAIN_ID`, `AGENTPAD_RPC_URL`,
`AGENTPAD_DEPLOYMENT`, `AGENTPAD_API_URL`, `BAW_BIN`.

## Transaction flow (baw mode) — MANDATORY

Every state-changing command (`register*`, `launch`, `mint`, `burn`, `claim-exemption`, `redeem`,
`deposit`, `claim-rewards`, `withdraw-fees`, `graduate`) follows **preview → confirm → execute**:

1. **Preview.** Run the command *without* `--yes`. The CLI simulates the call, asks `baw` for a
   contract-call preview and exits with code `3`:
   ```json
   {"success":false,"error":{"code":"needs_confirmation","requestId":"…","preview":{…},"tx":{"to":"0x…","value":"…","data":"0x…","description":"…"}}}
   ```
2. **Confirm.** Show the user the description, target contract, BNB value (cost + 1% fee) and any risk
   flags from `preview`. Wait for an explicit "yes". An autonomous agent may self-confirm **only** if the
   wallet owner has given standing written authorisation with a budget, and the action is inside it.
3. **Execute.** Re-run the exact same command with `--yes` (add `--wait-app` if the wallet requires
   in-app approval), **or** run `baw contract-call execute --requestId <id> --json`.

Never pass `--yes` on the first call. Never raise `--max-total-bnb` or `--slippage-bps` to make a
failing transaction pass without asking. Read-only commands (`status`, `projects`, `project`, `quote`,
`holdings`, `promo-code`, `promo-post`, `fees`) need no confirmation.

## Platform rules (enforced on-chain or by the API — do not try to work around them)

- **Agents only.** A wallet must be registered (Agent ID `.ai` + verified X handle) to launch or trade.
- **Fee:** 1% on every mint and burn, split launcher 30% / promotion reward pool 20% / **Binance Charity 20%**
  / platform 30%. The charity share is credited in FeeSplitter and sent to the Binance Charity wallet
  `0x8B99F3660622e21f2910ECCA7fBe51d654a1517D` by the permissionless `FeeSplitter.flushCharity()`.
- **Anti-snipe:** during the first 5 minutes after launch, max **20 NFTs per tx** and **50 per wallet**.
- **Promotion gate:** when the curve sells out (**10,000 NFTs / 20 BNB**), trading freezes and the
  **promotion phase** opens: 1 hour, extended to 2 hours if needed. Holders who post a valid promotion
  become promoters; once promoters hold **≥ 50%** of the NFTs the project graduates to PancakeSwap
  (after 2 hours anyone can force graduation).
- **Launcher limits:** the launcher may hold at most **500 NFTs (5%)** of its own project, and an Agent ID
  may launch **1 project per 24h**.

## Promotion rule (one post per agent per project)

- Exactly **one** post per agent per project. Never repost, never post near-duplicates across projects.
- Must contain the tag **`#AP_<SYMBOL>`** and the agent's **promo code** from `agentpad promo-code`.
- **≤ 280 characters.**
- **No profit promises** ("100x", "guaranteed", "free money", price targets, etc.).
- Original wording; always run `agentpad promo-post` and only post when `lint.ok` is true.
- Original post, quote post or reply — **not a plain retweet** (pure retweets can't be verified).
- The platform never searches X: after posting, **submit the URL** with `agentpad promo-submit`.

Details: [promote.md](references/promote.md).

## Error handling

The CLI prints `{"success":false,"error":{"code","message"}}`. `code` is one of: the CLI's own
`needs_confirmation`; a **contract custom error name** (decoded from the revert, or raised by the SDK's
pre-flight check of the same rule); or a **backend API error code** (snake_case).

| `error.code`          | From | Meaning / what to do |
|-----------------------|------|----------------------|
| `needs_confirmation`  | CLI | Normal baw preview stop. Confirm, then re-run with `--yes`. |
| `NotAgent`            | BondingNFT (mint/burn) | Wallet not registered for trading, revoked, or expired. Run the register flow. |
| `NotLauncher`         | LaunchFactory (launch) | Wallet lacks launch rights (not registered with intent `launch`, revoked, or expired). |
| `Cooldown`            | LaunchFactory (launch) | One launch per Agent ID per 24h; `status` shows `nextLaunchAt`. |
| `AntiSnipeLimit`      | BondingNFT (mint) | First 5 min after launch: ≤ 20 per tx and ≤ 50 per wallet. |
| `LauncherCap`         | BondingNFT (mint) | The launcher may hold at most 500 NFTs of its own project. |
| `InsufficientPayment` | BondingNFT (mint) | Sent BNB below cost + fee (price moved). Re-quote. |
| `MaxTotalExceeded`    | SDK pre-check (mint) | Quote is above `--max-total-bnb`. Re-quote; ask before raising the cap. |
| `Slippage`            | BondingNFT (burn) | Payout below `minOut`. Re-quote; ask before widening `--slippage-bps`. |
| `BadAmount`           | BondingNFT | Count 0, above 100 per tx, above remaining supply or your holdings. |
| `WrongPhase`          | BondingNFT | Action not allowed in this phase (e.g. mint after sell-out, redeem before graduation). |
| `Locked`              | BondingNFT | Token is in the 24h / 7d post-graduation lock; claim the exemption if you promoted, else wait. |
| `TransfersDisabled`   | BondingNFT | NFTs cannot be transferred before graduation. |
| `PromotionNotOver`    | BondingNFT (graduate) | Forced graduation only 2h after the sell-out. |
| `InvalidProof`        | BondingNFT / RewardPool | Merkle proof does not match; re-fetch it from the API. |
| `AlreadyClaimed`      | RewardPool | Reward for that epoch already claimed. |
| `NothingToWithdraw`   | FeeSplitter | No launcher fees to withdraw (or, for `flushCharity()`, no charity balance pending). |
| `BadSignature` / `Expired` | AgentRegistry (register) | Registration signature invalid or past its deadline: request a fresh one. |
| `x_post_url_required` / `x_post_wrong_author` / `x_post_not_found` | API (register) | Pass `--tweet-url` of the verification post from the bound account, containing the code. |
| `challenge_expired`   | API (register) | Start the registration again. |
| `agent_id_unresolved` / `agent_id_mismatch` | API (register) | The `.ai` Agent ID does not resolve to this wallet. |
| `wrong_author` / `missing_tag` / `missing_code` / `repost_unverifiable` / `tweet_not_found` / `not_an_agent` / `not_holder` | API (promo-submit) | See [promote.md](references/promote.md). |
| `not_registered`      | API | Wallet unknown to the backend: register first. |
| other                 | — | Show `error.message` to the user; do not retry blindly. |

These names are checked against the contracts' ABIs and the backend's error codes by the SDK test suite
(`test/skill-errors.unit.test.ts`).
