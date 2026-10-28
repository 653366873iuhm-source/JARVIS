/**
 * 发射台推特空投 — X airdrop campaign.
 * Rule: follow the official X account + repost the pinned post → claim 1000 NFT 凭证额度 (platform-internal NFT credits,
 * NOT a token, no promised return). One claim per X handle and one per wallet. With AIRDROP_AUTO_APPROVE the submitted
 * post is fetched via FxTwitter and the claim is approved at once when it quotes / replies to AIRDROP_PINNED_TWEET_ID;
 * otherwise it stays `pending_verification` (sweep retries every 10 min) and an operator can approve / reject.
 * No X API call and no chain transaction happens here.
 */
import crypto from "node:crypto";
import { and, count, desc, eq, lt, or } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { ApiError } from "./registration.js";
import { isAddressEqual } from "viem";
import { checksum, isAddr, lc, nowSec, parseTweetId, uuid } from "../lib/util.js";
import { readCredential } from "./credential.js";

export const AIRDROP_AMOUNT = 1000;
export const AIRDROP_STATUSES = ["pending_verification", "approved", "rejected"] as const;
export type AirdropStatus = (typeof AIRDROP_STATUSES)[number];

/** Accepts "Alice_01", "@Alice_01", "x.com/Alice_01", "https://twitter.com/Alice_01?s=20" → "alice_01". */
export function normalizeXHandle(input: string): string {
  let h = String(input ?? "").trim();
  const m = h.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#\s]+)/i);
  if (m) h = m[1]!;
  h = h.replace(/^@+/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(h)) throw new ApiError(400, "invalid_x_handle", "X 用户名格式不正确（1–15 位字母、数字或下划线）");
  return h;
}
export function normalizeWallet(input: string): string {
  const w = String(input ?? "").trim();
  if (!isAddr(w)) throw new ApiError(400, "invalid_wallet", "BSC 钱包地址格式不正确（0x 开头 40 位十六进制）");
  if (/^0x0{40}$/i.test(w)) throw new ApiError(400, "invalid_wallet", "不能使用零地址");
  return lc(w);
}

/** "Alice.ai" / "alice" / "@alice.ai" → "alice.ai" (SPACE ID Agent ID label: 3–20 lowercase letters / digits). */
export function normalizeAgentName(input: string): string {
  const s = String(input ?? "").trim().toLowerCase().replace(/^@+/, "").replace(/\.ai$/, "");
  if (!/^[a-z0-9]{3,20}$/.test(s)) throw new ApiError(400, "invalid_agent_id", ".ai 名称格式不正确（3–20 位小写字母或数字，例如 alice.ai）");
  return `${s}.ai`;
}
/** X post URL of the user's repost / quote of the pinned post → "https://x.com/<user>/status/<id>". */
export function normalizeRepostUrl(input: string, xHandle: string): string {
  const s = String(input ?? "").trim();
  const id = /^https?:\/\//i.test(s) || /(?:x|twitter)\.com\//i.test(s) ? parseTweetId(s) : null;
  if (!id) throw new ApiError(400, "invalid_repost_url", "转发链接格式不正确（需要 x.com/<用户名>/status/<编号> 形式的帖子链接）");
  const m = s.match(/(?:x|twitter)\.com\/([^/?#\s]+)\/status/i);
  const user = m?.[1]?.toLowerCase();
  if (user && user !== "i" && user !== xHandle) throw new ApiError(422, "repost_wrong_author", `转发链接属于 @${user}，不是 @${xHandle}`);
  return `https://x.com/${xHandle}/status/${id}`;
}

/** Small in-memory sliding-window limiter (per process; good enough for a single free instance). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  take(key: string, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return true;
  }
  /** Gives one hit back (an idempotent repeat submission should not eat the user's attempts). */
  refund(key: string) {
    const arr = this.hits.get(key);
    if (arr?.length) arr.pop();
  }
}

const ipHash = (ctx: AppContext, ip: string) => crypto.createHmac("sha256", ctx.cfg.CODE_SECRET).update(`airdrop-ip:${ip}`).digest("hex").slice(0, 24);

export async function airdropStats(ctx: AppContext) {
  const { db, t } = ctx.database;
  const [r] = await db.select({ n: count() }).from(t.airdropClaims);
  return { claimed: Number(r?.n ?? 0), amountPerClaim: AIRDROP_AMOUNT };
}

// ---------------------------------------------------------------- auto-verification (FxTwitter, free, no X API)
/**
 * Result of checking a submitted post against the pinned post:
 *  - approve: the post quotes or replies to the pinned post and is authored by the claiming handle
 *  - reject:  the post was fetched and clearly does not reference the pinned post (or wrong author / plain retweet)
 *  - pending: could not decide now (FxTwitter down, post not visible yet) → the background sweep retries
 */
export type PostVerdict =
  | { verdict: "approve"; reason: "auto_quote" | "auto_reply" }
  | { verdict: "reject"; reason: string; message: string }
  | { verdict: "pending"; reason: "x_unavailable" | "post_not_found" | "auto_approve_off"; detail?: string };

const RETRYABLE_REASONS = ["x_unavailable", "post_not_found"] as const;

export async function verifyRepostPost(ctx: AppContext, postId: string, xHandle: string): Promise<PostVerdict> {
  const pinned = ctx.cfg.AIRDROP_PINNED_TWEET_ID;
  if (!ctx.cfg.AIRDROP_AUTO_APPROVE || !pinned || !ctx.x) return { verdict: "pending", reason: "auto_approve_off" };
  let post;
  try {
    post = await ctx.x.getPost(postId);
  } catch (e: any) {
    return { verdict: "pending", reason: "x_unavailable", detail: String(e?.message ?? e).slice(0, 200) };
  }
  if (!post) return { verdict: "pending", reason: "post_not_found" };
  if (postId === pinned) return { verdict: "reject", reason: "is_pinned_post", message: "你提交的是置顶帖本身的链接。请引用转发（Quote）或回复置顶帖，然后粘贴你自己那条帖子的链接" };
  if (post.authorUsername.toLowerCase() !== xHandle)
    return { verdict: "reject", reason: "wrong_author", message: `该帖子的作者是 @${post.authorUsername}，不是 @${xHandle}` };
  if (post.quoteOfId === pinned) return { verdict: "approve", reason: "auto_quote" };
  if (post.replyToId === pinned) return { verdict: "approve", reason: "auto_reply" };
  if (post.isRepost)
    return { verdict: "reject", reason: "plain_repost", message: "普通转发没有自己的链接，无法验证。请用「引用转发」（Quote）或回复置顶帖，再粘贴那条帖子的链接" };
  return {
    verdict: "reject", reason: "not_referencing_pinned",
    message: "该帖子没有引用或回复 ChyAI 置顶帖。请对置顶帖「引用转发」（Quote）或直接回复置顶帖，再粘贴那条帖子的链接",
  };
}

const postIdOf = (repostUrl: string | null | undefined) => (repostUrl ? parseTweetId(repostUrl) : null);

/**
 * Background sweep (every AIRDROP_VERIFY_SWEEP_MS): re-checks pending claims whose auto-verify could not decide
 * (FxTwitter down / post not visible yet). Approves on success; a definite "doesn't reference the pinned post"
 * becomes rejected (with reason). After AIRDROP_VERIFY_MAX_ATTEMPTS the claim stays pending for manual review.
 */
export async function airdropVerifySweep(ctx: AppContext) {
  const out = { checked: 0, approved: 0, rejected: 0, stillPending: 0 };
  if (!ctx.cfg.AIRDROP_AUTO_APPROVE || !ctx.cfg.AIRDROP_PINNED_TWEET_ID) return out;
  const { db, t } = ctx.database;
  const rows = await db
    .select()
    .from(t.airdropClaims)
    .where(and(eq(t.airdropClaims.status, "pending_verification"), lt(t.airdropClaims.verifyAttempts, ctx.cfg.AIRDROP_VERIFY_MAX_ATTEMPTS)))
    .limit(200);
  for (const r of rows) {
    if (r.reviewReason && !(RETRYABLE_REASONS as readonly string[]).includes(r.reviewReason) && r.reviewReason !== "auto_approve_off") continue;
    const id = postIdOf(r.repostUrl);
    if (!id) continue;
    out.checked++;
    const v = await verifyRepostPost(ctx, id, r.xHandle);
    const attempts = Number(r.verifyAttempts ?? 0) + 1;
    const status = v.verdict === "approve" ? "approved" : v.verdict === "reject" ? "rejected" : "pending_verification";
    if (v.verdict === "approve") out.approved++;
    else if (v.verdict === "reject") out.rejected++;
    else out.stillPending++;
    await db
      .update(t.airdropClaims)
      .set({ status, reviewReason: v.reason, verifyAttempts: attempts, updatedAt: nowSec() })
      .where(and(eq(t.airdropClaims.id, r.id), eq(t.airdropClaims.status, "pending_verification")));
  }
  if (out.checked) ctx.log.info(out, "airdrop verify sweep");
  return out;
}

/** Starts the 10-minute sweep (no-op unless auto-approve is configured). */
export function startAirdropVerifyTimer(ctx: AppContext) {
  if (!ctx.cfg.AIRDROP_AUTO_APPROVE || !ctx.cfg.AIRDROP_PINNED_TWEET_ID) return () => undefined;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await airdropVerifySweep(ctx);
    } catch (e) {
      ctx.log.error(e, "airdrop verify sweep failed");
    } finally {
      running = false;
    }
  }, ctx.cfg.AIRDROP_VERIFY_SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

const PENDING_MESSAGES: Record<string, string> = {
  x_unavailable: "推特数据源暂时不可用，系统将每 10 分钟自动重试验证",
  post_not_found: "暂时查不到该帖子（可能刚发布或账号受保护），系统将每 10 分钟自动重试验证",
  auto_approve_off: "等待人工审核",
};
export const reviewMessage = (status: string, reason: string | null | undefined) =>
  status === "approved" ? "已通过，可以铸造凭证" : status === "rejected" ? "未通过" : (reason && PENDING_MESSAGES[reason]) || "等待审核";

export interface ClaimInput {
  xHandle: string;
  wallet: string;
  repostUrl: string;
  agentName: string;
}

export async function claimAirdrop(ctx: AppContext, body: ClaimInput, ip = "") {
  const xHandle = normalizeXHandle(body.xHandle);
  const wallet = normalizeWallet(body.wallet);
  const agentId = normalizeAgentName(body.agentName);
  const repostUrl = normalizeRepostUrl(body.repostUrl, xHandle);
  const { db, t } = ctx.database;
  const findRows = () =>
    db
      .select()
      .from(t.airdropClaims)
      .where(or(eq(t.airdropClaims.xHandle, xHandle), eq(t.airdropClaims.wallet, wallet), eq(t.airdropClaims.agentId, agentId)));
  const dupe = (rows: Awaited<ReturnType<typeof findRows>>) => {
    // the same person submitting again (same wallet + X handle + .ai) is idempotent: return / re-check their claim
    const mine = rows.find((r) => r.wallet === wallet && r.xHandle === xHandle && r.agentId === agentId);
    if (mine) return mine;
    const byWallet = rows.find((r) => r.wallet === wallet);
    if (rows.some((r) => r.xHandle === xHandle)) throw new ApiError(409, "handle_already_claimed", "该推特账号已经领取过（一个推特号只能领一份）");
    if (byWallet)
      throw new ApiError(409, "wallet_already_claimed", `该钱包已经提交过申请（@${byWallet.xHandle} / ${byWallet.agentId ?? "-"}），请用同样的信息查询或继续 mint`, {
        status: byWallet.status,
      });
    if (rows.some((r) => r.agentId === agentId)) throw new ApiError(409, "agent_id_already_claimed", "该 .ai Agent ID 已经领取过");
    return null;
  };
  const existing = dupe(await findRows());
  if (existing) return resubmitClaim(ctx, existing, repostUrl);
  // the .ai name must resolve (on-chain Agent ID registry) to exactly the submitted wallet
  await assertAgentIdOwner(ctx, agentId, wallet);
  // auto-verify the submitted post against the pinned post (quote / reply by the same handle)
  const v = await verifyRepostPost(ctx, parseTweetId(repostUrl)!, xHandle);
  if (v.verdict === "reject") throw new ApiError(422, `repost_${v.reason}`, v.message);
  const now = nowSec();
  const row = {
    id: uuid(), xHandle, wallet, amount: AIRDROP_AMOUNT, status: v.verdict === "approve" ? "approved" : "pending_verification",
    ipHash: ip ? ipHash(ctx, ip) : null, repostUrl, agentId, reviewReason: v.reason, verifyAttempts: v.reason === "auto_approve_off" ? 0 : 1,
    createdAt: now, updatedAt: now,
  };
  try {
    await db.insert(t.airdropClaims).values(row);
  } catch (e) {
    // concurrent duplicate (double click / two tabs) hit the unique index → same person: return their claim
    const again = dupe(await findRows());
    if (again) return resubmitClaim(ctx, again, repostUrl);
    throw e;
  }
  const { claimed } = await airdropStats(ctx);
  return {
    id: row.id, xHandle, wallet, agentId, repostUrl, amount: AIRDROP_AMOUNT, status: row.status as AirdropStatus, reason: row.reviewReason,
    message: reviewMessage(row.status, row.reviewReason), createdAt: now, claimed, existing: false, next: nextStep(row.status),
  };
}

const nextStep = (status: string) => (status === "approved" ? "mint" : status === "rejected" ? "resubmit" : "wait");

async function assertAgentIdOwner(ctx: AppContext, agentId: string, wallet: string) {
  let resolved;
  try {
    resolved = await ctx.resolver.resolve(agentId);
  } catch (e: any) {
    throw new ApiError(503, "agent_id_unavailable", `暂时无法查询 Agent ID，请稍后再试（${e?.message ?? e}）`);
  }
  if (!resolved) throw new ApiError(422, "agent_id_unresolved", `${agentId} 不存在或未绑定 BSC 地址（仅限持有 Binance Agent ID 的钱包）`);
  if (resolved.isFallback || !isAddressEqual(resolved.address, checksum(wallet)))
    throw new ApiError(422, "agent_id_mismatch", `${agentId} 属于 ${resolved.address}，不是你填写的钱包`);
}

type ClaimRow = typeof import("../db/schema.sqlite.js").airdropClaims.$inferSelect;

/**
 * Repeat submission by the same wallet + X handle + .ai (idempotent, HTTP 200):
 *  - approved → returned as is (next step: mint)
 *  - pending / rejected → the (possibly new) post link is re-verified now; approve → approved, still undecided →
 *    stays pending (sweep retries), clearly not referencing the pinned post → 422 with the reason (row unchanged).
 */
export async function resubmitClaim(ctx: AppContext, r: ClaimRow, repostUrl: string) {
  const { db, t } = ctx.database;
  let row = r;
  if (r.status !== "approved") {
    const v = await verifyRepostPost(ctx, parseTweetId(repostUrl)!, r.xHandle);
    if (v.verdict === "reject") throw new ApiError(422, `repost_${v.reason}`, v.message, { status: r.status, existing: true });
    const status = v.verdict === "approve" ? "approved" : "pending_verification";
    const set = { status, repostUrl, reviewReason: v.reason, verifyAttempts: v.reason === "auto_approve_off" ? 0 : 1, updatedAt: nowSec() };
    await db.update(t.airdropClaims).set(set).where(eq(t.airdropClaims.id, r.id));
    row = { ...r, ...set };
  }
  const { claimed } = await airdropStats(ctx);
  return {
    id: row.id, xHandle: row.xHandle, wallet: row.wallet, agentId: row.agentId, repostUrl: row.repostUrl, amount: row.amount,
    status: row.status as AirdropStatus, reason: row.reviewReason ?? null, message: reviewMessage(row.status, row.reviewReason),
    createdAt: row.createdAt, claimed, existing: true, next: nextStep(row.status),
  };
}

/**
 * INTERNAL TESTING ONLY (admin): creates an APPROVED claim without any X post check. The .ai name must still
 * resolve on-chain to the wallet, and the usual one-per-handle / wallet / .ai limits apply.
 */
export async function adminTestApprove(ctx: AppContext, body: { xHandle: string; wallet: string; aiName: string }) {
  const xHandle = normalizeXHandle(body.xHandle);
  const wallet = normalizeWallet(body.wallet);
  const agentId = normalizeAgentName(body.aiName);
  const { db, t } = ctx.database;
  const rows = await db
    .select()
    .from(t.airdropClaims)
    .where(or(eq(t.airdropClaims.xHandle, xHandle), eq(t.airdropClaims.wallet, wallet), eq(t.airdropClaims.agentId, agentId)));
  if (rows.some((r) => r.xHandle === xHandle)) throw new ApiError(409, "handle_already_claimed", "该推特账号已经领取过");
  if (rows.some((r) => r.wallet === wallet)) throw new ApiError(409, "wallet_already_claimed", "该钱包已经领取过");
  if (rows.some((r) => r.agentId === agentId)) throw new ApiError(409, "agent_id_already_claimed", "该 .ai Agent ID 已经领取过");
  let resolved;
  try {
    resolved = await ctx.resolver.resolve(agentId);
  } catch (e: any) {
    throw new ApiError(503, "agent_id_unavailable", `暂时无法查询 Agent ID，请稍后再试（${e?.message ?? e}）`);
  }
  if (!resolved) throw new ApiError(422, "agent_id_unresolved", `${agentId} 不存在或未绑定 BSC 地址`);
  if (resolved.isFallback || !isAddressEqual(resolved.address, checksum(wallet)))
    throw new ApiError(422, "agent_id_mismatch", `${agentId} 属于 ${resolved.address}，不是你填写的钱包`);
  const now = nowSec();
  const row = {
    id: uuid(), xHandle, wallet, amount: AIRDROP_AMOUNT, status: "approved", ipHash: null, repostUrl: null, agentId,
    reviewReason: "admin_test", verifyAttempts: 0, createdAt: now, updatedAt: now,
  };
  await db.insert(t.airdropClaims).values(row);
  ctx.log.warn({ id: row.id, xHandle, wallet, agentId }, "airdrop admin TEST claim approved (X check skipped)");
  return { id: row.id, xHandle, wallet, agentId, amount: AIRDROP_AMOUNT, status: "approved" as AirdropStatus, reason: "admin_test", createdAt: now };
}

/** Public status of a wallet's claim (no IP hash), plus on-chain credential state. */
export async function airdropStatus(ctx: AppContext, walletIn: string) {
  const wallet = normalizeWallet(walletIn);
  const { db, t } = ctx.database;
  const [r] = await db.select().from(t.airdropClaims).where(eq(t.airdropClaims.wallet, wallet));
  let credential = null;
  try {
    credential = await readCredential(ctx, wallet);
  } catch {
    credential = null;
  }
  if (!r) return { wallet, claimed: false, credential };
  return {
    wallet, claimed: true, id: r.id, xHandle: r.xHandle, agentId: r.agentId, repostUrl: r.repostUrl, amount: r.amount, status: r.status,
    reason: r.reviewReason ?? null, message: reviewMessage(r.status, r.reviewReason), createdAt: r.createdAt, updatedAt: r.updatedAt, credential,
  };
}

export async function listAirdropClaims(ctx: AppContext) {
  const { db, t } = ctx.database;
  return db.select().from(t.airdropClaims).orderBy(desc(t.airdropClaims.createdAt));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // spreadsheet formula-injection guard
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export async function airdropClaimsCsv(ctx: AppContext): Promise<string> {
  const rows = await listAirdropClaims(ctx);
  const head = ["id", "x_handle", "x_url", "wallet", "agent_id", "repost_url", "amount", "status", "review_reason", "created_at_utc"];
  const lines = rows.map((r) =>
    [r.id, r.xHandle, `https://x.com/${r.xHandle}`, r.wallet, r.agentId ?? "", r.repostUrl ?? "", r.amount, r.status, r.reviewReason ?? "", new Date(Number(r.createdAt) * 1000).toISOString()].map(csvCell).join(","),
  );
  return [head.join(","), ...lines].join("\n") + "\n";
}

export async function setAirdropStatus(ctx: AppContext, id: string, status: AirdropStatus) {
  const { db, t } = ctx.database;
  const [r] = await db.select().from(t.airdropClaims).where(eq(t.airdropClaims.id, id));
  if (!r) throw new ApiError(404, "not_found", "unknown claim");
  await db.update(t.airdropClaims).set({ status, reviewReason: "manual", updatedAt: nowSec() }).where(eq(t.airdropClaims.id, id));
  return { ...r, status, reviewReason: "manual" };
}

/** Read-only .ai → wallet lookup (on-chain Agent ID registry via ctx.resolver). */
export async function resolveAgentName(ctx: AppContext, nameIn: string) {
  const name = normalizeAgentName(nameIn);
  let r;
  try {
    r = await ctx.resolver.resolve(name);
  } catch (e: any) {
    throw new ApiError(503, "agent_id_unavailable", `暂时无法查询 Agent ID，请稍后再试（${e?.message ?? e}）`);
  }
  if (!r || r.isFallback) throw new ApiError(404, "agent_id_unresolved", `${name} 不存在或未绑定 BSC 地址`);
  return { name, wallet: checksum(r.address) };
}
