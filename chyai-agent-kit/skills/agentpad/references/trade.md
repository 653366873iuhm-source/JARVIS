# Trade: discover, quote, mint (buy), sell (exit)

## Discover (read-only)

```bash
agentpad projects [--phase trading|promotion|graduated] [--limit 20]
agentpad project <addr>          # phase, supply, curve state, holders, launch time, API story/meta
agentpad holdings <addr> [--wallet 0x] [--from-block N]   # token IDs held (scanned from Transfer logs)
```

## Quote (read-only)

```bash
agentpad quote mint <addr> 5
agentpad quote burn <addr> 2
```
`data.human` gives cost / fee / total (mint) or gross / fee / net (burn) in BNB. Fee is **1%** (launcher 0.3% / reward pool 0.2% / Binance Charity 0.2% / platform 0.3%).

## Mint (buy)

```bash
agentpad mint <addr> 5 --signer baw --max-total-bnb 0.05          # preview
agentpad mint <addr> 5 --signer baw --max-total-bnb 0.05 --yes    # execute after approval
```
- Always quote first and set `--max-total-bnb` (cost + fee cap). Any overpay is refunded by the contract.
- `--slippage-bps` defaults to the SDK's value; ask before widening it.
- **Anti-snipe (first 5 min after launch):** ≤ 20 per tx, ≤ 50 per wallet.
- Launcher: at most 500 NFTs (5%) of its own project (`LauncherCap`).
- Result: `tokenIds`, `cost`, `fee`, `totalBnb`, `txHash`.

## Burn (sell)

```bash
agentpad sell <addr> 2 --signer baw              # sells 2 of your NFTs (picked from holdings)
agentpad sell <addr> --ids 12,40 --signer baw    # specific token IDs
# v2 projects (BondingNFT v2 template 0xDbAaF18C1Dc7945840Bb84D7360564876594d971, VERSION() = 2) use
# sell(uint256[],uint256), which passes the Binance Agentic Wallet risk check; v1 projects fall back to burn
# (blocked by baw risk control 351803 — sell those from an EOA). `agentpad burn` is an alias of `sell`.
# Calldata without the SDK: GET <api>/projects/<addr>/sell-tx?wallet=<w>&count=<n>
# re-run with --yes after approval
```
Result: `tokenIds`, `gross`, `fee`, `net`, `netBnb`. Locked tokens (post-graduation 24h / launcher 7d)
cannot be burned or transferred.

## Agent guidance

- Stay within the owner's budget (per project, per tick, total; keep a gas reserve).
- Tell the user the price impact: bonding-curve prices move with every mint/burn.
- Never describe a trade as guaranteed profit.
