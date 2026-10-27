/**
 * Shared DTO mappers: DB rows -> the field names the SDK (`sdk/API_CONTRACT.md`) and the
 * frontend (`frontend/API_CONTRACT.md`) expect. Every route that returns a project or a trade
 * goes through these, so the renames live in one place.
 *
 * Conventions: uint256 values are decimal strings; counts, bps and unix-second timestamps are numbers.
 */
import { MAX_CURVE_NFTS, PROMOTION_MAX, PROMOTION_WINDOW, TOKENS_PER_NFT as TOKENS_PER_NFT_WEI, TOTAL_SUPPLY_TOKENS } from "../lib/curve.js";

export type Phase = "trading" | "promotion" | "graduated";
export const PHASES: readonly Phase[] = ["trading", "promotion", "graduated"];

/**
 * Curve fee. The backend does not index `feeBps` per project (it is fixed at launch by the factory
 * config); 100 bps is the factory default and what `lib/curve.ts` quotes with. The FE overrides it from
 * chain in live mode.
 */
export const DEFAULT_FEE_BPS = 100;

/** Minimal project row shape (the `projects` table). */
export interface ProjectRowLike {
  address: string; token: string; launcher: string; name: string; symbol: string; baseUri: string; idx: number; tag: string;
  createdAt: number; createdBlock: number; phase: number; virtualBnb: string; virtualToken: string; reserveBnb: string;
  sold: number; supply: number; priceWei: string; volumeWei: string; tradeCount: number; lastTradeAt: number | null;
  promotionStart: number | null; graduatedAt: number | null; forced: boolean | null; pair: string | null;
  promoterRoot?: string | null; lastShareBps: number | null;
  story?: string | null; image?: string | null;
  poolReserveBnb?: string | null; poolReserveToken?: string | null; poolUpdatedAt?: number | null;
}

/** Price source of a project: the bonding curve before graduation, the PancakeSwap V2 pair reserves after. */
export function priceReserves(p: Pick<ProjectRowLike, "phase" | "virtualBnb" | "virtualToken" | "poolReserveBnb" | "poolReserveToken">): { x: bigint; y: bigint; source: "curve" | "pool" } {
  if (p.phase >= 2 && p.poolReserveBnb && p.poolReserveToken && BigInt(p.poolReserveToken) > 0n) {
    return { x: BigInt(p.poolReserveBnb), y: BigInt(p.poolReserveToken), source: "pool" };
  }
  return { x: BigInt(p.virtualBnb), y: BigInt(p.virtualToken), source: "curve" };
}

export interface ProjectAgg {
  vol24: bigint;
  trades24: number;
  holders: number;
  change24Bps: number | null;
}

export interface ProjectExtras {
  launcherAgentId: string | null;
  launchTx: string | null;
  now: number;
}

/** = BondingNFT.promotionStage(): 0 trading, 1 first hour, 2 extended, 3 force-graduation allowed, 4 graduated. */
export function promotionStage(p: Pick<ProjectRowLike, "phase" | "promotionStart">, now: number): number {
  if (p.phase >= 2) return 4;
  if (p.phase === 0 || p.promotionStart == null) return 0;
  if (now < p.promotionStart + PROMOTION_WINDOW) return 1;
  if (now < p.promotionStart + PROMOTION_MAX) return 2;
  return 3;
}

/** spotPrice() = wei per 1 whole token (1e18 units). */
export function spotPriceWei(virtualBnb: string, virtualToken: string): bigint {
  return (BigInt(virtualBnb) * 10n ** 18n) / BigInt(virtualToken);
}

/** `ProjectSummary` (SDK) / `Project` (FE). */
export function toProjectSummary(p: ProjectRowLike, agg: ProjectAgg, x: ProjectExtras) {
  const px = priceReserves(p);
  const vb = px.x;
  const vt = px.y;
  return {
    address: p.address,
    token: p.token,
    launcher: p.launcher,
    launcherAgentId: x.launcherAgentId,
    name: p.name,
    symbol: p.symbol,
    baseURI: p.baseUri,
    index: p.idx,
    launchedAt: p.createdAt,
    launchBlock: String(p.createdBlock),
    launchTx: x.launchTx,
    phase: PHASES[p.phase] ?? "trading",
    promotionStage: promotionStage(p, x.now),
    totalSupply: String(p.sold), // curve NFTs in circulation (minted − burned)
    virtualBnb: p.virtualBnb,
    virtualToken: p.virtualToken,
    reserveBnb: p.reserveBnb,
    feeBps: DEFAULT_FEE_BPS,
    spotPriceWei: ((vb * 10n ** 18n) / vt).toString(), // curve spot; PancakeSwap pair price after graduation
    progressBps: Math.floor((Math.min(p.sold, MAX_CURVE_NFTS) * 10_000) / MAX_CURVE_NFTS),
    holders: agg.holders,
    volumeBnb24h: agg.vol24.toString(),
    pair: p.pair,
    story: (p.story ?? null) as string | null, // from <baseURI>collection.json (null until fetched)
    image: (p.image ?? null) as string | null, // cover image (gateway URL)
    collectionUri: `${p.baseUri}collection.json`,
    promotionStart: p.promotionStart,
    graduatedAt: p.graduatedAt,
    updatedAt: Math.max(p.createdAt, p.lastTradeAt ?? 0, p.promotionStart ?? 0, p.graduatedAt ?? 0),
    // frontend-only / optional
    change24hBps: agg.change24Bps,
    marketCapBnb: ((vb * TOTAL_SUPPLY_TOKENS) / vt).toString(),
    trades24h: agg.trades24,
    // backend extras (harmless to clients)
    tag: p.tag,
    nftPriceWei: p.priceWei, // spot price per NFT (80,000 tokens)
    volumeBnb: p.volumeWei, // all-time curve volume
    tradeCount: p.tradeCount,
    lastTradeAt: p.lastTradeAt,
    liveSupply: p.supply, // all live NFTs, incl. post-graduation deposits
    forcedGraduation: p.forced,
    priceSource: px.source, // curve | pool
    pool: p.phase >= 2 && p.poolReserveBnb ? { reserveBnb: p.poolReserveBnb, reserveToken: p.poolReserveToken ?? "0", updatedAt: p.poolUpdatedAt ?? null } : null,
  };
}
export type ProjectSummaryDto = ReturnType<typeof toProjectSummary>;

/** Minimal trade row shape (the `trades` table). */
export interface TradeRowLike {
  id: string; project: string; trader: string; side: string; count: number; bnbWei: string; feeWei: string; priceWei: string;
  firstTokenId: number | null; blockNumber: number; logIndex: number; txHash: string; ts: number;
}

/** FE `Trade` (superset of the SDK `recentTrades[]` item). `name`/`symbol` are included when known. */
export function toTrade(r: TradeRowLike, o: { agentId?: string | null; name?: string | null; symbol?: string | null } = {}) {
  return {
    id: r.id,
    tx: r.txHash,
    project: r.project,
    ...(o.name !== undefined ? { name: o.name } : {}),
    ...(o.symbol !== undefined ? { symbol: o.symbol } : {}),
    wallet: r.trader,
    agentId: o.agentId ?? null,
    side: r.side === "buy" ? ("mint" as const) : ("burn" as const),
    count: r.count,
    bnb: r.bnbWei, // mint: Minted.cost (excl. fee); burn: Burned.gross
    fee: r.feeWei,
    at: r.ts,
    // extras
    blockNumber: String(r.blockNumber),
    logIndex: r.logIndex,
    firstTokenId: r.firstTokenId,
    nftPriceWei: r.priceWei, // spot price per NFT after the trade
    venue: "curve" as "curve" | "pool",
  };
}

/** Minimal pool swap row shape (the `pool_swaps` table). */
export interface PoolSwapRowLike {
  id: string; project: string; trader: string; side: string; bnbWei: string; tokenWei: string; priceWei: string;
  blockNumber: number; logIndex: number; txHash: string; ts: number;
}

/**
 * A PancakeSwap swap of a graduated project, in the FE `Trade` shape (ticker / trades feeds): side mint = buy,
 * burn = sell, count = NFT-equivalent (tokens / 80,000, floored), fee "0" (the 0.25% LP fee is inside the amounts).
 */
export function poolSwapToTrade(r: PoolSwapRowLike, o: { agentId?: string | null; name?: string | null; symbol?: string | null } = {}) {
  return {
    id: r.id,
    tx: r.txHash,
    project: r.project,
    ...(o.name !== undefined ? { name: o.name } : {}),
    ...(o.symbol !== undefined ? { symbol: o.symbol } : {}),
    wallet: r.trader,
    agentId: o.agentId ?? null,
    side: r.side === "buy" ? ("mint" as const) : ("burn" as const),
    count: Number(BigInt(r.tokenWei) / TOKENS_PER_NFT_WEI),
    bnb: r.bnbWei,
    fee: "0",
    at: r.ts,
    blockNumber: String(r.blockNumber),
    logIndex: r.logIndex,
    firstTokenId: null as number | null,
    nftPriceWei: r.priceWei,
    venue: "pool" as "curve" | "pool",
    tokens: r.tokenWei,
  };
}
export type TradeDto = ReturnType<typeof toTrade>;
