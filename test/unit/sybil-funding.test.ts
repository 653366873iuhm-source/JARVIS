/** Sybil scan: failed funding lookups stay unchecked (retried); recheckUnfunded re-queues agents stored with no funder. */
import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../../src/db/index.js";
import { runSybilScan } from "../../src/services/sybil.js";
import type { FundingSourceProvider } from "../../src/providers/funding/index.js";

const W = (n: number) => "0x" + n.toString(16).padStart(40, "0");

describe("sybil funding scan", () => {
  it("does not record a failed lookup as 'no funder'; recheckUnfunded retries null-funder agents", async () => {
    const database = await openDatabase(`file:${path.join(os.tmpdir(), `sybil-${Date.now()}.db`)}`);
    const { db, t } = database;
    const now = Math.floor(Date.now() / 1000);
    const row = (w: string) => ({ wallet: w, agentId: `${w.slice(-4)}.ai`, agentIdHash: "0x", xHandle: "x", xHandleHash: "0x", intent: "trade", canLaunch: false, createdAt: now, updatedAt: now });
    await db.insert(t.agents).values([row(W(1)), row(W(2)), row(W(3))]);
    let failing = true;
    const funding: FundingSourceProvider = {
      name: "fake",
      async firstInboundMany(ws) {
        if (failing) return new Map();
        return new Map(ws.map((w) => [w, { from: W(0xf), txHash: "0x1", blockNumber: 1, value: "1" }] as const));
      },
    };
    const ctx: any = { database, funding, cfg: { SYBIL_EXEMPT_FUNDERS: [], SYBIL_MIN_CLUSTER: 3 } };
    const r1 = await runSybilScan(ctx);
    expect(r1).toMatchObject({ pending: 3, checkedFunding: 0, failedLookups: 3, clusters: [] });
    expect((await db.select().from(t.agents)).every((a) => a.fundingCheckedAt === null)).toBe(true);
    failing = false;
    const r2 = await runSybilScan(ctx);
    expect(r2.checkedFunding).toBe(3);
    expect(r2.clusters.length).toBe(1); // 3 wallets, same funder → flagged
    // legacy rows recorded as "checked, no funder" are re-queued on request
    await db.update(t.agents).set({ funder: null, fundingCheckedAt: now });
    expect((await runSybilScan(ctx)).pending).toBe(0);
    expect((await runSybilScan(ctx, { recheckUnfunded: true })).checkedFunding).toBe(3);
  });
});
