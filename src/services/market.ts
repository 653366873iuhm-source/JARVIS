import { isHiddenActivity, isHiddenProject, isHiddenWallet } from "./hidden.js";
import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { MAX_CURVE_NFTS, TOKENS_PER_NFT, VIRTUAL_BNB0, VIRTUAL_TOKEN0, nftPrice } from "../lib/curve.js";
const INITIAL_NFT_PRICE = nftPrice(VIRTUAL_BNB0, VIRTUAL_TOKEN0);
import { PHASES, poolSwapToTrade, toProjectSummary, toTrade, type ProjectSummaryDto } from "../api/mappers.js";
import { lc } from "../lib/util.js";
import { clockNow } from "./indexer.js";
import { ApiError } from "./registration.js";
import { BondingNFTAbi } from "../chain/abi.js";
import { emptyRarities, rarityByOwner } from "../api/routes/frontend.js";

export const FILTERS: Record<string, string> = {
  hot: "hot", 热门: "hot",
  new: "new", 最新: "new",
  almost: "almost", 即将打满: "almost",
  promotion: "promotion", 推广关卡中: "promotion",
  graduated: "graduated", 已上链: "graduated",
  all: "all",
};
export const SORTS = ["created", "volume24h", "marketcap", "progress", "trades24h", "holders", "lastTrade"] as const;
export type Sort = (typeof SORTS)[number];
/** Client sort names (SDK: new|progress|volume; FE: mcap|new|progress|volume) -> backend sort. */
export const SORT_ALIASES: Record<string, Sort> = { new: "created", volume: "volume24h", mcap: "marketcap" };
export const DEFAULT_LIMIT = 60;
export const MAX_LIMIT = 100;

/** Opaque cursor = base64url("o:<offset>"). Plain integers are accepted too. */
export function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`).toString("base64url");
}
export function decodeCursor(c: string | undefined): number | undefined {
  if (c === undefined || c === "") return undefined;
  if (/^\d+$/.test(c)) return Number(c);
  const m = Buffer.from(c, "base64url").toString().match(/^o:(\d+)$/);
  if (!m) throw new ApiError(400, "bad_cursor", "invalid cursor");
  return Number(m[1]);
}
const ALMOST_BPS = 7000; // 即将打满: >= 70% of the curve sold

type ProjectRow = Awaited<ReturnType<typeof loadProjects>>[number];

async function loadProjects(ctx: AppContext) {
  const { db, t } = ctx.database;
  return db.select().from(t.projects);
}

async function aggregates(ctx: AppContext, now: number) {
  const { db, t } = ctx.database;
  const since = now - 86400;
  const recent = await db
    .select({ project: t.trades.project, bnb: t.trades.bnbWei, price: t.trades.priceWei, ts: t.trades.ts, li: t.trades.logIndex })
    .from(t.trades)
    .where(gte(t.trades.ts, since));
  const recentPool = await db
    .select({ project: t.poolSwaps.project, bnb: t.poolSwaps.bnbWei, price: t.poolSwaps.priceWei, ts: t.poolSwaps.ts })
    .from(t.poolSwaps)
    .where(gte(t.poolSwaps.ts, since));
  const vol = new Map<string, { vol24: bigint; trades24: number }>();
  for (const r of [...recent, ...recentPool]) {
    const v = vol.get(r.project) ?? { vol24: 0n, trades24: 0 };
    v.vol24 += BigInt(r.bnb);
    v.trades24++;
    vol.set(r.project, v);
  }
  // price 24h ago = price after the last trade before `since`
  const before = await db
    .select({ project: t.trades.project, price: t.trades.priceWei, ts: t.trades.ts })
    .from(t.trades)
    .where(lt(t.trades.ts, since));
  const beforePool = await db
    .select({ project: t.poolSwaps.project, price: t.poolSwaps.priceWei, ts: t.poolSwaps.ts })
    .from(t.poolSwaps)
    .where(lt(t.poolSwaps.ts, since));
  const prev = new Map<string, { ts: number; price: bigint }>();
  for (const r of [...before, ...beforePool]) {
    const c = prev.get(r.project);
    if (!c || r.ts >= c.ts) prev.set(r.project, { ts: r.ts, price: BigInt(r.price) });
  }
  const holders = new Map<string, number>();
  const h = await db
    .select({ project: t.nftTokens.project, n: sql<number>`count(distinct ${t.nftTokens.owner})` })
    .from(t.nftTokens)
    .groupBy(t.nftTokens.project);
  for (const r of h) holders.set(r.project, Number(r.n));
  return { vol, prev, holders };
}

async function agentIds(ctx: AppContext) {
  const { db, t } = ctx.database;
  return new Map((await db.select({ w: t.agents.wallet, id: t.agents.agentId }).from(t.agents)).map((r) => [r.w, r.id] as const));
}

/** project address -> tx hash of its factory `Launched` event. */
async function launchTxs(ctx: AppContext, only?: string) {
  const { db, t } = ctx.database;
  const rows = await db.select({ args: t.chainEvents.args, tx: t.chainEvents.txHash }).from(t.chainEvents).where(eq(t.chainEvents.name, "Launched"));
  const out = new Map<string, string>();
  for (const r of rows) {
    try {
      const a = JSON.parse(r.args);
      const proj = typeof a.project === "string" ? lc(a.project) : null;
      if (proj && (!only || proj === only)) out.set(proj, r.tx);
    } catch {
      /* malformed args: skip */
    }
  }
  return out;
}

function change24(p: ProjectRow, agg: Awaited<ReturnType<typeof aggregates>>) {
  // no trade before the window -> the price 24h ago was still the launch price (curve untouched)
  const prev = agg.prev.get(p.address)?.price ?? INITIAL_NFT_PRICE;
  const cur = BigInt(p.priceWei);
  return prev > 0n ? Number(((cur - prev) * 10_000n) / prev) : 0;
}

function summarize(p: ProjectRow, agg: Awaited<ReturnType<typeof aggregates>>, ids: Map<string, string>, txs: Map<string, string>, now: number): ProjectSummaryDto {
  const v = agg.vol.get(p.address);
  return toProjectSummary(
    p,
    { vol24: v?.vol24 ?? 0n, trades24: v?.trades24 ?? 0, holders: agg.holders.get(p.address) ?? 0, change24Bps: change24(p, agg) },
    { launcherAgentId: ids.get(p.launcher) ?? null, launchTx: txs.get(p.address) ?? null, now },
  );
}

export interface ListProjectsQuery {
  filter?: string; phase?: string; sort?: string; order?: string; limit?: number; offset?: number; cursor?: string;
  since?: number; search?: string; launcher?: string;
}

export async function listProjects(ctx: AppContext, q: ListProjectsQuery) {
  const filter = FILTERS[q.filter ?? "all"] ?? "all";
  if (q.phase !== undefined && q.phase !== "" && !(PHASES as readonly string[]).includes(q.phase)) {
    throw new ApiError(400, "bad_phase", "phase must be trading | promotion | graduated");
  }
  const now = await clockNow(ctx);
  const [rows, agg, ids, txs] = await Promise.all([loadProjects(ctx), aggregates(ctx, now), agentIds(ctx), launchTxs(ctx)]);
  // test projects (HIDE_PROJECTS) are left out of public lists unless searched for by exact address
  let items = rows.filter((p) => !isHiddenProject(ctx.cfg, p.address)).map((p) => summarize(p, agg, ids, txs, now));
  if (q.search) {
    const s = q.search.toLowerCase();
    items = items.filter((p) => p.name.toLowerCase().includes(s) || p.symbol.toLowerCase().includes(s) || p.address === s || (p.launcherAgentId ?? "").includes(s));
  }
  if (q.launcher) items = items.filter((p) => p.launcher === lc(q.launcher!));
  if (q.phase) items = items.filter((p) => p.phase === q.phase);
  if (q.since !== undefined && Number.isFinite(q.since)) items = items.filter((p) => p.launchedAt >= q.since!);
  let defaultSort: Sort = "created";
  switch (filter) {
    case "hot":
      // FE contract (frontend/API_CONTRACT.md): hot = every project (graduated included), default sort 24h volume
      defaultSort = "volume24h";
      break;
    case "new":
      // FE contract: new = trading only (King of the hill = filter=new&sort=progress&limit=1)
      items = items.filter((p) => p.phase === "trading");
      defaultSort = "created";
      break;
    case "almost":
      items = items.filter((p) => p.phase === "trading" && p.progressBps >= ALMOST_BPS);
      defaultSort = "progress";
      break;
    case "promotion":
      items = items.filter((p) => p.phase === "promotion");
      defaultSort = "created";
      break;
    case "graduated":
      items = items.filter((p) => p.phase === "graduated");
      defaultSort = "marketcap";
      break;
  }
  const requested = q.sort ? (SORT_ALIASES[q.sort] ?? q.sort) : "";
  const sort: Sort = (SORTS as readonly string[]).includes(requested) ? (requested as Sort) : defaultSort;
  const key = (p: ProjectSummaryDto): bigint => {
    switch (sort) {
      case "volume24h": return BigInt(p.volumeBnb24h);
      case "marketcap": return BigInt(p.marketCapBnb);
      case "progress": return BigInt(p.progressBps);
      case "trades24h": return BigInt(p.trades24h);
      case "holders": return BigInt(p.holders);
      case "lastTrade": return BigInt(p.lastTradeAt ?? 0);
      default: return BigInt(p.launchedAt) * 1_000_000n + BigInt(p.index);
    }
  };
  const dir = q.order === "asc" ? 1 : -1;
  items.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka === kb ? 0 : ka < kb ? -dir : dir;
  });
  const limit = Math.min(Math.max(Math.floor(q.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(decodeCursor(q.cursor) ?? q.offset ?? 0, 0);
  const page = items.slice(offset, offset + limit);
  const nextCursor = offset + limit < items.length ? encodeCursor(offset + limit) : null;
  return { filter, sort, order: dir === 1 ? "asc" : "desc", total: items.length, items: page, nextCursor };
}

const TOP_HOLDERS = 10;
const DETAIL_TRADES = 20;
const firstPostGradCache = new Map<string, string>();

/** BondingNFT.firstPostGradId() (only meaningful once graduated; not indexed, read from chain and cached). */
async function firstPostGradId(ctx: AppContext, p: ProjectRow): Promise<string | null> {
  if (p.phase < 2) return null;
  const hit = firstPostGradCache.get(p.address);
  if (hit) return hit;
  try {
    const v = (await ctx.pc.readContract({ address: p.address as `0x${string}`, abi: BondingNFTAbi, functionName: "firstPostGradId" })) as bigint;
    const s = v.toString();
    firstPostGradCache.set(p.address, s);
    return s;
  } catch (e) {
    ctx.log.warn({ project: p.address, err: String(e) }, "firstPostGradId read failed");
    return null;
  }
}

export async function projectDetail(ctx: AppContext, address: string) {
  const { db, t } = ctx.database;
  const [p] = await db.select().from(t.projects).where(eq(t.projects.address, lc(address)));
  if (!p) throw new ApiError(404, "not_found", "unknown project");
  const now = await clockNow(ctx);
  const [agg, ids, txs] = await Promise.all([aggregates(ctx, now), agentIds(ctx), launchTxs(ctx, p.address)]);
  const dto = summarize(p, agg, ids, txs, now);

  const [holderRows, tradeRows, atts, posts, events, fpg] = await Promise.all([
    db.select({ owner: t.nftTokens.owner, n: sql<number>`count(*)` }).from(t.nftTokens).where(eq(t.nftTokens.project, p.address)).groupBy(t.nftTokens.owner),
    db.select().from(t.trades).where(eq(t.trades.project, p.address)).orderBy(desc(t.trades.blockNumber), desc(t.trades.logIndex)).limit(DETAIL_TRADES),
    db.select().from(t.attestations).where(eq(t.attestations.project, p.address)).orderBy(desc(t.attestations.nonce)),
    db.select({ s: t.xPosts.gateStatus }).from(t.xPosts).where(eq(t.xPosts.project, p.address)),
    db.select().from(t.chainEvents).where(and(eq(t.chainEvents.address, p.address), inArray(t.chainEvents.name, ["PromotionStarted", "PromotionAttested", "Graduated"]))).orderBy(desc(t.chainEvents.blockNumber)).limit(200),
    firstPostGradId(ctx, p),
  ]);
  const holders = holderRows.map((r) => ({ wallet: r.owner, count: Number(r.n) })).sort((a, b) => b.count - a.count || (a.wallet < b.wallet ? -1 : 1));
  const launcherHoldings = holders.find((h) => h.wallet === p.launcher)?.count ?? 0;

  // promoter set of the latest attestation that reached chain (else the latest signed one)
  const latest = atts.find((a) => a.status === "submitted" && a.txHash) ?? atts[0];
  let promoterCount = 0;
  if (latest) {
    try {
      promoterCount = (JSON.parse(latest.promoters) as unknown[]).length;
    } catch {
      promoterCount = 0;
    }
  }
  const promotion =
    p.phase === 0 && p.promotionStart == null
      ? null
      : {
          shareBps: p.lastShareBps,
          promoterCount,
          postCount: posts.filter((x) => x.s === "accepted").length, // gate-accepted posts
          promoterRoot: p.promoterRoot ?? null,
          attestations: atts
            .filter((a) => a.txHash)
            .map((a) => ({ nonce: a.nonce, shareBps: a.shareBps, promoterRoot: a.root, tx: a.txHash!, at: a.createdAt })),
        };
  const lifecycle = events.map((e) => ({ name: e.name, args: JSON.parse(e.args), ts: e.ts, txHash: e.txHash }));
  return {
    ...dto,
    launcherHoldings,
    firstPostGradId: fpg,
    promotion,
    topHolders: holders.slice(0, TOP_HOLDERS),
    recentTrades: tradeRows.map((r) => toTrade(r, { agentId: ids.get(r.trader) ?? null })),
    // backend extras
    tokensPerNft: TOKENS_PER_NFT.toString(),
    maxCurveNfts: MAX_CURVE_NFTS,
    lifecycle,
  };
}

export async function projectTrades(ctx: AppContext, address: string, q: { limit?: number; before?: number; trader?: string }) {
  const { db, t } = ctx.database;
  const conds = [eq(t.trades.project, lc(address))];
  if (q.before) conds.push(lt(t.trades.ts, q.before));
  if (q.trader) conds.push(eq(t.trades.trader, lc(q.trader)));
  const lim = Math.min(q.limit ?? 50, 200);
  const pconds = [eq(t.poolSwaps.project, lc(address))];
  if (q.before) pconds.push(lt(t.poolSwaps.ts, q.before));
  if (q.trader) pconds.push(eq(t.poolSwaps.trader, lc(q.trader)));
  const [rows, swaps] = await Promise.all([
    db.select().from(t.trades).where(and(...conds)).orderBy(desc(t.trades.blockNumber), desc(t.trades.logIndex)).limit(lim),
    db.select().from(t.poolSwaps).where(and(...pconds)).orderBy(desc(t.poolSwaps.blockNumber), desc(t.poolSwaps.logIndex)).limit(lim),
  ]);
  const [ids, [p]] = await Promise.all([agentIds(ctx), db.select({ name: t.projects.name, symbol: t.projects.symbol }).from(t.projects).where(eq(t.projects.address, lc(address)))]);
  const o = (w: string) => ({ agentId: ids.get(w) ?? null, name: p?.name ?? null, symbol: p?.symbol ?? null });
  return mergeNewestFirst(rows.map((r) => ({ k: r, v: toTrade(r, o(r.trader)) })), swaps.map((r) => ({ k: r, v: poolSwapToTrade(r, o(r.trader)) })), lim);
}

/** Newest-first merge of curve trades and pool swaps by (block, logIndex). */
function mergeNewestFirst<T>(a: { k: { blockNumber: number; logIndex: number }; v: T }[], b: { k: { blockNumber: number; logIndex: number }; v: T }[], limit: number): T[] {
  return [...a, ...b]
    .sort((x, y) => (y.k.blockNumber - x.k.blockNumber) || (y.k.logIndex - x.k.logIndex))
    .slice(0, limit)
    .map((x) => x.v);
}

/** Site-wide feed (ticker): curve mints/burns + PancakeSwap swaps of graduated projects, newest first. */
export async function recentTrades(ctx: AppContext, limit = 30) {
  const { db, t } = ctx.database;
  const lim = Math.min(limit, 100);
  const [rows, swaps] = await Promise.all([
    db
      .select({ tr: t.trades, symbol: t.projects.symbol, name: t.projects.name })
      .from(t.trades)
      .innerJoin(t.projects, eq(t.projects.address, t.trades.project))
      .orderBy(desc(t.trades.blockNumber), desc(t.trades.logIndex))
      .limit(lim + 50),
    db
      .select({ sw: t.poolSwaps, symbol: t.projects.symbol, name: t.projects.name })
      .from(t.poolSwaps)
      .innerJoin(t.projects, eq(t.projects.address, t.poolSwaps.project))
      .orderBy(desc(t.poolSwaps.blockNumber), desc(t.poolSwaps.logIndex))
      .limit(lim + 50),
  ]);
  const ids = await agentIds(ctx);
  return mergeNewestFirst(
    rows.filter((r) => !isHiddenActivity(ctx.cfg, r.tr.project, r.tr.trader)).map((r) => ({ k: r.tr, v: toTrade(r.tr, { agentId: ids.get(r.tr.trader) ?? null, name: r.name, symbol: r.symbol }) })),
    swaps.filter((r) => !isHiddenActivity(ctx.cfg, r.sw.project, r.sw.trader)).map((r) => ({ k: r.sw, v: poolSwapToTrade(r.sw, { agentId: ids.get(r.sw.trader) ?? null, name: r.name, symbol: r.symbol }) })),
    lim,
  );
}

export async function projectHolders(ctx: AppContext, address: string, limit = 50) {
  const { db, t } = ctx.database;
  const addr = lc(address);
  const [p] = await db.select().from(t.projects).where(eq(t.projects.address, addr));
  if (!p) throw new ApiError(404, "not_found", "unknown project");
  const rows = await db
    .select({ owner: t.nftTokens.owner, n: sql<number>`count(*)` })
    .from(t.nftTokens)
    .where(eq(t.nftTokens.project, addr))
    .groupBy(t.nftTokens.owner);
  const [ids, rar] = await Promise.all([agentIds(ctx), rarityByOwner(ctx, addr)]);
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  return {
    total,
    holders: rows
      .map((r) => ({
        rarities: rar.get(r.owner) ?? emptyRarities(),
        wallet: r.owner, agentId: ids.get(r.owner) ?? null, nfts: Number(r.n), shareBps: total ? Math.floor((Number(r.n) * 10_000) / total) : 0,
        isLauncher: r.owner === p.launcher, isPlatform: ctx.cfg.PLATFORM_ADDRESSES.includes(r.owner),
      }))
      .sort((a, b) => b.nfts - a.nfts)
      .slice(0, Math.min(limit, 500)),
  };
}

const INTERVALS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

/** OHLCV candles of the per-NFT price (price after each trade); volume = curve BNB. */
export async function candles(ctx: AppContext, address: string, q: { interval?: string; from?: number; to?: number }) {
  const { db, t } = ctx.database;
  const step = INTERVALS[q.interval ?? "5m"] ?? 300;
  const to = q.to ?? (await clockNow(ctx));
  const from = q.from ?? to - step * 300;
  if ((to - from) / step > 5000) throw new ApiError(400, "range_too_large", "max 5000 candles per request");
  const [curveRows, poolRows] = await Promise.all([
    db
      .select({ ts: t.trades.ts, price: t.trades.priceWei, bnb: t.trades.bnbWei, li: t.trades.logIndex, bn: t.trades.blockNumber })
      .from(t.trades)
      .where(and(eq(t.trades.project, lc(address)), gte(t.trades.ts, from), lte(t.trades.ts, to))),
    // after graduation the price comes from the PancakeSwap pair (price after each swap)
    db
      .select({ ts: t.poolSwaps.ts, price: t.poolSwaps.priceWei, bnb: t.poolSwaps.bnbWei, li: t.poolSwaps.logIndex, bn: t.poolSwaps.blockNumber })
      .from(t.poolSwaps)
      .where(and(eq(t.poolSwaps.project, lc(address)), gte(t.poolSwaps.ts, from), lte(t.poolSwaps.ts, to))),
  ]);
  const rows = [...curveRows, ...poolRows].sort((a, b) => a.bn - b.bn || a.li - b.li);
  const out: { t: number; o: string; h: string; l: string; c: string; v: string; n: number }[] = [];
  let cur: { t: number; o: bigint; h: bigint; l: bigint; c: bigint; v: bigint; n: number } | null = null;
  for (const r of rows) {
    const b = Math.floor(r.ts / step) * step;
    const p = BigInt(r.price);
    if (!cur || cur.t !== b) {
      if (cur) out.push({ t: cur.t, o: cur.o.toString(), h: cur.h.toString(), l: cur.l.toString(), c: cur.c.toString(), v: cur.v.toString(), n: cur.n });
      cur = { t: b, o: p, h: p, l: p, c: p, v: 0n, n: 0 };
    }
    cur.h = p > cur.h ? p : cur.h;
    cur.l = p < cur.l ? p : cur.l;
    cur.c = p;
    cur.v += BigInt(r.bnb);
    cur.n++;
  }
  if (cur) out.push({ t: cur.t, o: cur.o.toString(), h: cur.h.toString(), l: cur.l.toString(), c: cur.c.toString(), v: cur.v.toString(), n: cur.n });
  return { interval: q.interval ?? "5m", step, from, to, candles: out };
}

let lbCache: { at: number; data: any[] } | null = null;

/**
 * Agent leaderboard. Per (agent, project): PnL = sell proceeds (net of fee) + current NFTs × spot price per NFT
 * − buy cost (incl. fee). Win rate = projects with PnL > 0 / projects traded. Graduations = launched projects that
 * graduated. Promo posts = gate-accepted posts + other tagged posts.
 */
export async function leaderboard(ctx: AppContext, q: { sort?: string; limit?: number }) {
  if (!lbCache || Date.now() - lbCache.at > 15_000) {
    const { db, t } = ctx.database;
    const [agents, projects, trades, holdings, posts] = await Promise.all([
      db.select().from(t.agents),
      db.select().from(t.projects),
      db.select({ p: t.trades.project, w: t.trades.trader, side: t.trades.side, bnb: t.trades.bnbWei, fee: t.trades.feeWei }).from(t.trades),
      db.select({ p: t.nftTokens.project, w: t.nftTokens.owner, n: sql<number>`count(*)` }).from(t.nftTokens).groupBy(t.nftTokens.project, t.nftTokens.owner),
      db.select({ w: t.xPosts.wallet, s: t.xPosts.gateStatus }).from(t.xPosts),
    ]);
    const price = new Map(projects.map((p) => [p.address, BigInt(p.priceWei)] as const));
    const pos = new Map<string, Map<string, bigint>>(); // wallet -> project -> pnl accumulator
    const add = (w: string, p: string, v: bigint) => {
      if (!pos.has(w)) pos.set(w, new Map());
      const m = pos.get(w)!;
      m.set(p, (m.get(p) ?? 0n) + v);
    };
    let volume = new Map<string, bigint>();
    for (const tr of trades) {
      if (isHiddenProject(ctx.cfg, tr.p)) continue;
      const bnb = BigInt(tr.bnb);
      const fee = BigInt(tr.fee);
      add(tr.w, tr.p, tr.side === "buy" ? -(bnb + fee) : bnb - fee);
      volume.set(tr.w, (volume.get(tr.w) ?? 0n) + bnb);
    }
    for (const h of holdings) if (pos.get(h.w)?.has(h.p)) add(h.w, h.p, BigInt(Number(h.n)) * (price.get(h.p) ?? 0n));
    const promo = new Map<string, number>();
    for (const p of posts) promo.set(p.w, (promo.get(p.w) ?? 0) + (p.s === "duplicate_text" ? 0 : 1));
    const data = agents
      .filter((a) => !a.removed && !isHiddenWallet(ctx.cfg, a.wallet))
      .map((a) => {
        const launched = projects.filter((p) => p.launcher === a.wallet && !isHiddenProject(ctx.cfg, p.address));
        const m = pos.get(a.wallet) ?? new Map<string, bigint>();
        let pnl = 0n;
        let wins = 0;
        for (const v of m.values()) {
          pnl += v;
          if (v > 0n) wins++;
        }
        return {
          wallet: a.wallet, agentId: a.agentId, xHandle: a.xHandle, launches: launched.length,
          graduations: launched.filter((p) => p.phase === 2).length, pnlWei: pnl.toString(), projectsTraded: m.size,
          winRateBps: m.size ? Math.floor((wins * 10_000) / m.size) : 0, volumeWei: (volume.get(a.wallet) ?? 0n).toString(),
          promoPosts: promo.get(a.wallet) ?? 0,
        };
      });
    lbCache = { at: Date.now(), data };
  }
  const sort = q.sort ?? "pnl";
  const k = (r: any): bigint =>
    sort === "launches" ? BigInt(r.launches) : sort === "graduations" ? BigInt(r.graduations) : sort === "winrate" ? BigInt(r.winRateBps)
      : sort === "promo" ? BigInt(r.promoPosts) : sort === "volume" ? BigInt(r.volumeWei) : BigInt(r.pnlWei);
  const items = [...lbCache.data].sort((a, b) => (k(a) === k(b) ? 0 : k(a) < k(b) ? 1 : -1)).slice(0, Math.min(q.limit ?? 50, 200));
  return { sort, items: items.map((r, i) => ({ rank: i + 1, ...r })) };
}

export function invalidateLeaderboard() {
  lbCache = null;
}
