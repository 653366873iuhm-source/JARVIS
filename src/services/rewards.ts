import { and, desc, eq, gte, lt } from "drizzle-orm";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { encodeFunctionData } from "viem";
import type { AppContext } from "../context.js";
import { RewardPoolAbi } from "../chain/abi.js";
import { checksum, lc, nowSec } from "../lib/util.js";
import { runAdminTx } from "./adminTx.js";
import { ApiError } from "./registration.js";

export const DAY = 86400;
export const epochOf = (ts: number) => Math.floor(ts / DAY);

/** Engagement score of a post (reposts/replies/quotes weigh more than likes: they spread the post). */
export const postScore = (p: { likes: number; reposts: number; replies: number; quotes: number }) => p.likes + 2 * p.reposts + 2 * p.replies + 3 * p.quotes;

export interface RewardRunOptions {
  epoch: number; // RewardPool epoch id (UTC day number by default)
  from?: number; // window start (unix s), default epoch*86400
  to?: number; // window end (exclusive), default from + 86400
  dryRun?: boolean;
}

/** Splits `pool` across `scores` pro rata, flooring; returns per-key amounts. */
export function proRata(pool: bigint, scores: Map<string, bigint>): Map<string, bigint> {
  const out = new Map<string, bigint>();
  let sum = 0n;
  for (const v of scores.values()) sum += v;
  if (sum === 0n || pool === 0n) return out;
  for (const [k, v] of scores) {
    const a = (pool * v) / sum;
    if (a > 0n) out.set(k, a);
  }
  return out;
}

/**
 * Daily reward settlement (pool = RewardPool.unallocated(), i.e. the 0.2% fee share not yet allocated):
 *   50% engagement: submitted X posts (project tag + code; metrics re-fetched by id at settlement) by agents that hold/held that project, created in the window;
 *                   score = likes + 2·reposts + 2·replies + 3·quotes, best REWARD_MAX_POSTS_PER_AGENT_DAY posts per agent.
 *   50% referrals:  curve buys (Minted cost, excl. fee) in the window by buyers bound to a referrer's code for that
 *                   project, within REFERRAL_WINDOW_SEC after binding. Self-referrals, same-funder pairs and
 *                   sybil-flagged/removed agents are ignored.
 *   If one half has no participants its share goes to the other half. Leaves: [epoch, account, amount]
 *   (["uint256","address","uint256"], OZ StandardMerkleTree), root posted with RewardPool.postRoot by the platform signer.
 */
export async function runRewardEpoch(ctx: AppContext, opts: RewardRunOptions) {
  const { db, t } = ctx.database;
  const epoch = opts.epoch;
  const from = opts.from ?? epoch * DAY;
  const to = opts.to ?? from + DAY;
  const [existing] = await db.select().from(t.rewardEpochs).where(eq(t.rewardEpochs.epoch, epoch));
  if (existing && (existing.status === "posted" || existing.status === "empty")) return { epoch, status: existing.status, skipped: true };

  const onchain = (await ctx.pc.readContract({ address: ctx.addresses.rewardPool, abi: RewardPoolAbi, functionName: "epochs", args: [BigInt(epoch)] })) as readonly unknown[];
  if (onchain[0] !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
    throw new ApiError(409, "epoch_exists", `epoch ${epoch} already has a root on-chain`);
  }
  const pool = (await ctx.pc.readContract({ address: ctx.addresses.rewardPool, abi: RewardPoolAbi, functionName: "unallocated" })) as bigint;

  const agents = new Map((await db.select().from(t.agents)).map((a) => [a.wallet, a] as const));
  const okAgent = (w: string) => {
    const a = agents.get(w);
    return !!a && !a.removed && !a.sybilFlag;
  };
  const projects = await db.select().from(t.projects);

  // participation: wallets that bought in / hold each project
  const participants = new Map<string, Set<string>>();
  for (const tr of await db.select({ p: t.trades.project, w: t.trades.trader }).from(t.trades).where(eq(t.trades.side, "buy"))) {
    if (!participants.has(tr.p)) participants.set(tr.p, new Set());
    participants.get(tr.p)!.add(tr.w);
  }
  for (const h of await db.select({ p: t.nftTokens.project, w: t.nftTokens.owner }).from(t.nftTokens)) {
    if (!participants.has(h.p)) participants.set(h.p, new Set());
    participants.get(h.p)!.add(h.w);
  }

  // no X search: only SUBMITTED posts (POST /v1/promotions/submit) exist; re-fetch each one now for fresh metrics
  const posts = await db.select().from(t.xPosts).where(and(gte(t.xPosts.createdAt, from), lt(t.xPosts.createdAt, to)));
  if (posts.length) {
    const fresh = await ctx.x.getPosts(posts.map((p) => p.tweetId)).catch((e) => {
      ctx.log.warn({ err: String(e) }, "X metrics refresh failed; using stored metrics");
      return [];
    });
    const byId = new Map(fresh.map((f) => [f.id, f] as const));
    for (const p of posts) {
      const f = byId.get(p.tweetId);
      if (!f) continue;
      Object.assign(p, { likes: f.likes, reposts: f.reposts, replies: f.replies, quotes: f.quotes });
      await db.update(t.xPosts).set({ likes: f.likes, reposts: f.reposts, replies: f.replies, quotes: f.quotes, metricsAt: nowSec() }).where(eq(t.xPosts.tweetId, p.tweetId));
    }
  }
  const tagOf = new Map(projects.map((p) => [p.address, p] as const));
  const perAgentPosts = new Map<string, number[]>();
  for (const p of posts) {
    const proj = tagOf.get(p.project);
    if (!proj || !p.text.toLowerCase().includes(proj.tag.toLowerCase())) continue;
    if (!okAgent(p.wallet) || !participants.get(p.project)?.has(p.wallet)) continue;
    if (p.gateStatus === "duplicate_text") continue;
    if (!perAgentPosts.has(p.wallet)) perAgentPosts.set(p.wallet, []);
    perAgentPosts.get(p.wallet)!.push(postScore(p));
  }
  const engagement = new Map<string, bigint>();
  for (const [w, scores] of perAgentPosts) {
    const top = scores.sort((a, b) => b - a).slice(0, ctx.cfg.REWARD_MAX_POSTS_PER_AGENT_DAY);
    const s = top.reduce((a, b) => a + b, 0);
    if (s > 0) engagement.set(w, BigInt(s));
  }

  // referrals
  const bindings = await db.select().from(t.referralBindings);
  const bindingOf = new Map(bindings.map((b) => [`${b.project}:${b.buyer}`, b] as const));
  const buys = await db.select().from(t.trades).where(and(eq(t.trades.side, "buy"), gte(t.trades.ts, from), lt(t.trades.ts, to)));
  const referral = new Map<string, bigint>();
  for (const b of buys) {
    const bind = bindingOf.get(`${b.project}:${b.trader}`);
    if (!bind || bind.referrer === b.trader) continue;
    if (b.ts < bind.boundAt || b.ts > bind.boundAt + ctx.cfg.REFERRAL_WINDOW_SEC) continue;
    if (!okAgent(bind.referrer) || !participants.get(b.project)?.has(bind.referrer)) continue;
    const fr = agents.get(bind.referrer)?.funder;
    const fb = agents.get(b.trader)?.funder;
    if (fr && fb && fr === fb) continue; // same funding source: not a real new buyer
    if (lc(agents.get(b.trader)?.funder ?? "") === bind.referrer) continue; // referrer funded the buyer
    referral.set(bind.referrer, (referral.get(bind.referrer) ?? 0n) + BigInt(b.bnbWei));
  }

  let engagementPool = pool / 2n;
  let referralPool = pool - engagementPool;
  if (engagement.size === 0) {
    referralPool += engagementPool;
    engagementPool = 0n;
  }
  if (referral.size === 0) {
    engagementPool += referralPool;
    referralPool = 0n;
  }
  const a1 = proRata(engagementPool, engagement);
  const a2 = proRata(referralPool, referral);
  const amounts = new Map<string, bigint>();
  for (const m of [a1, a2]) for (const [w, v] of m) amounts.set(w, (amounts.get(w) ?? 0n) + v);
  let total = 0n;
  for (const v of amounts.values()) total += v;

  const base = {
    epoch, windowFrom: from, windowTo: to, poolWei: pool.toString(), totalWei: total.toString(), engagementWei: engagementPool.toString(),
    referralWei: referralPool.toString(), createdAt: nowSec(),
  };
  if (total === 0n) {
    const row = { ...base, status: "empty", root: null, tree: null, txHash: null, error: null };
    if (!opts.dryRun) await db.insert(t.rewardEpochs).values(row).onConflictDoUpdate({ target: t.rewardEpochs.epoch, set: row });
    return { epoch, status: "empty", pool: pool.toString(), total: "0", allocations: [] };
  }

  const values = [...amounts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([w, v]) => [String(epoch), checksum(w), v.toString()] as [string, string, string]);
  const tree = StandardMerkleTree.of(values, ["uint256", "address", "uint256"]);
  const allocations = [...tree.entries()].map(([i, v]) => ({
    wallet: lc(v[1]), amount: v[2], proof: tree.getProof(i),
    engagementScore: Number(engagement.get(lc(v[1])) ?? 0n), referralWei: (referral.get(lc(v[1])) ?? 0n).toString(),
  }));
  if (opts.dryRun) return { epoch, status: "dry_run", root: tree.root, pool: pool.toString(), total: total.toString(), allocations };

  const row = { ...base, status: "computed", root: tree.root, tree: JSON.stringify(tree.dump()), txHash: null, error: null };
  await db.insert(t.rewardEpochs).values(row).onConflictDoUpdate({ target: t.rewardEpochs.epoch, set: row });
  await db.delete(t.rewardAllocations).where(eq(t.rewardAllocations.epoch, epoch));
  for (const a of allocations) {
    await db.insert(t.rewardAllocations).values({
      epoch, wallet: a.wallet, amountWei: a.amount, engagementScore: a.engagementScore, referralWei: a.referralWei, proof: JSON.stringify(a.proof), claimed: false,
    });
  }
  const data = encodeFunctionData({ abi: RewardPoolAbi, functionName: "postRoot", args: [BigInt(epoch), tree.root as `0x${string}`, total] });
  const res = await runAdminTx(ctx, { kind: "postRoot", target: String(epoch), to: ctx.addresses.rewardPool, data, reason: `epoch ${epoch} total ${total}` });
  const status = res.status === "confirmed" ? "posted" : res.status === "prepared" ? "computed" : "failed";
  await db.update(t.rewardEpochs).set({ status, txHash: res.txHash ?? null, error: res.error ?? null }).where(eq(t.rewardEpochs.epoch, epoch));
  return { epoch, status, root: tree.root, pool: pool.toString(), total: total.toString(), txHash: res.txHash, allocations };
}

/** Claim data for RewardPool.claim(epoch, account, amount, proof). */
export async function rewardsFor(ctx: AppContext, wallet: string) {
  const { db, t } = ctx.database;
  const rows = await db.select().from(t.rewardAllocations).where(eq(t.rewardAllocations.wallet, lc(wallet))).orderBy(desc(t.rewardAllocations.epoch));
  const epochs = new Map((await db.select().from(t.rewardEpochs)).map((e) => [e.epoch, e] as const));
  return {
    wallet: lc(wallet),
    rewardPool: ctx.addresses.rewardPool,
    items: rows
      .filter((r) => epochs.get(r.epoch)?.status === "posted")
      .map((r) => ({
        epoch: r.epoch, amountWei: r.amountWei, proof: JSON.parse(r.proof) as string[], claimed: r.claimed,
        engagementScore: r.engagementScore, referralWei: r.referralWei, root: epochs.get(r.epoch)?.root,
        calldata: encodeFunctionData({ abi: RewardPoolAbi, functionName: "claim", args: [BigInt(r.epoch), checksum(r.wallet), BigInt(r.amountWei), JSON.parse(r.proof)] }),
      })),
  };
}
