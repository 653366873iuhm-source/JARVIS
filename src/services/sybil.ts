import { eq, isNull } from "drizzle-orm";
import { encodeFunctionData } from "viem";
import type { AppContext } from "../context.js";
import { AgentRegistryAbi } from "../chain/abi.js";
import { checksum, lc, nowSec } from "../lib/util.js";
import { runAdminTx } from "./adminTx.js";
import { ApiError } from "./registration.js";

class UnionFind {
  p = new Map<string, string>();
  find(x: string): string {
    if (!this.p.has(x)) this.p.set(x, x);
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r)!;
    let c = x;
    while (this.p.get(c) !== r) {
      const n = this.p.get(c)!;
      this.p.set(c, r);
      c = n;
    }
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

/**
 * Sybil heuristic: wallets whose first inbound BNB came from the same source are linked (transitively, so
 * funder -> agent -> agent chains join one cluster). Clusters with >= SYBIL_MIN_CLUSTER agent wallets are flagged.
 * Exchange hot wallets and other shared sources (SYBIL_EXEMPT_FUNDERS) never link wallets.
 * Flagged agents are excluded from rewards and promoter sets immediately; removal from the on-chain whitelist is an
 * admin decision (POST /v1/admin/agents/:wallet/remove).
 */
export async function runSybilScan(ctx: AppContext) {
  const { db, t } = ctx.database;
  const pending = await db.select().from(t.agents).where(isNull(t.agents.fundingCheckedAt));
  const found = pending.length ? await ctx.funding.firstInboundMany(pending.map((a) => a.wallet)) : new Map();
  if (pending.length) {
    for (const a of pending) {
      if (!found.has(a.wallet)) continue; // lookup failed: stay unchecked, retried next scan
      const f = found.get(a.wallet) ?? null;
      await db.update(t.agents).set({ funder: f?.from ?? null, fundingTx: f?.txHash ?? null, fundingCheckedAt: nowSec() }).where(eq(t.agents.wallet, a.wallet));
    }
  }
  const agents = await db.select().from(t.agents);
  const exempt = new Set(ctx.cfg.SYBIL_EXEMPT_FUNDERS);
  const uf = new UnionFind();
  for (const a of agents) {
    uf.find(a.wallet);
    if (a.funder && a.funder !== a.wallet && !exempt.has(a.funder)) uf.union(a.wallet, a.funder);
  }
  const groups = new Map<string, string[]>();
  for (const a of agents) {
    const r = uf.find(a.wallet);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(a.wallet);
  }
  const clusters: { id: string; wallets: string[]; funders: string[] }[] = [];
  const flagged = new Map<string, string>();
  for (const [root, wallets] of groups) {
    if (wallets.length < ctx.cfg.SYBIL_MIN_CLUSTER) continue;
    const funders = [...new Set(agents.filter((a) => wallets.includes(a.wallet) && a.funder).map((a) => a.funder!))];
    const id = `cl_${root.slice(2, 10)}`;
    clusters.push({ id, wallets: wallets.sort(), funders });
    for (const w of wallets) flagged.set(w, id);
  }
  for (const a of agents) {
    const manual = a.removed || a.sybilCluster === "admin" ? (a.sybilCluster ?? "admin") : null;
    const id = flagged.get(a.wallet) ?? manual;
    if (a.sybilFlag !== !!id || a.sybilCluster !== id) {
      await db.update(t.agents).set({ sybilFlag: !!id, sybilCluster: id, updatedAt: nowSec() }).where(eq(t.agents.wallet, a.wallet));
    }
  }
  return { provider: ctx.funding.name ?? "custom", pending: pending.length, checkedFunding: pending.filter((a) => found.has(a.wallet)).length, failedLookups: pending.filter((a) => !found.has(a.wallet)).length, clusters };
}

export async function listClusters(ctx: AppContext) {
  const { db, t } = ctx.database;
  const rows = (await db.select().from(t.agents)).filter((a) => a.sybilFlag);
  const m = new Map<string, { id: string; wallets: { wallet: string; agentId: string; funder: string | null; removed: boolean }[] }>();
  for (const a of rows) {
    const id = a.sybilCluster ?? "unknown";
    if (!m.has(id)) m.set(id, { id, wallets: [] });
    m.get(id)!.wallets.push({ wallet: a.wallet, agentId: a.agentId, funder: a.funder, removed: a.removed });
  }
  return [...m.values()];
}

/** Admin: remove an agent from the whitelist (AgentRegistry.removeAgent) — cancels rewards and trading. */
export async function removeAgent(ctx: AppContext, wallet: string, reason: string) {
  const { db, t } = ctx.database;
  const [a] = await db.select().from(t.agents).where(eq(t.agents.wallet, lc(wallet)));
  if (!a) throw new ApiError(404, "agent_not_found", "unknown agent");
  await db.update(t.agents).set({ sybilFlag: true, sybilCluster: a.sybilCluster ?? "admin", updatedAt: nowSec() }).where(eq(t.agents.wallet, a.wallet));
  const data = encodeFunctionData({ abi: AgentRegistryAbi, functionName: "removeAgent", args: [checksum(a.wallet)] });
  return runAdminTx(ctx, { kind: "removeAgent", target: a.wallet, to: ctx.addresses.registry, data, reason });
}

export async function revokeLaunch(ctx: AppContext, wallet: string, reason: string) {
  const data = encodeFunctionData({ abi: AgentRegistryAbi, functionName: "revokeLaunch", args: [checksum(wallet)] });
  return runAdminTx(ctx, { kind: "revokeLaunch", target: lc(wallet), to: ctx.addresses.registry, data, reason });
}
