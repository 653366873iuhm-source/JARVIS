/** Minimum reward-pool threshold: below REWARD_MIN_POOL_BNB no root is posted (no tx), the epoch is 'deferred' and
 *  rolls over; the epoch that reaches it settles the whole pool, scored over the window since the last settled epoch. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { parseEther } from "viem";
import { openDatabase, type Database } from "../../src/db/index.js";
import { loadConfig } from "../../src/config.js";
import { buildServer } from "../../src/api/server.js";
import type { AppContext } from "../../src/context.js";
import { MockAgentIdResolver } from "../../src/providers/agentid/index.js";
import { MockXProvider } from "../../src/providers/x/mock.js";
import { DAY, clearPoolCache, epochOf, minPoolWei, runRewardEpoch, settlementWindow } from "../../src/services/rewards.js";
import { rewardsStatus } from "../../src/services/health.js";
import { rewardCatchUp } from "../../src/worker.js";

const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const R = A(0xaa1); // referrer (holds the project)
const B = A(0xbb2); // buyer bound to R's code
const P = A(0xcc3); // project
const POOL_ADDR = A(0xdd4) as `0x${string}`;
const E0 = 20_700;
const ZERO_ROOT = "0x" + "0".repeat(64);
const chain = { pool: 0n, reads: 0 };

let database: Database;
let app: FastifyInstance;
let ctx: AppContext;
let dbFile: string;

beforeAll(async () => {
  dbFile = path.join(os.tmpdir(), `agentpad-rt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  database = await openDatabase(`file:${dbFile}`);
  const pc = {
    getBlockNumber: async () => 1000n,
    getBalance: async () => parseEther("0.002"),
    readContract: async (q: any) => {
      chain.reads++;
      if (q.functionName === "unallocated") return chain.pool;
      if (q.functionName === "epochs") return [ZERO_ROOT, 0n, 0n, 0n, false];
      throw new Error("unexpected read " + q.functionName);
    },
  };
  ctx = {
    cfg: loadConfig({ NODE_ENV: "test", ADMIN_TOKEN: "t", AUTO_SUBMIT_ADMIN_TXS: "false", REFERRAL_WINDOW_SEC: String(30 * DAY) }),
    database, resolver: new MockAgentIdResolver(), x: new MockXProvider(), bus: new EventEmitter(), pc,
    signer: { getAddress: async () => A(1) }, relayer: { getAddress: async () => A(1) },
    addresses: { rewardPool: POOL_ADDR }, log: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as AppContext;
  const { db, t } = database;
  const now = Math.floor(Date.now() / 1000);
  for (const w of [R, B]) {
    await db.insert(t.agents).values({ wallet: w, agentId: `${w.slice(-3)}.ai`, agentIdHash: "0x" + w.slice(2), xHandle: w.slice(-4), xHandleHash: "0x" + w.slice(2), intent: "trade", createdAt: now, updatedAt: now } as any);
  }
  await db.insert(t.projects).values({ address: P, token: A(0xee5), launcher: R, agentIdHash: "0x01", name: "P", symbol: "P", baseUri: "ipfs://x/", idx: 0, tag: "#AP_P", createdAt: E0 * DAY, createdBlock: 1, virtualBnb: "1", virtualToken: "1", priceWei: "1" } as any);
  await db.insert(t.nftTokens).values({ project: P, tokenId: 1, owner: R });
  await db.insert(t.referralBindings).values({ project: P, buyer: B, referrer: R, code: "c", boundAt: E0 * DAY + 10 });
  // B buys on each of three consecutive days: E0 and E0+1 will be deferred, E0+2 settles all three
  for (const [i, wei] of [[0, "1000"], [1, "2000"], [2, "3000"]] as const) {
    await db.insert(t.trades).values({ id: `0x${i}:0`, project: P, trader: B, side: "buy", count: 1, bnbWei: wei, feeWei: "0", priceWei: "1", blockNumber: i + 1, logIndex: 0, txHash: `0x${i}`, ts: (E0 + i) * DAY + 100 });
  }
  app = await buildServer(ctx);
});
afterAll(async () => {
  await app?.close();
  await database?.close();
  for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true });
});

const postRoots = async () => (await database.db.select().from(database.t.adminTxs)).filter((x) => x.kind === "postRoot").length;
const row = async (e: number) => (await database.db.select().from(database.t.rewardEpochs)).find((r) => r.epoch === e);

describe("reward pool threshold", () => {
  it("REWARD_MIN_POOL_BNB defaults to 0.01 BNB and is env-configurable", () => {
    expect(minPoolWei(loadConfig({ NODE_ENV: "test" }))).toBe(parseEther("0.01"));
    expect(minPoolWei(loadConfig({ NODE_ENV: "test", REWARD_MIN_POOL_BNB: "0.05" }))).toBe(parseEther("0.05"));
    expect(minPoolWei(loadConfig({ NODE_ENV: "test", REWARD_MIN_POOL_BNB: "0" }))).toBe(0n);
  });

  it("below the threshold: epoch deferred, no postRoot tx, window accumulates", async () => {
    chain.pool = parseEther("0.004");
    const r0 = await runRewardEpoch(ctx, { epoch: E0 });
    expect(r0).toMatchObject({ status: "deferred", pool: parseEther("0.004").toString(), minPool: parseEther("0.01").toString(), windowFrom: E0 * DAY });
    expect(await postRoots()).toBe(0);
    expect((await row(E0))?.status).toBe("deferred");
    // dry run below threshold writes nothing and posts nothing
    const dry = await runRewardEpoch(ctx, { epoch: E0 + 1, dryRun: true });
    expect(dry.status).toBe("deferred");
    expect(await row(E0 + 1)).toBeUndefined();

    chain.pool = parseEther("0.008");
    const r1 = await runRewardEpoch(ctx, { epoch: E0 + 1 });
    expect(r1).toMatchObject({ status: "deferred", windowFrom: E0 * DAY, windowTo: (E0 + 2) * DAY });
    // re-running a deferred epoch is idempotent (still deferred, still no tx)
    expect((await runRewardEpoch(ctx, { epoch: E0 })).status).toBe("deferred");
    expect(await postRoots()).toBe(0);
    expect(await settlementWindow(ctx, E0 + 2)).toMatchObject({ from: E0 * DAY, to: (E0 + 3) * DAY, rolledEpochs: [E0, E0 + 1] });
  });

  it("/v1/rewards and the health rewards block expose pool, threshold and the next-settlement rule", async () => {
    clearPoolCache();
    const res = await app.inject({ method: "GET", url: "/v1/rewards" });
    const body = JSON.parse(res.body);
    expect(body.pool).toMatchObject({ unallocatedBnb: "0.008", minPoolBnb: "0.01", thresholdReached: false, deferredEpochs: 2, accumulatingSince: E0 * DAY });
    expect(body.pool.nextSettlement).toBe("next settlement when pool ≥ 0.01 BNB");
    expect(body.epochs.map((e: any) => e.status)).toEqual(["deferred", "deferred"]);
    const h = await rewardsStatus(ctx);
    expect(h.ok).toBe(true);
    expect(h.pool).toMatchObject({ minPoolBnb: "0.01", nextSettlement: "next settlement when pool ≥ 0.01 BNB" });
  });

  it("catch-up never re-runs a deferred epoch (no pool reads, no tx, however often it fires)", async () => {
    const y = epochOf(Math.floor(Date.now() / 1000)) - 1;
    const { db, t } = database;
    await db.insert(t.rewardEpochs).values({ epoch: y, windowFrom: y * DAY, windowTo: (y + 1) * DAY, poolWei: "1", totalWei: "0", engagementWei: "0", referralWei: "0", status: "deferred", createdAt: 1 });
    const reads = chain.reads;
    for (let i = 0; i < 5; i++) {
      const r: any = await rewardCatchUp(ctx);
      expect(r.skipped === "deferred" || r.skipped === "cron window").toBe(true);
    }
    expect(chain.reads).toBe(reads);
    expect(await postRoots()).toBe(0);
    await db.delete(t.rewardEpochs).where((await import("drizzle-orm")).eq(t.rewardEpochs.epoch, y));
  });

  it("pool reaches the threshold: one epoch settles the whole pool over all deferred days; deferred epochs roll into it", async () => {
    chain.pool = parseEther("0.012");
    const r = (await runRewardEpoch(ctx, { epoch: E0 + 2 })) as any;
    expect(r.status).toBe("computed"); // AUTO_SUBMIT_ADMIN_TXS=false here: root prepared (mainnet auto-sends)
    expect(r).toMatchObject({ windowFrom: E0 * DAY, windowTo: (E0 + 3) * DAY, total: parseEther("0.012").toString() });
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0]).toMatchObject({ wallet: R, referralWei: "6000" }); // buys from all three days
    expect(await postRoots()).toBe(1);
    expect((await row(E0))?.status).toBe("rolled");
    expect((await row(E0 + 1))?.status).toBe("rolled");
    expect((await runRewardEpoch(ctx, { epoch: E0 })).skipped).toBe(true); // rolled epochs never re-run
    expect((await runRewardEpoch(ctx, { epoch: E0 + 1 })).skipped).toBe(true);
    expect(await postRoots()).toBe(1);
  });

  it("after a settlement the next window starts where it ended", async () => {
    chain.pool = parseEther("0.001");
    const r = await runRewardEpoch(ctx, { epoch: E0 + 3 });
    expect(r).toMatchObject({ status: "deferred", windowFrom: (E0 + 3) * DAY, windowTo: (E0 + 4) * DAY });
    expect(await postRoots()).toBe(1);
  });
});
