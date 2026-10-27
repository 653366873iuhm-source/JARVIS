import { and, desc, eq } from "drizzle-orm";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { encodeFunctionData, zeroHash, type Address, type Hex } from "viem";
import type { AppContext } from "../context.js";
import { BondingNFTAbi } from "../chain/abi.js";
import { chainNow } from "../chain/client.js";
import { PromotionTypes, registryDomain } from "../chain/eip712.js";
import { PROMOTION_MAX, PROMOTION_THRESHOLD_BPS } from "../lib/curve.js";
import { normalizePostText, shingles, jaccard } from "../lib/similarity.js";
import { checksum, hmacCode, lc, normHandle, nowSec, parseTweetId } from "../lib/util.js";
import { isAuthor } from "./eligibility.js";
import type { XPost } from "../providers/x/types.js";
import { runAdminTx } from "./adminTx.js";
import { ApiError } from "./registration.js";

/** One-time promotion code for (project, agent wallet). Deterministic HMAC, so nothing to store or leak per request. */
export function promoCode(ctx: AppContext, project: string, wallet: string) {
  return "AP-" + hmacCode(ctx.cfg.CODE_SECRET, ["promo", lc(project), lc(wallet)], 8);
}

export interface GateEvaluation {
  project: string;
  eligibleTotal: number; // NFTs excluding launcher + platform addresses
  promoterNfts: number;
  shareBps: number;
  promoters: string[];
  verdicts: { tweetId: string; wallet: string; status: string; similarTo?: string | null }[];
}

/** Upserts a verified X post for (project, wallet). Re-submitting refreshes its metrics. */
async function storePost(ctx: AppContext, project: string, wallet: string, p: XPost) {
  const { db, t } = ctx.database;
  const vals = {
    tweetId: p.id, project: lc(project), wallet: lc(wallet), authorId: p.authorId, text: p.text, createdAt: p.createdAt,
    hasCode: p.text.includes(promoCode(ctx, project, wallet)), likes: p.likes, reposts: p.reposts, replies: p.replies, quotes: p.quotes,
    metricsAt: nowSec(),
  };
  await db
    .insert(t.xPosts)
    .values(vals)
    .onConflictDoUpdate({ target: t.xPosts.tweetId, set: { likes: p.likes, reposts: p.reposts, replies: p.replies, quotes: p.quotes, metricsAt: vals.metricsAt } });
}

export type PromoPostKind = "original" | "quote" | "reply";

/**
 * POST /v1/promotions/submit {project, wallet, url}: the promoter submits its post URL (there is no X search).
 * Verified via FxTwitter by id:
 *   - the post's author is the wallet's bound X account (id, else handle);
 *   - its own text contains the project tag (#AP_<SYMBOL>) and the agent's one-time code;
 *   - original posts, quote posts and replies are accepted. A plain retweet has no text of its own and its URL
 *     resolves to the ORIGINAL author's post, so it can't be attributed or carry the code: pure retweets can't be
 *     verified with free lookups — promoters must quote-post instead.
 * When `wallet` is omitted (legacy POST /v1/promotion/:project/posts) the agent is found from the post author.
 * Time window, holdings, one-per-agent and duplicate text are judged by evaluateGate.
 */
export async function submitPromoPost(ctx: AppContext, input: { project: string; url: string; wallet?: string }) {
  const { db, t } = ctx.database;
  const [p] = await db.select().from(t.projects).where(eq(t.projects.address, lc(input.project)));
  if (!p) throw new ApiError(404, "not_found", "unknown project");
  const id = parseTweetId(input.url);
  if (!id) throw new ApiError(400, "bad_tweet_url", "not an X post URL");
  const post = await ctx.x.getPost(id);
  if (!post) throw new ApiError(404, "tweet_not_found", "X post not found (deleted, protected, or not yet visible)");
  if (post.isRepost)
    throw new ApiError(422, "repost_unverifiable", "plain retweets can't be verified; quote-post with the tag and your code instead");

  let agent: (typeof t.agents.$inferSelect) | undefined;
  if (input.wallet) {
    [agent] = await db.select().from(t.agents).where(eq(t.agents.wallet, lc(input.wallet)));
    if (!agent) throw new ApiError(422, "not_an_agent", "wallet is not a registered agent");
  } else {
    const all = await db.select().from(t.agents);
    agent = all.find((a) => (a.xUserId && a.xUserId === post.authorId) || normHandle(a.xHandle) === normHandle(post.authorUsername));
    if (!agent) throw new ApiError(422, "not_an_agent", "post author is not a registered agent X account");
  }
  if (agent.removed) throw new ApiError(403, "agent_removed", "this wallet was removed from the whitelist");
  if (!isAuthor(post, { id: agent.xUserId, username: agent.xHandle }))
    throw new ApiError(
      422, "wrong_author",
      `post ${id} is by @${post.authorUsername}, not the bound account @${agent.xHandle} (a plain retweet URL points at the original author: quote-post instead)`,
    );
  const code = promoCode(ctx, p.address, agent.wallet);
  if (!post.text.toLowerCase().includes(p.tag.toLowerCase())) throw new ApiError(422, "missing_tag", `post must contain ${p.tag}`);
  if (!post.text.includes(code)) throw new ApiError(422, "missing_code", `post must contain your code ${code}`);
  await storePost(ctx, p.address, agent.wallet, post);
  const kind: PromoPostKind = post.quoteOfId ? "quote" : post.replyToId ? "reply" : "original";
  const evaluation = p.phase === 1 ? await evaluateGate(ctx, p.address) : null;
  const verdict = evaluation?.verdicts.find((v) => v.tweetId === id);
  return {
    tweetId: id, url: `https://x.com/${post.authorUsername}/status/${id}`, project: checksum(p.address), wallet: checksum(agent.wallet), kind,
    status: verdict?.status ?? "stored", similarTo: verdict?.similarTo ?? null, shareBps: evaluation?.shareBps ?? null,
    metrics: { likes: post.likes, reposts: post.reposts, replies: post.replies, quotes: post.quotes },
  };
}

/**
 * Computes the promotion share from indexed holdings (frozen during Promotion) and stored (submitted) posts:
 *  - only posts created at/after promotionStart that contain the project tag AND the agent's one-time code;
 *  - one counted post per agent (earliest valid);
 *  - near-duplicate texts (3-gram Jaccard >= PROMO_SIMILARITY_THRESHOLD vs an already accepted post) are rejected;
 *  - launcher and platform addresses are excluded from numerator and denominator; sybil-flagged/removed agents
 *    can't be promoters (their NFTs still count in the denominator).
 */
export async function evaluateGate(ctx: AppContext, projectAddr: string): Promise<GateEvaluation> {
  const { db, t } = ctx.database;
  const addr = lc(projectAddr);
  const [p] = await db.select().from(t.projects).where(eq(t.projects.address, addr));
  if (!p) throw new ApiError(404, "not_found", "unknown project");
  const excluded = new Set([p.launcher, ...ctx.cfg.PLATFORM_ADDRESSES]);
  const holdings = new Map<string, number>();
  for (const r of await db.select({ owner: t.nftTokens.owner }).from(t.nftTokens).where(eq(t.nftTokens.project, addr))) {
    holdings.set(r.owner, (holdings.get(r.owner) ?? 0) + 1);
  }
  let eligibleTotal = 0;
  for (const [o, n] of holdings) if (!excluded.has(o)) eligibleTotal += n;

  const agents = new Map((await db.select().from(t.agents)).map((a) => [a.wallet, a] as const));
  const posts = (await db.select().from(t.xPosts).where(eq(t.xPosts.project, addr))).sort((a, b) =>
    a.createdAt === b.createdAt ? (a.tweetId < b.tweetId ? -1 : 1) : a.createdAt - b.createdAt,
  );
  const start = p.promotionStart ?? Number.MAX_SAFE_INTEGER;
  const counted = new Set<string>();
  const accepted: { id: string; sh: Set<string> }[] = [];
  const verdicts: GateEvaluation["verdicts"] = [];
  for (const post of posts) {
    const code = promoCode(ctx, addr, post.wallet);
    const agent = agents.get(post.wallet);
    let status = "accepted";
    let similarTo: string | null = null;
    if (post.createdAt < start) status = "too_early";
    else if (!post.text.toLowerCase().includes(p.tag.toLowerCase()) || !post.text.includes(code)) status = "no_code";
    else if (excluded.has(post.wallet)) status = "excluded";
    else if (!agent || agent.removed || agent.sybilFlag) status = "excluded";
    else if (!holdings.get(post.wallet)) status = "not_holder";
    else if (counted.has(post.wallet)) status = "agent_already_counted";
    else {
      const sh = shingles(normalizePostText(post.text, [code, p.tag]));
      const dup = accepted.find((a) => jaccard(a.sh, sh) >= ctx.cfg.PROMO_SIMILARITY_THRESHOLD);
      if (dup) {
        status = "duplicate_text";
        similarTo = dup.id;
      } else {
        accepted.push({ id: post.tweetId, sh });
        counted.add(post.wallet);
      }
    }
    verdicts.push({ tweetId: post.tweetId, wallet: post.wallet, status, similarTo });
    if (post.gateStatus !== status || post.similarTo !== similarTo) {
      await db.update(t.xPosts).set({ gateStatus: status, similarTo, hasCode: post.text.includes(code) }).where(eq(t.xPosts.tweetId, post.tweetId));
    }
  }
  const promoters = [...counted].sort();
  const promoterNfts = promoters.reduce((s, w) => s + (holdings.get(w) ?? 0), 0);
  const shareBps = eligibleTotal === 0 ? 0 : Math.floor((promoterNfts * 10_000) / eligibleTotal);
  return { project: addr, eligibleTotal, promoterNfts, shareBps, promoters, verdicts };
}

export function promoterTree(promoters: string[]) {
  return StandardMerkleTree.of(promoters.map((a) => [checksum(a)]), ["address"]);
}

/** Signs Promotion(project, shareBps, promoterRoot, nonce, deadline) and relays submitPromotion. */
export async function attest(ctx: AppContext, project: Address, ev: GateEvaluation) {
  const { db, t } = ctx.database;
  const tree = promoterTree(ev.promoters);
  const root = (ev.promoters.length ? tree.root : zeroHash) as Hex;
  const nonce = (await ctx.pc.readContract({ address: project, abi: BondingNFTAbi, functionName: "attestationNonce" })) as bigint;
  const deadline = BigInt((await chainNow(ctx.pc)) + 600);
  const shareBps = Math.min(ev.shareBps, 10_000);
  const signature = await ctx.signer.signTypedData({
    domain: registryDomain(ctx.cfg.CHAIN_ID, ctx.addresses.registry),
    types: PromotionTypes,
    primaryType: "Promotion",
    message: { project: checksum(project), shareBps, promoterRoot: root, nonce, deadline },
  });
  const id = `${lc(project)}:${nonce}`;
  const row = {
    id, project: lc(project), nonce: Number(nonce), shareBps, root, promoters: JSON.stringify(ev.promoters), tree: JSON.stringify(tree.dump()),
    signature, deadline: Number(deadline), status: "signed", createdAt: nowSec(),
  };
  await db.insert(t.attestations).values(row).onConflictDoUpdate({ target: t.attestations.id, set: row });
  const data = encodeFunctionData({ abi: BondingNFTAbi, functionName: "submitPromotion", args: [shareBps, root, deadline, signature] });
  const res = await runAdminTx(ctx, { kind: "submitPromotion", target: lc(project), to: project, data, reason: `share ${shareBps}bps` });
  await db
    .update(t.attestations)
    .set({ status: res.status === "confirmed" ? "submitted" : "failed", txHash: res.txHash ?? null, error: res.error ?? null })
    .where(eq(t.attestations.id, id));
  return { ...res, shareBps, root, nonce: Number(nonce) };
}

/**
 * One pass over all projects in the Promotion phase:
 *   share >= 50%                     -> attest now (graduates in the same tx)
 *   promoter set changed, share < 50% -> attest at most every PROMO_RESUBMIT_MIN_SEC, and once more in the last
 *                                       PROMO_FINAL_SUBMIT_SEC, so promoters keep their lock exemption on forced graduation
 *   promotionStart + 2h reached       -> graduate() (forced)
 */
export async function promotionTick(ctx: AppContext) {
  const { db, t } = ctx.database;
  const out: { project: string; action: string; shareBps?: number; txHash?: string; error?: string }[] = [];
  const rows = await db.select().from(t.projects).where(eq(t.projects.phase, 1));
  for (const p of rows) {
    const project = checksum(p.address);
    try {
      const phase = Number(await ctx.pc.readContract({ address: project, abi: BondingNFTAbi, functionName: "phase" }));
      if (phase !== 1) continue; // graduated on-chain; indexer will catch up
      const start = Number(await ctx.pc.readContract({ address: project, abi: BondingNFTAbi, functionName: "promotionStart" }));
      const now = await chainNow(ctx.pc);
      if (now >= start + PROMOTION_MAX) {
        const data = encodeFunctionData({ abi: BondingNFTAbi, functionName: "graduate" });
        const r = await runAdminTx(ctx, { kind: "graduate", target: p.address, to: project, data, reason: "forced after 2h" });
        out.push({ project: p.address, action: "graduate", txHash: r.txHash, error: r.error });
        continue;
      }
      const ev = await evaluateGate(ctx, p.address);
      const [last] = await db
        .select()
        .from(t.attestations)
        .where(and(eq(t.attestations.project, p.address), eq(t.attestations.status, "submitted")))
        .orderBy(desc(t.attestations.nonce))
        .limit(1);
      const changed = !last || JSON.stringify(JSON.parse(last.promoters)) !== JSON.stringify(ev.promoters);
      const remaining = start + PROMOTION_MAX - now;
      const sinceLast = last ? nowSec() - last.createdAt : Infinity;
      let reason: string | null = null;
      if (ev.promoters.length > 0 && ev.shareBps >= PROMOTION_THRESHOLD_BPS) reason = "threshold";
      else if (ev.promoters.length > 0 && changed && (sinceLast >= ctx.cfg.PROMO_RESUBMIT_MIN_SEC || remaining <= ctx.cfg.PROMO_FINAL_SUBMIT_SEC))
        reason = remaining <= ctx.cfg.PROMO_FINAL_SUBMIT_SEC ? "final_root" : "update_root";
      if (!reason) {
        out.push({ project: p.address, action: "wait", shareBps: ev.shareBps });
        continue;
      }
      const r = await attest(ctx, project, ev);
      out.push({ project: p.address, action: `attest:${reason}`, shareBps: ev.shareBps, txHash: r.txHash, error: r.error });
    } catch (e: any) {
      ctx.log.error(e, `promotion tick failed for ${p.address}`);
      out.push({ project: p.address, action: "error", error: String(e?.message ?? e) });
    }
  }
  return out;
}

/** Promoter Merkle proof for claimPromoterExemption(account, proof), from the latest submitted attestation. */
export async function promoterProof(ctx: AppContext, projectAddr: string, wallet: string) {
  const { db, t } = ctx.database;
  const [last] = await db
    .select()
    .from(t.attestations)
    .where(and(eq(t.attestations.project, lc(projectAddr)), eq(t.attestations.status, "submitted")))
    .orderBy(desc(t.attestations.nonce))
    .limit(1);
  if (!last) return null;
  const tree = StandardMerkleTree.load<[string]>(JSON.parse(last.tree));
  for (const [i, v] of tree.entries()) {
    if (lc(v[0]) === lc(wallet)) return { root: last.root, proof: tree.getProof(i), nonce: last.nonce };
  }
  return null;
}

export async function promotionStatus(ctx: AppContext, projectAddr: string) {
  const { db, t } = ctx.database;
  const [p] = await db.select().from(t.projects).where(eq(t.projects.address, lc(projectAddr)));
  if (!p) throw new ApiError(404, "not_found", "unknown project");
  const ev = p.phase >= 1 ? await evaluateGate(ctx, p.address) : null;
  const atts = await db.select().from(t.attestations).where(eq(t.attestations.project, p.address)).orderBy(desc(t.attestations.nonce));
  return {
    project: p.address, phase: p.phase, tag: p.tag, promotionStart: p.promotionStart,
    windowEnds: p.promotionStart ? p.promotionStart + 3600 : null, forceAt: p.promotionStart ? p.promotionStart + PROMOTION_MAX : null,
    thresholdBps: PROMOTION_THRESHOLD_BPS, evaluation: ev,
    attestations: atts.map((a) => ({ nonce: a.nonce, shareBps: a.shareBps, root: a.root, status: a.status, txHash: a.txHash, createdAt: a.createdAt })),
  };
}
