/** Exercises the PostgreSQL schema + migrations + portable queries on embedded Postgres (PGlite). */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { openDatabase } from "../../src/db/index.js";
import { loadConfig } from "../../src/config.js";
import { listProjects, projectDetail, projectHolders, candles, leaderboard, recentTrades, invalidateLeaderboard } from "../../src/services/market.js";
import { VIRTUAL_BNB0, VIRTUAL_TOKEN0, nftPrice } from "../../src/lib/curve.js";
import type { AppContext } from "../../src/context.js";

describe("postgres dialect (PGlite)", () => {
  it("migrates and serves market queries", async () => {
    const database = await openDatabase("pglite://memory");
    expect(database.dialect).toBe("pglite");
    const { db, t } = database;
    const ctx = { cfg: loadConfig({}), database, bus: new EventEmitter(), log: console } as unknown as AppContext;
    const now = Math.floor(Date.now() / 1000);
    const P = "0x00000000000000000000000000000000000000p1".replace("p1", "a1");
    await db.insert(t.agents).values({ wallet: "0x00000000000000000000000000000000000000b1", agentId: "b.ai", agentIdHash: "0x", xHandle: "b", xHandleHash: "0x", intent: "launch", canLaunch: true, createdAt: now, updatedAt: now });
    await db.insert(t.projects).values({
      address: P, token: "0xt", launcher: "0x00000000000000000000000000000000000000b1", agentIdHash: "0x", name: "Pg Coin", symbol: "PG", baseUri: "ipfs://x/", idx: 0, tag: "#AP_PG",
      createdAt: now - 100, createdBlock: 1, phase: 0, virtualBnb: VIRTUAL_BNB0.toString(), virtualToken: VIRTUAL_TOKEN0.toString(), priceWei: nftPrice(VIRTUAL_BNB0, VIRTUAL_TOKEN0).toString(), sold: 8000,
    });
    for (let i = 0; i < 3; i++) {
      await db.insert(t.trades).values({ id: `0x${i}:0`, project: P, trader: "0x00000000000000000000000000000000000000b1", side: "buy", count: 1, bnbWei: "1000", feeWei: "10", priceWei: String(1000 + i), blockNumber: i, logIndex: 0, txHash: `0x${i}`, ts: now - 60 * i });
      await db.insert(t.nftTokens).values({ project: P, tokenId: i + 1, owner: "0x00000000000000000000000000000000000000b1" });
    }
    await db.insert(t.kv).values({ key: "k", value: "v" }).onConflictDoUpdate({ target: t.kv.key, set: { value: "v2" } });
    await db.insert(t.kv).values({ key: "k", value: "v3" }).onConflictDoUpdate({ target: t.kv.key, set: { value: "v3" } });
    expect((await db.select().from(t.kv))[0]!.value).toBe("v3");
    await db.transaction(async (tx) => {
      await tx.insert(t.chainEvents).values({ id: "e1", address: P, name: "X", args: "{}", blockNumber: 1, txHash: "0x", ts: now });
    });
    const dup = await db.insert(t.chainEvents).values({ id: "e1", address: P, name: "X", args: "{}", blockNumber: 1, txHash: "0x", ts: now }).onConflictDoNothing().returning({ id: t.chainEvents.id });
    expect(dup.length).toBe(0);

    const list = await listProjects(ctx, { filter: "即将打满" });
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ symbol: "PG", trades24h: 3, holders: 1, progressBps: 8000, launcherAgentId: "b.ai" });
    expect(list.nextCursor).toBeNull();
    await db.insert(t.chainEvents).values({ id: "launch", address: "0xfactory", name: "Launched", args: JSON.stringify({ project: P }), blockNumber: 1, txHash: "0xlaunchtx", ts: now - 100 });
    const d = await projectDetail(ctx, P);
    expect(d).toMatchObject({ launchTx: "0xlaunchtx", launcherHoldings: 3, totalSupply: "8000", promotion: null, firstPostGradId: null });
    expect(d.topHolders).toEqual([{ wallet: "0x00000000000000000000000000000000000000b1", count: 3 }]);
    expect(d.recentTrades.map((r) => r.side)).toEqual(["mint", "mint", "mint"]);
    expect((await listProjects(ctx, { phase: "trading", sort: "volume", limit: 1 })).sort).toBe("volume24h");
    expect((await projectHolders(ctx, P)).holders[0]!.nfts).toBe(3);
    expect((await candles(ctx, P, { interval: "1m" })).candles.length).toBe(3);
    expect((await recentTrades(ctx, 5)).length).toBe(3);
    invalidateLeaderboard();
    const lb = await leaderboard(ctx, { sort: "launches" });
    expect(lb.items[0]).toMatchObject({ agentId: "b.ai", launches: 1, projectsTraded: 1 });
    await database.close();
  });
});
