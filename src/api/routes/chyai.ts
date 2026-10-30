/**
 * CHYAI platform token (2026-10-30 pivot): staged sale + old-miner airdrop, for AI agents and the site.
 *
 *   GET /v1/chyai                         addresses, stage table, rules, live sale state (when deployed)
 *   GET /v1/chyai/buy?wallet=&shares=&pay=usdt|bnb   exact baw steps (approve if needed + buy) — nothing is sent here
 *   GET /v1/chyai/airdrop/:wallet         old-miner airdrop eligibility + Merkle proof + claim calldata
 *
 * Contract addresses come from env CHYAI_SALE / CHYAI_TOKEN / CHYAI_AIRDROP (placeholders until the deploy).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { encodeFunctionData, getAddress, isAddress, parseAbi, formatEther } from "viem";
import type { AppContext } from "../../context.js";
import { ApiError } from "../../services/registration.js";
import { CHYAI_AIRDROP_TREE } from "../../data/chyaiAirdrop.js";
import { apiBase, OFFICIAL_X } from "./agentflow.js";

export const CHYAI_SITE = "https://chyai.onrender.com";
export const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
export const CHARITY = "0x8B99F3660622e21f2910ECCA7fBe51d654a1517D";
export const TREASURY = "0x972be707B4e070aC290206221e90Ff837eC14E9B";
export const STAGES = [
  { stage: 1, priceUsdt: 1, shares: 1000 },
  { stage: 2, priceUsdt: 2, shares: 1500 },
  { stage: 3, priceUsdt: 4, shares: 2000 },
  { stage: 4, priceUsdt: 8, shares: 2500 },
  { stage: 5, priceUsdt: 16, shares: 3000 },
  { stage: 6, priceUsdt: 24, shares: 3500 },
  { stage: 7, priceUsdt: 32, shares: 4000 },
  { stage: 8, priceUsdt: 48, shares: 4500 },
] as const;

const saleAbi = parseAbi([
  "function overview() view returns (bool isStarted, bool isPaused, bool isFinished, uint256 stage, uint256 price, uint256 stageStart, uint256 stageEnd, uint256 stageCap, uint256 stageSold, uint256 sharesSold, uint256 paid, uint256 held)",
  "function closed() view returns (bool)",
  "function saleEndsAt() view returns (uint256)",
  "function walletStatus(address account) view returns (bool ok, uint256 id, uint256 bought, uint256 left)",
  "function bnbQuote(uint256 shares) view returns (uint256)",
  "function buy(uint256 shares, uint256 maxCost)",
  "function buyWithBnb(uint256 shares, uint256 maxBnb) payable",
]);
const erc20Abi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"]);
const airdropAbi = parseAbi(["function claim(address account, bytes32[] proof)", "function claimed(address) view returns (bool)", "function opensAt() view returns (uint256)", "function endsAt() view returns (uint256)"]);

const addr = (v: string) => (v && isAddress(v) ? getAddress(v) : null);
export function chyaiAddresses(ctx: AppContext) {
  return { sale: addr(ctx.cfg.CHYAI_SALE), token: addr(ctx.cfg.CHYAI_TOKEN), airdrop: addr(ctx.cfg.CHYAI_AIRDROP) };
}

export const CHYAI_RULES = {
  name: "CHYAI",
  chain: "BNB Smart Chain (chainId 56)",
  tokensPerShare: "100000",
  stageHours: 24,
  maxSharesPerAgentIdPerStage: 10,
  rollover: "Stages 1-7 last 24h; unsold shares roll into the next stage (sold at that stage's price). A stage that sells out early ends at once and the next starts in that block. Stage 8 runs until every remaining share (incl. rolled over) is sold or the 30-day deadline (start + 30 days) passes, whichever comes first.",
  autoPool: "The transaction that sells the last share opens the PancakeSwap V2 CHYAI/USDT pool automatically with all held USDT at >= 0.00048 USDT per CHYAI (CHYAI = held USDT / 0.00048, capped at 846,666,666), sends the LP to 0x...dEaD, enables trading and ends every admin right. Never otherwise.",
  valve: "Hard deadline = start + 30 days. If not every share is sold by then, the sale closes for good (no more buys, no pool, no trading) and ONLY the treasury can withdraw everything the sale contract holds (all held USDT plus any BNB / WBNB / other tokens sent to it; never CHYAI). No buyer refunds or claims; CHYAI already bought stays in buyers' wallets (transferable, but no pool).",
  buyerRequirement: "A Binance Agentic Wallet holding a .ai Agent ID (checked on-chain, SPACE ID registry 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F).",
  payment: "USDT, or BNB (Chainlink BNB/USD +1%, swapped to USDT in the same tx, excess refunded). Every purchase: 20% to the treasury at once, 80% held in the sale contract (USDT) for the automatic pool.",
  treasury: TREASURY,
  supply: "Max 3,048,216,666 CHYAI = 2,200,000,000 from the sale (minted on purchase) + up to 846,666,666 minted into the pool at sell-out + 1,550,000 past-miner airdrop. No team allocation.",
  pool: "Before the pool opens, wallet transfers work but nobody can add liquidity (known pools are blocked).",
  tax: "1% buy / 1% sell on registered V2 pairs only; wallet transfers untaxed. Hard max 1%; can only be lowered, and only before launch (no admin after launch). Swapped to BNB: 80% to the Binance Charity wallet, 20% BNB dividends to holders of >= 100,000 CHYAI (auto-paid, or claim()).",
  charity: CHARITY,
  airdrop: `Every wallet that minted a ChyAI credential and/or had mining points at the 2026-10-30 snapshot (${CHYAI_AIRDROP_TREE.count} wallets) gets 10,000 CHYAI. Claims open when the pool opens (sell-out) for 30 days; anyone may claim for a listed wallet; afterwards only the treasury can sweep the unclaimed rest (to the treasury).`,
  risk: "Contracts are NOT audited. No promised returns; the price may fall below the sale price and you may lose everything. Independent project, not affiliated with Binance or Binance Charity.",
};

export async function chyaiInfo(ctx: AppContext) {
  const a = chyaiAddresses(ctx);
  let sale: Record<string, unknown> | null = null;
  if (a.sale) {
    try {
      const [r, closed, endsAt] = await Promise.all([
        ctx.pc.readContract({ address: a.sale, abi: saleAbi, functionName: "overview" }),
        ctx.pc.readContract({ address: a.sale, abi: saleAbi, functionName: "closed" }),
        ctx.pc.readContract({ address: a.sale, abi: saleAbi, functionName: "saleEndsAt" }),
      ]);
      sale = {
        started: r[0], paused: r[1] && !closed, finished: r[2], closed, saleEndsAt: Number(endsAt), stage: Number(r[3]), priceUsdt: formatEther(r[4]),
        stageStart: Number(r[5]), stageEnd: Number(r[6]), stageCap: Number(r[7]), stageSold: Number(r[8]),
        sharesSold: Number(r[9]), paidUsdt: formatEther(r[10]), heldUsdt: formatEther(r[11]),
      };
    } catch (e) {
      sale = { error: String((e as Error).message ?? e).slice(0, 200) };
    }
  }
  return {
    deployed: !!a.sale,
    addresses: { ...a, usdt: USDT_BSC, treasury: TREASURY, charity: CHARITY },
    stages: STAGES,
    sale,
    rules: CHYAI_RULES,
    airdrop: { root: CHYAI_AIRDROP_TREE.root, recipients: CHYAI_AIRDROP_TREE.count, amountEach: "10000", snapshotAt: CHYAI_AIRDROP_TREE.snapshotAt },
    mining: { frozen: ctx.cfg.MINING_FROZEN_AT > 0, frozenAt: ctx.cfg.MINING_FROZEN_AT || null },
    site: `${CHYAI_SITE}/#/sale`,
  };
}

const baw = (from: string, to: string, value: bigint, data: string, chainId: number) =>
  `baw contract-call preview --binanceChainId ${chainId} --from ${from} --to ${to} --value ${value.toString()} --inputData ${data} --json`;

export async function chyaiBuySteps(ctx: AppContext, walletIn: string, sharesIn: string, payIn: string) {
  const a = chyaiAddresses(ctx);
  if (!a.sale) throw new ApiError(503, "not_deployed", "The CHYAI sale contract is not deployed yet.");
  if (!isAddress(walletIn)) throw new ApiError(400, "validation_error", "wallet must be a 0x address");
  const wallet = getAddress(walletIn);
  const shares = Math.floor(Number(sharesIn));
  if (!(shares >= 1 && shares <= 10)) throw new ApiError(400, "validation_error", "shares must be 1..10");
  const pay = payIn === "bnb" ? "bnb" : "usdt";
  const [ov, ws, closed] = await Promise.all([
    ctx.pc.readContract({ address: a.sale, abi: saleAbi, functionName: "overview" }),
    ctx.pc.readContract({ address: a.sale, abi: saleAbi, functionName: "walletStatus", args: [wallet] }),
    ctx.pc.readContract({ address: a.sale, abi: saleAbi, functionName: "closed" }),
  ]);
  if (!ov[0]) throw new ApiError(409, "not_started", "The sale has not started yet.");
  if (ov[2]) throw new ApiError(409, "finished", "The sale has ended.");
  if (closed) throw new ApiError(409, "closed", "The sale closed: it did not sell out within 30 days of the start. No more purchases are possible.");
  if (ov[1]) throw new ApiError(409, "paused", "The sale is paused.");
  if (!ws[0]) throw new ApiError(422, "no_agent_id", "This wallet has no Binance .ai Agent ID.");
  if (Number(ws[3]) < shares) throw new ApiError(422, "over_limit", `This Agent ID can buy ${Number(ws[3])} more share(s) in the current stage.`);
  const chainId = ctx.cfg.CHAIN_ID;
  const steps: { id: string; to: string; value: string; data: string; baw: string; note: string }[] = [];
  const cost = BigInt(shares) * ov[4];
  if (pay === "usdt") {
    const allow = await ctx.pc.readContract({ address: USDT_BSC, abi: erc20Abi, functionName: "allowance", args: [wallet, a.sale] });
    if (allow < cost) {
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [a.sale, cost] });
      steps.push({ id: "approve_usdt", to: USDT_BSC, value: "0", data, baw: baw(wallet, USDT_BSC, 0n, data, chainId), note: `Approve ${formatEther(cost)} USDT to the sale contract` });
    }
    const data = encodeFunctionData({ abi: saleAbi, functionName: "buy", args: [BigInt(shares), cost] });
    steps.push({ id: "buy", to: a.sale, value: "0", data, baw: baw(wallet, a.sale, 0n, data, chainId), note: `Buy ${shares} share(s) = ${shares * 100000} CHYAI for ${formatEther(cost)} USDT (maxCost guards against a stage change)` });
  } else {
    const need = await ctx.pc.readContract({ address: a.sale, abi: saleAbi, functionName: "bnbQuote", args: [BigInt(shares)] });
    const v = (need * 102n) / 100n;
    const data = encodeFunctionData({ abi: saleAbi, functionName: "buyWithBnb", args: [BigInt(shares), v] });
    steps.push({ id: "buy_bnb", to: a.sale, value: v.toString(), data, baw: baw(wallet, a.sale, v, data, chainId), note: `Buy ${shares} share(s) with up to ${formatEther(v)} BNB; any excess is refunded in the same tx` });
  }
  return { wallet, stage: Number(ov[3]), priceUsdt: formatEther(ov[4]), shares, pay, costUsdt: formatEther(cost), steps, rule: "Run each step's baw preview, show it to the user, execute only after an explicit yes." };
}

export async function chyaiAirdropFor(ctx: AppContext, walletIn: string) {
  if (!isAddress(walletIn)) throw new ApiError(400, "validation_error", "wallet must be a 0x address");
  const wallet = getAddress(walletIn);
  const proof = CHYAI_AIRDROP_TREE.proofs[wallet] ?? null;
  const a = chyaiAddresses(ctx);
  let claimed: boolean | null = null;
  let opensAt: number | null = null;
  let endsAt: number | null = null;
  if (a.airdrop && proof) {
    try {
      const [c, o, e] = await Promise.all([
        ctx.pc.readContract({ address: a.airdrop, abi: airdropAbi, functionName: "claimed", args: [wallet] }),
        ctx.pc.readContract({ address: a.airdrop, abi: airdropAbi, functionName: "opensAt" }),
        ctx.pc.readContract({ address: a.airdrop, abi: airdropAbi, functionName: "endsAt" }),
      ]);
      claimed = c;
      opensAt = Number(o) || null;
      endsAt = Number(e) || null;
    } catch {
      /* chain read failed: leave null */
    }
  }
  const calldata = proof ? encodeFunctionData({ abi: airdropAbi, functionName: "claim", args: [wallet, proof as `0x${string}`[]] }) : null;
  return {
    wallet,
    eligible: !!proof,
    amount: proof ? "10000" : "0",
    proof,
    airdropContract: a.airdrop,
    claimed,
    opensAt,
    endsAt,
    calldata,
    baw: proof && a.airdrop ? baw(wallet, a.airdrop, 0n, calldata!, ctx.cfg.CHAIN_ID) : null,
    note: proof ? "Claimable after the CHYAI sale sells out and the pool opens, for 30 days. Anyone may send this claim; tokens always go to the listed wallet." : "This wallet is not in the 2026-10-30 snapshot (no credential and no mining points).",
  };
}

export function chyaiAgentMarkdown(base: string, chainId: number, a: { sale: string | null; token: string | null; airdrop: string | null }) {
  const api = `${base}/v1`;
  const s = a.sale ?? "<SALE — published after deployment>";
  return `# ChyAI · CHYAI 打新（staged sale）· Agent guide

You are an AI agent with the **Binance Agentic Wallet** (\`baw\` CLI, always append \`--json\`). This guide buys CHYAI in the
staged sale for your user and, for past ChyAI miners, claims the 10,000 CHYAI airdrop. The airdrop-credential, mining
and check-in flow has **ended** (2026-10-30); its endpoints answer 410.

API base: \`${api}\` · chain: BSC (binanceChainId ${chainId}) · site: ${CHYAI_SITE}/#/sale · official X: ${OFFICIAL_X}
Contracts: sale \`${s}\` · token \`${a.token ?? "<published after deployment>"}\` · airdrop \`${a.airdrop ?? "<published after deployment>"}\`

Rules: never invent calldata — always use what the API returns. Every \`baw contract-call\` is two-step: \`preview\`, show the
user the parsed tx and risks, wait for an explicit yes, then \`execute --requestId\`. The contracts are **not audited**; no
returns are promised; the price after the pool opens may be lower than the sale price.

## The sale (fixed in the contract)
| Stage | USDT per share (100,000 CHYAI) | Shares |
|---|---|---|
${STAGES.map((x) => `| ${x.stage} | ${x.priceUsdt} | ${x.shares.toLocaleString("en-US")} |`).join("\n")}

The earlier, the lower the price. Stages 1-7 last 24h; unsold shares roll into the next stage; a stage that sells out early
starts the next one at once. Stage 8 runs until every remaining share is sold or the **30-day deadline** passes. Max **10 shares per .ai
Agent ID per stage**. Each payment: 20% to the treasury ${TREASURY}, 80% held in the contract. The tx that sells the last
share opens the PancakeSwap CHYAI/USDT pool automatically (>= 0.00048 USDT per CHYAI), burns the LP, enables trading and
ends all admin rights. If it is not sold out within 30 days of the start, the sale closes for good (no pool) and only the
treasury can withdraw everything the contract holds — there are no buyer refunds. The start time is announced by the team (the sale is deployed paused).

## 0. Wallet
\`\`\`
baw wallet address --json          # BSC address = <WALLET>
baw wallet settings --json         # devMode.enabled must be true (contract calls)
\`\`\`
The wallet must hold a Binance .ai Agent ID (checked on-chain). Without one the sale contract rejects the purchase.

## 1. State
\`GET ${api}/chyai\` → \`sale\` (started / paused / finished, stage, priceUsdt, stageEnd, stageCap, stageSold).

## 2. Buy (agent; user approves each tx)
\`\`\`
curl -s "${api}/chyai/buy?wallet=<WALLET>&shares=<1-10>&pay=usdt"     # or pay=bnb
\`\`\`
Run every \`steps[].baw\` in order (USDT: \`approve_usdt\` only when the allowance is short, then \`buy\`; BNB: one
\`buy_bnb\` with value — excess BNB is refunded in the same tx), show each preview, execute after the user's yes. If the
stage changed in between, \`buy\` reverts with OverMaxCost: fetch new steps. Errors: \`no_agent_id\`, \`over_limit\`,
\`not_started\`, \`paused\`, \`finished\`.

## 3. Past-miner airdrop (10,000 CHYAI)
\`\`\`
curl -s ${api}/chyai/airdrop/<WALLET>   # → eligible, proof, calldata, baw, opensAt, endsAt, claimed
\`\`\`
Eligible = minted a ChyAI credential and/or had mining points at the 2026-10-30 snapshot. Claims open when the sale sells
out (pool opens) and close 30 days later; the unclaimed rest then goes to the treasury. Run the returned \`baw\` (value 0).

## 4. After the pool opens
Trading on PancakeSwap: 1% buy / 1% sell tax on the pool only (wallet transfers untaxed; use the fee-on-transfer swap
functions / slippage >= 1%). The tax is swapped to BNB: 80% to the Binance Charity wallet ${CHARITY}, 20% BNB dividends
to holders of >= 100,000 CHYAI (paid automatically; \`claim()\` on the token pays the rest).

ChyAI is independent and not affiliated with Binance. The AI-agent launchpad is coming soon.
`;
}

export function chyaiLlmsTxt(api: string, site: string = CHYAI_SITE) {
  const v1 = `${api}/v1`;
  return `# ChyAI

> ChyAI is building an agent-only AI launchpad on BNB Chain (chainId 56) — the launchpad is coming soon. Right now: the CHYAI platform-token staged sale for Binance Agentic Wallets with a .ai Agent ID. 8 stages, 100,000 CHYAI per share, the earlier the lower the price (1 → 48 USDT per share). Independent, not affiliated with Binance. Contracts not audited; no promised returns.

AI agents: read ${api}/agent.md and follow it. State: ${v1}/chyai. Buy steps: ${v1}/chyai/buy?wallet=<WALLET>&shares=<1-10>&pay=usdt|bnb. Past-miner airdrop: ${v1}/chyai/airdrop/<WALLET>.

## CHYAI sale
${STAGES.map((x) => `- Stage ${x.stage}: ${x.priceUsdt} USDT per share, ${x.shares} shares, ${x.stage === 8 ? "until sold out or the 30-day deadline" : "24h"}`).join("\n")}
- Unsold shares roll into the next stage; an early sellout starts the next stage at once; stage 8 ends at sell-out or at the 30-day deadline (start + 30 days), whichever is first.
- Max 10 shares per .ai Agent ID per stage. Pay USDT or BNB. 20% to the treasury ${TREASURY}, 80% held for the pool.
- ${CHYAI_RULES.autoPool}
- ${CHYAI_RULES.valve}

## Token
- ${CHYAI_RULES.supply}
- ${CHYAI_RULES.pool}
- ${CHYAI_RULES.tax}
- ${CHYAI_RULES.airdrop}

## Links
- [Sale page](${site}/#/sale)
- [Agent instructions (agent.md)](${api}/agent.md)
- [Agent card](${site}/.well-known/agent.json)
- [Official X](${OFFICIAL_X})

## Ended
- The airdrop credential, mining points and daily check-ins ended on 2026-10-30 (endpoints answer 410). Past miners get the CHYAI airdrop above.

## Risk
- ${CHYAI_RULES.risk}
`;
}

export function chyaiAgentCard(api: string, site: string = CHYAI_SITE) {
  const v1 = `${api}/v1`;
  return {
    protocolVersion: "0.3.0",
    name: "ChyAI",
    description: "CHYAI platform-token staged sale on BNB Chain for Binance Agentic Wallets with a .ai Agent ID (8 stages, the earlier the lower the price), plus a 10,000 CHYAI airdrop for past ChyAI miners. The AI-agent launchpad is coming soon. Independent, not affiliated with Binance. Contracts not audited. No promised returns.",
    url: v1,
    preferredTransport: "HTTP+JSON",
    version: "2.0.0",
    iconUrl: `${site}/brand/logo-512.png`,
    documentationUrl: `${api}/agent.md`,
    provider: { organization: "ChyAI", url: site },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/markdown"],
    instructions: { markdown: `${api}/agent.md`, llmsTxt: `${site}/llms.txt`, state: `${v1}/chyai` },
    chain: { name: "BNB Smart Chain", chainId: 56 },
    wallet: {
      required: "Binance Agentic Wallet (baw CLI) holding a .ai Agent ID",
      signing: "Every transaction is previewed by the agent and approved by the user in their own wallet; the API never holds keys and never sends user transactions.",
    },
    links: { website: site, sale: `${site}/#/sale`, x: OFFICIAL_X, charityWallet: CHARITY },
    endpoints: {
      chyai: { method: "GET", url: `${v1}/chyai` },
      buySteps: { method: "GET", url: `${v1}/chyai/buy?wallet={wallet}&shares={1-10}&pay={usdt|bnb}` },
      minerAirdrop: { method: "GET", url: `${v1}/chyai/airdrop/{wallet}` },
      config: { method: "GET", url: `${v1}/config` },
      health: { method: "GET", url: `${v1}/health` },
    },
    skills: [
      { id: "buy-chyai", name: "Buy CHYAI in the staged sale", description: "Get the exact baw steps (USDT approve + buy, or buy with BNB) for 1–10 shares; user approves each tx. Max 10 shares per Agent ID per stage.", tags: ["token-sale", "bnb-chain", "binance-agentic-wallet"], endpoint: `GET ${v1}/chyai/buy` },
      { id: "claim-miner-airdrop", name: "Claim past-miner airdrop", description: "10,000 CHYAI for wallets in the 2026-10-30 snapshot; Merkle proof + calldata; opens when the pool opens, 30 days.", tags: ["airdrop", "merkle"], endpoint: `GET ${v1}/chyai/airdrop/{wallet}` },
    ],
    disclaimer: "Independent, not affiliated with Binance. Contracts not audited. No promised returns.",
  };
}

export function registerChyaiRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/v1/chyai", async () => chyaiInfo(ctx));
  app.get<{ Querystring: { wallet?: string; shares?: string; pay?: string } }>("/v1/chyai/buy", async (req) =>
    chyaiBuySteps(ctx, String(req.query.wallet ?? ""), String(req.query.shares ?? "1"), String(req.query.pay ?? "usdt")),
  );
  app.get<{ Params: { wallet: string } }>("/v1/chyai/airdrop/:wallet", async (req) => chyaiAirdropFor(ctx, req.params.wallet));
}

export const chyaiBase = (req: FastifyRequest) => apiBase(req);
