/**
 * Platform stats (GET /v1/stats), incl. the charity counter shown on the site:
 *   20% of every curve trading fee (BondingNFT -> FeeSplitter.distribute) is credited to Binance Charity
 *   (FeeSplitter.charity, immutable) and paid out by the permissionless FeeSplitter.flushCharity().
 * totalDonatedWei = FeeSplitter.totalDonated() (cumulative credits = flushed + pending) when the splitter is
 * reachable; otherwise derived from indexed curve trades (floor(fee * 2000 / 10000) per trade — the same
 * per-trade rounding as BondingNFT._distributeFee).
 */
import type { Address } from "viem";
import type { AppContext } from "../context.js";
import { FeeSplitterAbi } from "../chain/abi.js";

/** Binance Charity main wallet on BSC (FeeSplitter constructor default in contracts/scripts/deploy.ts). */
export const BINANCE_CHARITY = "0x8b99f3660622e21f2910ecca7fbe51d654a1517d";
/** LaunchFactory.CHARITY_SHARE_BPS: charity share of the trading fee, frozen into every project at launch. */
export const CHARITY_SHARE_BPS = 2000;
const BPS = 10_000n;

export interface PlatformStats {
  projects: number;
  graduated: number;
  trades: number;
  volumeWei: string;
  feesWei: string;
  charity: {
    address: string;
    shareBps: number;
    totalDonatedWei: string;
    flushedWei: string | null;
    pendingWei: string | null;
    source: "chain" | "index";
  };
  updatedAt: number;
}

/** Charity amount credited by the contract for one trade fee. */
export const charityOf = (feeWei: bigint, bps = CHARITY_SHARE_BPS) => (feeWei * BigInt(bps)) / BPS;

let cache: { at: number; key: unknown; v: PlatformStats } | null = null;

async function readChain(ctx: AppContext, splitter: Address) {
  const read = (functionName: "totalDonated" | "totalFlushed" | "charityBalance" | "charity") =>
    ctx.pc.readContract({ address: splitter, abi: FeeSplitterAbi, functionName }) as Promise<bigint | string>;
  const [donated, flushed, pending, charity] = await Promise.all([read("totalDonated"), read("totalFlushed"), read("charityBalance"), read("charity")]);
  return { donated: donated as bigint, flushed: flushed as bigint, pending: pending as bigint, charity: String(charity).toLowerCase() };
}

export async function platformStats(ctx: AppContext, opts: { maxAgeMs?: number } = {}): Promise<PlatformStats> {
  const maxAge = opts.maxAgeMs ?? 10_000;
  if (cache && cache.key === ctx && Date.now() - cache.at < maxAge) return cache.v;
  const { db, t } = ctx.database;
  const projects = await db.select({ phase: t.projects.phase, volumeWei: t.projects.volumeWei }).from(t.projects);
  const trades = await db.select({ fee: t.trades.feeWei }).from(t.trades);
  let fees = 0n, indexDonated = 0n;
  for (const r of trades) {
    const f = BigInt(r.fee);
    fees += f;
    indexDonated += charityOf(f);
  }
  const charity: PlatformStats["charity"] = {
    address: BINANCE_CHARITY, shareBps: CHARITY_SHARE_BPS, totalDonatedWei: indexDonated.toString(), flushedWei: null, pendingWei: null, source: "index",
  };
  const splitter = ctx.addresses?.feeSplitter;
  if (splitter && ctx.pc) {
    try {
      const c = await readChain(ctx, splitter);
      Object.assign(charity, { address: c.charity, totalDonatedWei: c.donated.toString(), flushedWei: c.flushed.toString(), pendingWei: c.pending.toString(), source: "chain" });
    } catch (e) {
      ctx.log.warn({ err: (e as Error).message.slice(0, 120) }, "stats: FeeSplitter read failed, using indexed trades");
    }
  }
  const v: PlatformStats = {
    projects: projects.length,
    graduated: projects.filter((p) => p.phase === 2).length,
    trades: trades.length,
    volumeWei: projects.reduce((a, p) => a + BigInt(p.volumeWei), 0n).toString(),
    feesWei: fees.toString(),
    charity,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  cache = { at: Date.now(), key: ctx, v };
  return v;
}
