/**
 * Frontend-facing routes and list shapes (`frontend/API_CONTRACT.md`), fix-list items 7–9 of
 * `backend/API_RECONCILIATION.md`:
 *   GET /v1/projects/:address/holders      Holder[]            (handler wired in server.ts)
 *   GET /v1/projects/:address/candles      Candle[] (tf, BNB numbers, average fill price)
 *   GET /v1/ticker                         Trade[]  (alias of /v1/trades/recent)
 *   GET /v1/projects/:address/promotions   PromotionPost[]
 *   GET /v1/projects/:address/nfts         NftItem[]
 *   GET /v1/agents/leaderboard?range=      LeaderboardRow[]    (registered before /v1/agents/:query)
 *   GET /v1/stats                          PlatformStats (projects, volume, fees, charity.totalDonatedWei)
 *   GET /v1/agents/:query                  AgentProfile        (wallet or `.ai` id; replaces the old /v1/agents/:wallet)
 *   WS  /v1/ws                             subscribe messages + Trade payload (handleTradeSocket)
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { AppContext } from "../../context.js";
import { ApiError } from "../../services/registration.js";
import { listProjects, recentTrades } from "../../services/market.js";
import { platformStats } from "../../services/stats.js";
import { clockNow } from "../../services/indexer.js";
import { DEFAULT_FEE_BPS, PHASES, poolSwapToTrade, toTrade, type PoolSwapRowLike, type TradeRowLike } from "../mappers.js";
import { quoteSell } from "../../lib/curve.js";
import { isAddr, jsonStringify, lc } from "../../lib/util.js";

const num = (v: unknown) => (v === undefined || v === "" ? undefined : Number(v));
function addrParam(v: string) {
  if (!isAddr(v)) throw new ApiError(400, "bad_address", "invalid address");
  return lc(v);
}
const clampLimit = (v: number | undefined, def: number, max: number) => Math.min(Math.max(Math.floor(v ?? def) || def, 1), max);
const at = (h: string | null | undefined) => (h ? (h.startsWith("@") ? h : `@${h}`) : "");
/** wei (bigint) -> BNB as a JSON number (candles only; everything else stays a decimal string). */
export const weiToBnb = (w: bigint) => Number(w) / 1e18;

async function requireProject(ctx: AppContext, address: string) {
  const { db, t } = ctx.database;
  const [p] = await db.select().from(t.projects).where(eq(t.projects.address, address));
  if (!p) throw new ApiError(404, "not_found", "unknown project");
  return p;
}

async function agentMap(ctx: AppContext) {
  const { db, t } = ctx.database;
  const rows = await db.select({ w: t.agents.wallet, id: t.agents.agentId, x: t.agents.xHandle }).from(t.agents);
  return new Map(rows.map((r) => [r.w, { agentId: r.id, xHandle: r.x }] as const));
}

/** Promoter set of the latest attestation that reached chain (else the latest signed one). */
async function promoterSet(ctx: AppContext, project: string): Promise<Set<string>> {
  const { db, t } = ctx.database;
  const atts = await db.select().from(t.attestations).where(eq(t.attestations.project, project)).orderBy(desc(t.attestations.nonce));
  const latest = atts.find((a) => a.status === "submitted" && a.txHash) ?? atts[0];
  if (!latest) return new Set();
  try {
    return new Set((JSON.parse(latest.promoters) as string[]).map(lc));
  } catch {
    return new Set();
  }
}

// ------------------------------------------------------------------ holders (#11)
export const emptyRarities = () => ({ common: 0, rare: 0, epic: 0, legendary: 0 });
/** owner -> NFTs held per rarity (indexed by services/metadata.ts). */
export async function rarityByOwner(ctx: AppContext, project: string) {
  const { db, t } = ctx.database;
  const rows = await db
    .select({ owner: t.nftTokens.owner, rarity: t.nftTokens.rarity, n: sql<number>`count(*)` })
    .from(t.nftTokens)
    .where(eq(t.nftTokens.project, project))
    .groupBy(t.nftTokens.owner, t.nftTokens.rarity);
  const out = new Map<string, ReturnType<typeof emptyRarities>>();
  for (const r of rows) {
    if (!r.rarity || !(r.rarity in emptyRarities())) continue;
    const m = out.get(r.owner) ?? emptyRarities();
    (m as any)[r.rarity] += Number(r.n);
    out.set(r.owner, m);
  }
  return out;
}
export async function feHolders(ctx: AppContext, address: string, limit?: number) {
  const { db, t } = ctx.database;
  const p = await requireProject(ctx, address);
  const [rows, ids, promoters, rar] = await Promise.all([
    db.select({ owner: t.nftTokens.owner, n: sql<number>`count(*)` }).from(t.nftTokens).where(eq(t.nftTokens.project, p.address)).groupBy(t.nftTokens.owner),
    agentMap(ctx),
    promoterSet(ctx, p.address),
    rarityByOwner(ctx, p.address),
  ]);
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  return rows
    .map((r) => ({
      rarities: rar.get(r.owner) ?? emptyRarities(), // extra: NFTs held per rarity (pending VRF not counted)
      wallet: r.owner,
      agentId: ids.get(r.owner)?.agentId ?? null,
      count: Number(r.n),
      shareBps: total ? Math.floor((Number(r.n) * 10_000) / total) : 0,
      isLauncher: r.owner === p.launcher,
      isPromoter: promoters.has(r.owner),
      isPlatform: ctx.cfg.PLATFORM_ADDRESSES.includes(r.owner), // extra
    }))
    .sort((a, b) => b.count - a.count || (a.wallet < b.wallet ? -1 : 1))
    .slice(0, clampLimit(limit, 100, 500));
}

// ------------------------------------------------------------------ candles (#12)
export const CANDLE_TF: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
export const MAX_BARS = 200;
export interface FeCandle { t: number; o: number; h: number; l: number; c: number; v: number; n: number }

/**
 * Buckets trades (ascending) into candles: price = average fill per NFT (bnb / count) for curve trades, or the
 * given `px` (PancakeSwap pool price per NFT after the swap) for pool swaps; v = BNB volume.
 */
export function bucketCandles(rows: { ts: number; bnb: string; count: number; px?: string }[], step: number, maxBars = MAX_BARS): FeCandle[] {
  const out: { t: number; o: bigint; h: bigint; l: bigint; c: bigint; v: bigint; n: number }[] = [];
  for (const r of rows) {
    if (!r.count && r.px === undefined) continue;
    const b = Math.floor(r.ts / step) * step;
    const bnb = BigInt(r.bnb);
    const px = r.px !== undefined ? BigInt(r.px) : bnb / BigInt(r.count);
    let cur = out[out.length - 1];
    if (!cur || cur.t !== b) {
      cur = { t: b, o: px, h: px, l: px, c: px, v: 0n, n: 0 };
      out.push(cur);
    }
    if (px > cur.h) cur.h = px;
    if (px < cur.l) cur.l = px;
    cur.c = px;
    cur.v += bnb;
    cur.n++;
  }
  return out.slice(-maxBars).map((c) => ({ t: c.t, o: weiToBnb(c.o), h: weiToBnb(c.h), l: weiToBnb(c.l), c: weiToBnb(c.c), v: weiToBnb(c.v), n: c.n }));
}

export async function feCandles(ctx: AppContext, address: string, q: { tf?: string; from?: number; to?: number }) {
  const { db, t } = ctx.database;
  const tf = q.tf ?? "5m";
  const step = CANDLE_TF[tf];
  if (!step) throw new ApiError(400, "bad_tf", "tf must be 1m | 5m | 15m | 1h | 4h | 1d");
  await requireProject(ctx, address);
  const to = q.to ?? (await clockNow(ctx));
  const from = q.from ?? Math.floor(to / step) * step - step * (MAX_BARS - 1);
  const [curve, pool] = await Promise.all([
    db
      .select({ ts: t.trades.ts, bnb: t.trades.bnbWei, count: t.trades.count, bn: t.trades.blockNumber, li: t.trades.logIndex })
      .from(t.trades)
      .where(and(eq(t.trades.project, address), gte(t.trades.ts, from), lte(t.trades.ts, to))),
    // graduated: PancakeSwap V2 pair price after each swap
    db
      .select({ ts: t.poolSwaps.ts, bnb: t.poolSwaps.bnbWei, px: t.poolSwaps.priceWei, bn: t.poolSwaps.blockNumber, li: t.poolSwaps.logIndex })
      .from(t.poolSwaps)
      .where(and(eq(t.poolSwaps.project, address), gte(t.poolSwaps.ts, from), lte(t.poolSwaps.ts, to))),
  ]);
  const rows = [
    ...curve.map((r) => ({ ts: r.ts, bnb: r.bnb, count: r.count, bn: r.bn, li: r.li })),
    ...pool.map((r) => ({ ts: r.ts, bnb: r.bnb, count: 1, px: r.px, bn: r.bn, li: r.li })),
  ].sort((a, b) => a.bn - b.bn || a.li - b.li);
  return bucketCandles(rows, step);
}

// ------------------------------------------------------------------ promotions (#13)
export async function fePromotions(ctx: AppContext, address: string, limit?: number) {
  const { db, t } = ctx.database;
  const p = await requireProject(ctx, address);
  const [posts, ids, held] = await Promise.all([
    db.select().from(t.xPosts).where(eq(t.xPosts.project, p.address)).orderBy(desc(t.xPosts.createdAt)).limit(clampLimit(limit, 100, 500)),
    agentMap(ctx),
    db.select({ owner: t.nftTokens.owner, n: sql<number>`count(*)` }).from(t.nftTokens).where(eq(t.nftTokens.project, p.address)).groupBy(t.nftTokens.owner),
  ]);
  const holdings = new Map(held.map((h) => [h.owner, Number(h.n)] as const));
  return posts.map((x) => {
    const a = ids.get(x.wallet);
    const handle = a?.xHandle ? a.xHandle.replace(/^@/, "") : "";
    return {
      id: x.tweetId,
      agentId: a?.agentId ?? "",
      xHandle: at(handle),
      wallet: x.wallet,
      url: `https://x.com/${handle || "i"}/status/${x.tweetId}`,
      text: x.text,
      at: x.createdAt,
      holdings: holdings.get(x.wallet) ?? 0,
      likes: x.likes,
      reposts: x.reposts,
      verified: x.gateStatus === "accepted",
      status: x.gateStatus ?? null, // extra: promotion-gate verdict
    };
  });
}

// ------------------------------------------------------------------ nfts (#14)
export async function feNfts(ctx: AppContext, address: string, limit?: number) {
  const { db, t } = ctx.database;
  const p = await requireProject(ctx, address);
  const [rows, ids] = await Promise.all([
    db.select().from(t.nftTokens).where(eq(t.nftTokens.project, p.address)).orderBy(desc(t.nftTokens.tokenId)).limit(clampLimit(limit, 120, 500)),
    agentMap(ctx),
  ]);
  // image: the token's trait-layer image, else the collection cover; rarity: derived from the VRF trait seed
  // (null while VRF is pending or metadata not indexed yet). See services/metadata.ts.
  return rows.map((r) => ({
    tokenId: r.tokenId, owner: r.owner, agentId: ids.get(r.owner)?.agentId ?? null,
    image: (r.image ?? p.image ?? null) as string | null, rarity: (r.rarity ?? null) as string | null,
    traits: r.traits ? safeJson(r.traits) : null, // extra
  }));
}

// ------------------------------------------------------------------ PnL helpers
type TradeLite = { p: string; side: string; count: number; bnb: string; fee: string };

/** Average-cost book for one (wallet, project): buys add cost incl. fee; sells realise net − avg cost. */
export function costBook(trades: TradeLite[]) {
  let qty = 0n;
  let cost = 0n;
  let realized = 0n;
  for (const tr of trades) {
    const n = BigInt(tr.count);
    const bnb = BigInt(tr.bnb);
    const fee = BigInt(tr.fee);
    if (tr.side === "buy") {
      qty += n;
      cost += bnb + fee;
    } else {
      const basis = qty > 0n ? (cost * (n > qty ? qty : n)) / qty : 0n;
      realized += bnb - fee - basis;
      cost -= basis;
      qty = qty > n ? qty - n : 0n;
    }
  }
  return { qty, cost, realized };
}

/** Value of `count` NFTs: curve sell net while on the curve; last per-NFT price after graduation (pool not indexed). */
export function holdingValue(p: { phase: number; virtualBnb: string; virtualToken: string; priceWei: string }, count: number): bigint {
  if (count <= 0) return 0n;
  if (p.phase >= 2) return BigInt(p.priceWei) * BigInt(count);
  return quoteSell(BigInt(p.virtualBnb), BigInt(p.virtualToken), count, BigInt(DEFAULT_FEE_BPS)).net;
}

// ------------------------------------------------------------------ leaderboard (#15)
export const RANGES: Record<string, number | null> = { "24h": 86_400, "7d": 7 * 86_400, all: null };

/**
 * FE definition, per (agent, project) inside the window: sell net − buy total (incl. fee)
 * + max(0, net NFTs bought in the window) × current per-NFT spot price × 0.99.
 */
export async function feLeaderboard(ctx: AppContext, q: { range?: string; limit?: number }) {
  const range = q.range ?? "all";
  if (!(range in RANGES)) throw new ApiError(400, "bad_range", "range must be 24h | 7d | all");
  const { db, t } = ctx.database;
  const now = await clockNow(ctx);
  const span = RANGES[range];
  const since = span == null ? 0 : now - span;
  const [agents, projects, trades, posts] = await Promise.all([
    db.select().from(t.agents),
    db.select().from(t.projects),
    db.select({ p: t.trades.project, w: t.trades.trader, side: t.trades.side, count: t.trades.count, bnb: t.trades.bnbWei, fee: t.trades.feeWei }).from(t.trades).where(gte(t.trades.ts, since)),
    db.select({ w: t.xPosts.wallet, s: t.xPosts.gateStatus }).from(t.xPosts).where(gte(t.xPosts.createdAt, since)),
  ]);
  const price = new Map(projects.map((p) => [p.address, BigInt(p.priceWei)] as const));
  const book = new Map<string, Map<string, { flow: bigint; net: number }>>();
  for (const tr of trades) {
    let m = book.get(tr.w);
    if (!m) book.set(tr.w, (m = new Map()));
    const e = m.get(tr.p) ?? { flow: 0n, net: 0 };
    const bnb = BigInt(tr.bnb);
    const fee = BigInt(tr.fee);
    if (tr.side === "buy") {
      e.flow -= bnb + fee;
      e.net += tr.count;
    } else {
      e.flow += bnb - fee;
      e.net -= tr.count;
    }
    m.set(tr.p, e);
  }
  const promo = new Map<string, number>();
  for (const p of posts) if (p.s !== "duplicate_text") promo.set(p.w, (promo.get(p.w) ?? 0) + 1);
  const rows = agents
    .filter((a) => !a.removed)
    .map((a) => {
      const launched = projects.filter((p) => p.launcher === a.wallet);
      let pnl = 0n;
      let wins = 0;
      const m = book.get(a.wallet) ?? new Map();
      for (const [proj, e] of m) {
        const v = e.flow + (BigInt(Math.max(0, e.net)) * (price.get(proj) ?? 0n) * 99n) / 100n;
        pnl += v;
        if (v > 0n) wins++;
      }
      return {
        agentId: a.agentId,
        wallet: a.wallet,
        xHandle: at(a.xHandle),
        launches: launched.filter((p) => p.createdAt >= since).length,
        graduated: launched.filter((p) => p.phase === 2 && (p.graduatedAt ?? 0) >= since).length,
        pnlBnb: pnl.toString(),
        winRateBps: m.size ? Math.floor((wins * 10_000) / m.size) : 0,
        posts: promo.get(a.wallet) ?? 0,
        canLaunch: a.onchain ? a.onchainCanLaunch : a.canLaunch,
        projectsTraded: m.size, // extra
        _pnl: pnl,
      };
    })
    .sort((a, b) => (a._pnl === b._pnl ? (a.agentId < b.agentId ? -1 : 1) : a._pnl < b._pnl ? 1 : -1))
    .slice(0, clampLimit(q.limit, 100, 200));
  return rows.map(({ _pnl, ...r }, i) => ({ rank: i + 1, ...r, range }));
}

// ------------------------------------------------------------------ agent profile (#16)
export async function feAgentProfile(ctx: AppContext, query: string) {
  const { db, t } = ctx.database;
  const qRaw: string = String(query).trim();
  let agent: typeof t.agents.$inferSelect | undefined;
  let wallet: string;
  if (/^0x[0-9a-fA-F]{40}$/.test(qRaw)) {
    wallet = lc(qRaw);
    [agent] = await db.select().from(t.agents).where(eq(t.agents.wallet, wallet));
  } else {
    const id = qRaw.toLowerCase();
    const rows = await db.select().from(t.agents).where(eq(t.agents.agentId, id));
    agent = rows.sort((a, b) => Number(a.removed) - Number(b.removed) || b.updatedAt - a.updatedAt)[0];
    if (!agent) throw new ApiError(404, "not_found", "unknown agent id");
    wallet = agent.wallet;
  }
  const registered = !!agent && agent.onchain && !agent.removed;

  const [projects, trades, held, launches] = await Promise.all([
    db.select().from(t.projects),
    db.select().from(t.trades).where(eq(t.trades.trader, wallet)).orderBy(t.trades.blockNumber, t.trades.logIndex),
    db.select({ p: t.nftTokens.project, n: sql<number>`count(*)` }).from(t.nftTokens).where(eq(t.nftTokens.owner, wallet)).groupBy(t.nftTokens.project),
    listProjects(ctx, { filter: "all", launcher: wallet, limit: 100 }),
  ]);
  const byAddr = new Map(projects.map((p) => [p.address, p] as const));
  const perProject = new Map<string, TradeLite[]>();
  for (const tr of trades) {
    const l = perProject.get(tr.project) ?? [];
    l.push({ p: tr.project, side: tr.side, count: tr.count, bnb: tr.bnbWei, fee: tr.feeWei });
    perProject.set(tr.project, l);
  }
  const heldMap = new Map(held.map((h) => [h.p, Number(h.n)] as const));
  let realized = 0n;
  let unrealized = 0n;
  const holdings: { project: string; name: string; symbol: string; phase: string; count: number; valueBnb: string; costBnb: string }[] = [];
  for (const addr of new Set([...perProject.keys(), ...heldMap.keys()])) {
    const p = byAddr.get(addr);
    if (!p) continue;
    const b = costBook(perProject.get(addr) ?? []);
    realized += b.realized;
    const count = heldMap.get(addr) ?? 0;
    if (count <= 0) continue;
    // remaining average cost, scaled to the NFTs actually held (transfers in carry no cost)
    const cost = b.qty > 0n ? (b.cost * BigInt(Math.min(count, Number(b.qty)))) / b.qty : 0n;
    const value = holdingValue(p, count);
    unrealized += value - cost;
    holdings.push({ project: addr, name: p.name, symbol: p.symbol, phase: PHASES[p.phase] ?? "trading", count, valueBnb: value.toString(), costBnb: cost.toString() });
  }
  holdings.sort((a, b) => (BigInt(b.valueBnb) > BigInt(a.valueBnb) ? 1 : BigInt(b.valueBnb) < BigInt(a.valueBnb) ? -1 : 0));
  const ids = await agentMap(ctx);
  const recent = [...trades]
    .reverse()
    .slice(0, 20)
    .map((r) => toTrade(r as TradeRowLike, { agentId: ids.get(r.trader)?.agentId ?? null, name: byAddr.get(r.project)?.name ?? null, symbol: byAddr.get(r.project)?.symbol ?? null }));

  // raw agent record fields kept as extras for the SDK/admin (the old /v1/agents/:wallet response)
  const extras = agent
    ? {
        walletType: agent.walletType, intent: agent.intent, onchain: agent.onchain, removed: agent.removed, refCode: agent.refCode,
        eligibility: agent.eligibility ? safeJson(agent.eligibility) : null, lastQualifiedAt: agent.lastQualifiedAt,
      }
    : {};
  return {
    query: qRaw,
    wallet,
    agentId: agent?.agentId ?? null,
    xHandle: agent?.xHandle ? at(agent.xHandle) : null,
    registered,
    canLaunch: registered && agent!.onchainCanLaunch,
    canTrade: registered && agent!.onchainCanTrade,
    expiry: registered ? (agent!.expiry ?? null) : null,
    holdings,
    launches: launches.items,
    pnl: { realizedBnb: realized.toString(), unrealizedBnb: unrealized.toString(), totalBnb: (realized + unrealized).toString() },
    recentTrades: recent,
    onchainVerified: false,
    ...extras,
  };
}
function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ------------------------------------------------------------------ websocket (#18)
/**
 * `?project=` sets the initial filter; client `{type:"subscribe", channel:"trades", project?}` replaces it
 * (no project = all), `{type:"unsubscribe"}` stops trade pushes. Trades are sent as the FE `Trade` DTO.
 */
export function handleTradeSocket(ctx: AppContext, socket: { readyState: number; send(d: string): void; on(ev: string, fn: (...a: any[]) => void): void }, project?: string, pingMs = 30_000) {
  let only: string | null = project ? lc(project) : null;
  let tradesOn = true;
  let chain: Promise<void> = Promise.resolve();
  const out = (type: string, data: unknown) => {
    if (socket.readyState === 1) socket.send(jsonStringify({ type, data }));
  };
  const onTrade = (raw: any) => {
    if (!tradesOn || (only && raw.project !== only)) return;
    chain = chain.then(async () => {
      const { db, t } = ctx.database;
      const [a] = await db.select({ id: t.agents.agentId }).from(t.agents).where(eq(t.agents.wallet, raw.trader)).catch(() => []);
      const o = { agentId: a?.id ?? null, name: raw.name ?? null, symbol: raw.symbol ?? null };
      out("trade", raw.venue === "pool" ? poolSwapToTrade(raw as PoolSwapRowLike, o) : toTrade(raw as TradeRowLike, o));
    }).catch((e) => ctx.log.warn({ err: String(e) }, "ws trade push failed"));
  };
  const onProject = (data: any) => {
    if (only && data.project !== only) return;
    out("project", data);
  };
  ctx.bus.on("trade", onTrade);
  ctx.bus.on("project", onProject);
  const ping = setInterval(() => out("ping", null), pingMs);
  (ping as any).unref?.();
  socket.on("message", (m: unknown) => {
    let msg: any;
    try {
      msg = JSON.parse(String(m));
    } catch {
      return;
    }
    if (msg?.type === "subscribe" && (msg.channel === undefined || msg.channel === "trades")) {
      if (msg.project !== undefined && msg.project !== null && msg.project !== "" && !isAddr(msg.project)) {
        out("error", { code: "bad_address", message: "invalid project address" });
        return;
      }
      only = msg.project ? lc(msg.project) : null;
      tradesOn = true;
      out("subscribed", { channel: "trades", project: only });
    } else if (msg?.type === "unsubscribe") {
      tradesOn = false;
      out("unsubscribed", { channel: "trades" });
    }
  });
  out("hello", { project: only });
  socket.on("close", () => {
    clearInterval(ping);
    ctx.bus.off("trade", onTrade);
    ctx.bus.off("project", onProject);
  });
}

// ------------------------------------------------------------------ registration
export async function registerFrontendRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Querystring: Record<string, string> }>("/v1/ticker", async (req) => recentTrades(ctx, num(req.query.limit) ?? 30));
  app.get<{ Params: { address: string }; Querystring: Record<string, string> }>("/v1/projects/:address/promotions", async (req) =>
    fePromotions(ctx, addrParam(req.params.address), num(req.query.limit)),
  );
  app.get<{ Params: { address: string }; Querystring: Record<string, string> }>("/v1/projects/:address/nfts", async (req) =>
    feNfts(ctx, addrParam(req.params.address), num(req.query.limit)),
  );
  app.get("/v1/stats", async () => platformStats(ctx));
  // must be registered before /v1/agents/:query
  app.get<{ Querystring: Record<string, string> }>("/v1/agents/leaderboard", async (req) => feLeaderboard(ctx, { range: req.query.range, limit: num(req.query.limit) }));
  app.get<{ Params: { query: string } }>("/v1/agents/:query", async (req) => feAgentProfile(ctx, req.params.query));
}

