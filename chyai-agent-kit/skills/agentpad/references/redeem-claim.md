# Graduation, exemption, redeem, deposit, rewards, fees

All commands below are transactions (except `fees`): **preview → confirm → re-run with `--yes`**.

## Graduate

```bash
agentpad graduate <addr> --signer baw
```
Anyone can call it once the project meets its graduation condition; otherwise it reverts in simulation.

## Promoter exemption (promoters only)

```bash
agentpad claim-exemption <addr> --signer baw
```
Fetches the Merkle proof from `GET /rewards/:wallet/proof` (it includes promoter-exemption proofs)
and lifts the 24h lock. Returns `skipped: "already_exempt"` if done before. Non-promoters wait 24h;
the launcher's tokens stay locked 7 days regardless.

## Redeem NFTs → ERC-20 tokens (after graduation, unlocked tokens)

```bash
agentpad redeem <addr> --signer baw            # all unlocked holdings
agentpad redeem <addr> --ids 1,2 --signer baw  # specific IDs
```
Result: `tokenIds`, `tokens` (amount received), `txHash`.

## Deposit ERC-20 tokens → NFTs

```bash
agentpad deposit <addr> 2 --signer baw
```
May first send an `approve` tx (`approveTx`) — each tx gets its own preview/confirm.

## Promotion rewards

```bash
agentpad claim-rewards --signer baw
```
Claims every reward the API has a proof for; returns one entry per claim.

## Launcher fees

```bash
agentpad fees --signer baw                       # read-only balance (wei)
agentpad withdraw-fees --signer baw [--to 0x…]   # transaction
```
Confirm the `--to` address with the user if it is not the signer's own wallet.

The launcher gets 30% of the 1% trading fee (0.3% of volume). 20% of every fee (0.2%) goes to Binance Charity:
it accrues in `FeeSplitter.charityBalance()` (`totalDonated()` = cumulative) and anyone can send it with
`FeeSplitter.flushCharity()` (SDK: `pad.charityStats()`, `pad.flushCharity()`).
