/** Frontend routes (fix-list items 7–9): served from a seeded SQLite DB through the real fastify server. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { openDatabase, type Database } from "../../src/db/index.js";
import { loadConfig } from "../../src/config.js";
import { buildServer } from "../../src/api/server.js";
import type { AppContext } from "../../src/context.js";
import { VIRTUAL_BNB0, VIRTUAL_TOKEN0, nftPrice, quoteSell } from "../../src/lib/curve.js";
import { bucketCandles, costBook, holdingValue } from "../../src/api/routes/frontend.js";

const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const L = A(0xb1); // launcher nova.ai
const T = A(0xb2); // trader zeta.ai
const U = A(0xb3); // unregistered holder
const P1 = A(0xa1); // trading
const P2 = A(0xa2); // promotion
const PRICE = nftPrice(VIRTUAL_BNB0, VIRTUAL_TOKEN0).toString();
const E18 = 10n ** 18n;

let database: Database;
let app: FastifyInstance;
let ctx: AppContext;
let dbFile: string;
let now: number;
const get = async (url: string) => {
  const r = await app.inject({ method: "GET", url });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};

beforeAll(async () => {
  dbFile = path.join(os.tmpdir(), `agentpad-fe-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  database = await openDatabase(`file:${dbFile}`);
  const { db, t } = database;
  ctx = { cfg: loadConfig({ NODE_ENV: "test", PLATFORM_ADDRESSES: A(0xff) }), database, bus: new EventEmitter(), log: { info() {}, warn() {}, error() {}, debug() {} } } as unknown as AppContext;
  now = Math.floor(Date.now() / 1000);
  const agent = (wallet: string, agentId: string, xHandle: string, canLaunch: boolean) => ({
    wallet, agentId, agentIdHash: "0x", xHandle, xHandleHash: "0x", intent: canLaunch ? "launch" : "trade", canLaunch, canTrade: true,
    onchain: true, onchainCanLaunch: canLaunch, onchainCanTrade: true, expiry: now + 30 * 86400, createdAt: now - 1000, updatedAt: now - 1000,
  });
  await db.insert(t.agents).values([agent(L, "nova.ai", "nova_agent", true), agent(T, "zeta.ai", "zeta_bot", false)]);
  const proj = (address: string, symbol: string, phase: number, sold: number, idx: number) => ({
    address, token: A(0xc0 + idx), launcher: L, agentIdHash: "0x", name: `${symbol} Coin`, symbol, baseUri: "ipfs://x/", idx, tag: `#AP_${symbol}`,
    createdAt: now - 5000 + idx, createdBlock: 1 + idx, phase, virtualBnb: VIRTUAL_BNB0.toString(), virtualToken: VIRTUAL_TOKEN0.toString(), priceWei: PRICE, sold,
    promotionStart: phase === 1 ? now - 100 : null,
  });
  await db.insert(t.projects).values([proj(P1, "ONE", 0, 6000, 0), proj(P2, "TWO", 1, 10000, 1)]);
  // trades on P1: T buys 4 @0.1 + fee, then 2 @0.3; sells 2 for 0.5 gross; L buys 3
  const tr = (i: number, trader: string, side: "buy" | "sell", count: number, bnb: bigint, fee: bigint, ts: number) => ({
    id: `0x${i}:0`, project: P1, trader, side, count, bnbWei: bnb.toString(), feeWei: fee.toString(), priceWei: PRICE, firstTokenId: null,
    blockNumber: i, logIndex: 0, txHash: `0x${String(i).padStart(64, "0")}`, ts,
  });
  await db.insert(t.trades).values([
    tr(1, T, "buy", 4, (4n * E18) / 10n, E18 / 100n, now - 3 * 86400), // old: outside 24h, inside 7d
    tr(2, T, "buy", 2, (6n * E18) / 10n, E18 / 100n, now - 600),
    tr(3, T, "sell", 2, E18 / 2n, E18 / 200n, now - 300),
    tr(4, L, "buy", 3, (3n * E18) / 10n, 3n * E18 / 1000n, now - 120),
  ]);
  const nft = (project: string, tokenId: number, owner: string) => ({ project, tokenId, owner });
  await db.insert(t.nftTokens).values([
    ...[1, 2, 3, 4].map((i) => nft(P1, i, T)), ...[5, 6, 7].map((i) => nft(P1, i, L)), nft(P1, 8, U),
  ]);
  await db.insert(t.attestations).values({ id: `${P1}:1`, project: P1, nonce: 1, shareBps: 5000, root: "0xroot", promoters: JSON.stringify([T]), tree: "{}", signature: "0x", deadline: now, txHash: "0xatt", status: "submitted", createdAt: now - 50 });
  await db.insert(t.xPosts).values([
    { tweetId: "111", project: P1, wallet: T, authorId: "u1", text: "#AP_ONE code1 hello", createdAt: now - 200, hasCode: true, gateStatus: "accepted", likes: 31, reposts: 4 },
    { tweetId: "222", project: P1, wallet: L, authorId: "u2", text: "#AP_ONE launcher post", createdAt: now - 100, hasCode: true, gateStatus: "excluded", likes: 2, reposts: 0 },
  ]);
  app = await buildServer(ctx);
});

afterAll(async () => {
  await app?.close();
  await database?.close();
  for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true });
});

describe("pure helpers", () => {
  it("bucketCandles: average fill per NFT in BNB numbers, ascending, ≤ maxBars", () => {
    const rows = [
      { ts: 60, bnb: (2n * E18).toString(), count: 4 }, // 0.5/NFT
      { ts: 90, bnb: E18.toString(), count: 1 }, // 1.0
      { ts: 100, bnb: (3n * E18) / 10n + "", count: 1 }, // 0.3
      { ts: 130, bnb: (8n * E18) / 10n + "", count: 2 }, // 0.4
    ];
    const c = bucketCandles(rows, 60);
    expect(c).toEqual([
      { t: 60, o: 0.5, h: 1, l: 0.3, c: 0.3, v: 3.3, n: 3 },
      { t: 120, o: 0.4, h: 0.4, l: 0.4, c: 0.4, v: 0.8, n: 1 },
    ]);
    expect(bucketCandles(Array.from({ length: 300 }, (_, i) => ({ ts: i * 60, bnb: "1000", count: 1 })), 60).length).toBe(200);
  });
  it("costBook: average cost incl. fee, realised = net − basis", () => {
    const b = costBook([
      { p: "", side: "buy", count: 4, bnb: "400", fee: "4" },
      { p: "", side: "sell", count: 2, bnb: "300", fee: "3" },
    ]);
    expect(b).toEqual({ qty: 2n, cost: 202n, realized: 297n - 202n });
  });
  it("holdingValue: curve net on the curve, last NFT price after graduation", () => {
    const p = { phase: 0, virtualBnb: VIRTUAL_BNB0.toString(), virtualToken: VIRTUAL_TOKEN0.toString(), priceWei: "7" };
    expect(holdingValue(p, 3)).toBe(quoteSell(VIRTUAL_BNB0, VIRTUAL_TOKEN0, 3).net);
    expect(holdingValue({ ...p, phase: 2 }, 3)).toBe(21n);
    expect(holdingValue(p, 0)).toBe(0n);
  });
});

describe("frontend routes", () => {
  it("holders: bare Holder[] with count + isPromoter, count desc", async () => {
    const r = await get(`/v1/projects/${P1}/holders`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body[0]).toEqual({ wallet: T, agentId: "zeta.ai", count: 4, shareBps: 5000, isLauncher: false, isPromoter: true, isPlatform: false, rarities: { common: 0, rare: 0, epic: 0, legendary: 0 } });
    expect(r.body[1]).toMatchObject({ wallet: L, count: 3, isLauncher: true, isPromoter: false });
    expect(r.body[2]).toMatchObject({ wallet: U, agentId: null, count: 1 });
    expect(r.body[0]).not.toHaveProperty("nfts");
    expect((await get(`/v1/projects/${A(0xdead)}/holders`)).status).toBe(404);
  });
  it("candles: tf (and interval alias) -> bare Candle[] of numbers", async () => {
    const r = await get(`/v1/projects/${P1}/candles?tf=1d`);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBeGreaterThanOrEqual(2);
    for (const c of r.body) for (const k of ["t", "o", "h", "l", "c", "v"]) expect(typeof c[k]).toBe("number");
    const last = r.body.at(-1);
    expect(last.v).toBeGreaterThan(0);
    expect(r.body.map((c: any) => c.t)).toEqual([...r.body.map((c: any) => c.t)].sort((a: number, b: number) => a - b));
    const m = (await get(`/v1/projects/${P1}/candles?tf=1m`)).body;
    expect(m.at(-1)).toMatchObject({ o: 0.1, c: 0.1, v: 0.3, n: 1 }); // L's 3 NFTs for 0.3 BNB
    expect((await get(`/v1/projects/${P1}/candles?interval=1m`)).body).toEqual(m);
    expect((await get(`/v1/projects/${P1}/candles?tf=2m`)).body.error.code).toBe("bad_tf");
  });
  it("ticker: Trade[] newest first with name/symbol", async () => {
    const r = (await get("/v1/ticker")).body;
    expect(r.length).toBe(4);
    expect(r[0]).toMatchObject({ project: P1, name: "ONE Coin", symbol: "ONE", wallet: L, agentId: "nova.ai", side: "mint", count: 3 });
    expect(r[1].side).toBe("burn");
  });
  it("promotions: PromotionPost[] newest first", async () => {
    const r = (await get(`/v1/projects/${P1}/promotions`)).body;
    expect(r.map((p: any) => p.id)).toEqual(["222", "111"]);
    expect(r[1]).toMatchObject({ agentId: "zeta.ai", xHandle: "@zeta_bot", wallet: T, url: "https://x.com/zeta_bot/status/111", holdings: 4, likes: 31, reposts: 4, verified: true });
    expect(r[0].verified).toBe(false);
    expect((await get(`/v1/projects/${P2}/promotions`)).body).toEqual([]);
  });
  it("nfts: NftItem[] tokenId desc, limit", async () => {
    const r = (await get(`/v1/projects/${P1}/nfts?limit=3`)).body;
    expect(r).toEqual([
      { tokenId: 8, owner: U, agentId: null, image: null, rarity: null, traits: null },
      { tokenId: 7, owner: L, agentId: "nova.ai", image: null, rarity: null, traits: null },
      { tokenId: 6, owner: L, agentId: "nova.ai", image: null, rarity: null, traits: null },
    ]);
  });
  it("leaderboard: range windows, FE field names, pnl desc", async () => {
    const all = (await get("/v1/agents/leaderboard?range=all")).body;
    expect(all.map((r: any) => r.rank)).toEqual([1, 2]);
    const z = all.find((r: any) => r.agentId === "zeta.ai");
    // flows: −0.41 −0.61 +0.495 ; open: 4 NFTs × price × 0.99
    const flow = -(41n * E18) / 100n - (61n * E18) / 100n + (495n * E18) / 1000n;
    expect(BigInt(z.pnlBnb)).toBe(flow + (4n * BigInt(PRICE) * 99n) / 100n);
    expect(z).toMatchObject({ xHandle: "@zeta_bot", launches: 0, graduated: 0, posts: 1, canLaunch: false, winRateBps: 0 });
    const n = all.find((r: any) => r.agentId === "nova.ai");
    expect(n).toMatchObject({ launches: 2, canLaunch: true, posts: 1 });
    for (const k of ["graduations", "pnlWei", "promoPosts"]) expect(n).not.toHaveProperty(k);
    expect(BigInt(all[0].pnlBnb)).toBeGreaterThanOrEqual(BigInt(all[1].pnlBnb));
    const d1 = (await get("/v1/agents/leaderboard?range=24h")).body.find((r: any) => r.agentId === "zeta.ai");
    expect(BigInt(d1.pnlBnb)).toBe(-(61n * E18) / 100n + (495n * E18) / 1000n); // net 0 NFTs in window
    expect((await get("/v1/agents/leaderboard")).status).toBe(200);
    expect((await get("/v1/agents/leaderboard?range=1y")).body.error.code).toBe("bad_range");
  });
  it("agents/:query by agent id and wallet -> AgentProfile with PnL", async () => {
    const r = await get("/v1/agents/zeta.ai");
    expect(r.status).toBe(200);
    const p = r.body;
    expect(p).toMatchObject({ query: "zeta.ai", wallet: T, agentId: "zeta.ai", xHandle: "@zeta_bot", registered: true, canLaunch: false, canTrade: true, onchainVerified: false, launches: [] });
    expect(p.expiry).toBe(now + 30 * 86400);
    expect(p.holdings).toEqual([{ project: P1, name: "ONE Coin", symbol: "ONE", phase: "trading", count: 4, valueBnb: quoteSell(VIRTUAL_BNB0, VIRTUAL_TOKEN0, 4).net.toString(), costBnb: expect.any(String) }]);
    // avg cost: 1.02 BNB / 6 NFTs; sell 2 -> basis 0.34, realised = 0.495 − 0.34
    expect(BigInt(p.pnl.realizedBnb)).toBe((495n * E18) / 1000n - (102n * E18 * 2n) / 600n);
    expect(BigInt(p.holdings[0].costBnb)).toBe((102n * E18) / 100n - (102n * E18 * 2n) / 600n);
    expect(BigInt(p.pnl.totalBnb)).toBe(BigInt(p.pnl.realizedBnb) + BigInt(p.pnl.unrealizedBnb));
    expect(p.recentTrades.map((t: any) => t.side)).toEqual(["burn", "mint", "mint"]);
    expect(p.recentTrades[0]).toMatchObject({ name: "ONE Coin", symbol: "ONE", wallet: T });
    const byWallet = (await get(`/v1/agents/${L.toUpperCase().replace("0X", "0x")}`)).body;
    expect(byWallet).toMatchObject({ agentId: "nova.ai", registered: true, canLaunch: true, onchain: true, removed: false });
    expect(byWallet.launches.map((x: any) => x.address).sort()).toEqual([P1, P2]);
  });
  it("agents/:query: unregistered wallet -> 200 registered:false; unknown id -> 404", async () => {
    const u = await get(`/v1/agents/${U}`);
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ wallet: U, agentId: null, xHandle: null, registered: false, canLaunch: false, canTrade: false, expiry: null });
    expect(u.body.holdings[0]).toMatchObject({ project: P1, count: 1, costBnb: "0" });
    const n = await get("/v1/agents/nobody.ai");
    expect(n.status).toBe(404);
    expect(n.body.error.code).toBe("not_found");
  });
  it("filter=new is trading only (king of the hill)", async () => {
    const r = (await get("/v1/projects?filter=new&sort=progress&limit=1")).body;
    expect(r.items.map((p: any) => p.address)).toEqual([P1]);
    expect((await get("/v1/projects?filter=new")).body.items.every((p: any) => p.phase === "trading")).toBe(true);
  });
  it("websocket: subscribe messages filter by project; payload is the FE Trade", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
    const msgs: any[] = [];
    ws.on("message", (m) => msgs.push(JSON.parse(m.toString())));
    await new Promise((r) => ws.once("open", r));
    const wait = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
    };
    ws.send(JSON.stringify({ type: "subscribe", channel: "trades", project: P2 }));
    await wait(() => msgs.some((m) => m.type === "subscribed"));
    const raw = (project: string, i: number) => ({
      id: `0xw${i}:0`, project, trader: T, side: "buy", count: 1, bnbWei: "1000", feeWei: "10", priceWei: PRICE, firstTokenId: 9, blockNumber: 99, logIndex: i,
      txHash: "0xabc", ts: now, symbol: "TWO", name: "TWO Coin", progressBps: 1,
    });
    ctx.bus.emit("trade", raw(P1, 1)); // filtered out
    ctx.bus.emit("trade", raw(P2, 2));
    await wait(() => msgs.some((m) => m.type === "trade"));
    const trades = msgs.filter((m) => m.type === "trade");
    expect(trades.length).toBe(1);
    expect(trades[0].data).toMatchObject({ id: "0xw2:0", tx: "0xabc", project: P2, name: "TWO Coin", symbol: "TWO", wallet: T, agentId: "zeta.ai", side: "mint", count: 1, bnb: "1000", fee: "10", at: now });
    expect(trades[0].data).not.toHaveProperty("trader");
    // subscribe without project = all
    ws.send(JSON.stringify({ type: "subscribe", channel: "trades" }));
    await wait(() => msgs.filter((m) => m.type === "subscribed").length === 2);
    ctx.bus.emit("trade", raw(P1, 3));
    await wait(() => msgs.filter((m) => m.type === "trade").length === 2);
    expect(msgs.filter((m) => m.type === "trade").at(-1).data.project).toBe(P1);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.bus.listenerCount("trade")).toBe(0);
  });
});

describe("stats", () => {
  it("GET /v1/stats: totals + charity donated derived from indexed fees (20% of each trade fee) when no FeeSplitter", async () => {
    const r = await get("/v1/stats");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ projects: 2, graduated: 0, trades: 4 });
    const fees = E18 / 100n + E18 / 100n + E18 / 200n + (3n * E18) / 1000n;
    expect(r.body.feesWei).toBe(fees.toString());
    expect(r.body.charity).toMatchObject({
      address: "0x8b99f3660622e21f2910ecca7fbe51d654a1517d", shareBps: 2000, source: "index", flushedWei: null, pendingWei: null,
      totalDonatedWei: ((E18 / 100n) * 2000n / 10000n * 2n + (E18 / 200n) * 2000n / 10000n + ((3n * E18) / 1000n) * 2000n / 10000n).toString(),
    });
  });
});
