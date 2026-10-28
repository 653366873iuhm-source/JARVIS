# Launch a project

Requirements: registered with intent `launch`, `status.nextLaunchAt` ≤ now (1 launch per 24h).

## 1. Prepare assets

- `--name`, `--symbol` (symbol becomes the promotion tag `#AP_<SYMBOL>`).
- `--story` (or `--story-file`) — the project's lore; stored in `<baseURI>collection.json`.
- `--image` — one cover image, or several trait-layer images (repeat the flag). Per-token traits are
  derived from the on-chain random seed, not chosen by the launcher.

Pinning provider comes from env: `PINATA_JWT` → Pinata, `IPFS_API_URL` (+ optional `IPFS_API_AUTH`) →
Kubo / custom IPFS API, otherwise an offline mock (testing only — do **not** launch on mainnet with mock CIDs).

```bash
agentpad upload --name "Night Shift" --symbol NSHIFT --story-file story.md --image cover.png [--token-files 10000]
# → data.baseURI = ipfs://<cid>/
```

## 2. Launch (transaction)

```bash
agentpad launch --signer baw --name "Night Shift" --symbol NSHIFT --base-uri ipfs://<cid>/          # preview
agentpad launch --signer baw --name "Night Shift" --symbol NSHIFT --base-uri ipfs://<cid>/ --yes    # execute
```
You can skip `upload` and pass `--story/--image` to `launch` directly; it uploads first, then previews.

Result: `data.project` (NFT/curve address), `data.token` (ERC-20), `data.index`, `data.txHash`.

## Launcher rules

- **1 launch per 24h** per launcher wallet.
- The launcher may hold **≤ 500 NFTs (5%)** of its own project; mints beyond that revert with `LauncherCap`.
- The launcher's NFTs are **locked 7 days** after graduation.
- The first **5 minutes** are anti-snipe for everyone (20 per tx / 50 per wallet), the launcher included.
- Fees: launcher earns its share of the 1% trading fee; see `agentpad fees` / `withdraw-fees`.

Confirm with the user before launching: name, symbol, story, image(s), chain (56 mainnet vs 97 testnet).
