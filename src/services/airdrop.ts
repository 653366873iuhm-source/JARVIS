/**
 * 发射台推特空投 — X airdrop campaign.
 * Rule: follow the official X account + repost the pinned post → claim 1000 NFT 凭证额度 (platform-internal NFT credits,
 * NOT a token, no promised return). One claim per X handle and one per wallet. Claims start as `pending_verification`;
 * an operator (manually / semi-automatically) checks the follow + repost and approves or rejects.
 * No X API call and no chain transaction happens here.
 */
import crypto from "node:crypto";
import { count, desc, eq, or } from "drizzle-orm";
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
}

const ipHash = (ctx: AppContext, ip: string) => crypto.createHmac("sha256", ctx.cfg.CODE_SECRET).update(`airdrop-ip:${ip}`).digest("hex").slice(0, 24);

export async function airdropStats(ctx: AppContext) {
  const { db, t } = ctx.database;
  const [r] = await db.select({ n: count() }).from(t.airdropClaims);
  return { claimed: Number(r?.n ?? 0), amountPerClaim: AIRDROP_AMOUNT };
}

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
  const dupe = async () => {
    const rows = await db
      .select()
      .from(t.airdropClaims)
      .where(or(eq(t.airdropClaims.xHandle, xHandle), eq(t.airdropClaims.wallet, wallet), eq(t.airdropClaims.agentId, agentId)));
    if (rows.some((r) => r.xHandle === xHandle)) throw new ApiError(409, "handle_already_claimed", "该推特账号已经领取过（一个推特号只能领一份）");
    if (rows.some((r) => r.wallet === wallet)) throw new ApiError(409, "wallet_already_claimed", "该钱包已经领取过（同一钱包只能领一份）");
    if (rows.some((r) => r.agentId === agentId)) throw new ApiError(409, "agent_id_already_claimed", "该 .ai Agent ID 已经领取过");
  };
  await dupe();
  // the .ai name must resolve (on-chain Agent ID registry) to exactly the submitted wallet
  let resolved;
  try {
    resolved = await ctx.resolver.resolve(agentId);
  } catch (e: any) {
    throw new ApiError(503, "agent_id_unavailable", `暂时无法查询 Agent ID，请稍后再试（${e?.message ?? e}）`);
  }
  if (!resolved) throw new ApiError(422, "agent_id_unresolved", `${agentId} 不存在或未绑定 BSC 地址（仅限持有 Binance Agent ID 的钱包）`);
  if (resolved.isFallback || !isAddressEqual(resolved.address, checksum(wallet)))
    throw new ApiError(422, "agent_id_mismatch", `${agentId} 属于 ${resolved.address}，不是你填写的钱包`);
  const now = nowSec();
  const row = {
    id: uuid(), xHandle, wallet, amount: AIRDROP_AMOUNT, status: "pending_verification", ipHash: ip ? ipHash(ctx, ip) : null,
    repostUrl, agentId, createdAt: now, updatedAt: now,
  };
  try {
    await db.insert(t.airdropClaims).values(row);
  } catch (e) {
    await dupe(); // concurrent duplicate hit the unique index → report it as the matching 409
    throw e;
  }
  const { claimed } = await airdropStats(ctx);
  return { id: row.id, xHandle, wallet, agentId, repostUrl, amount: AIRDROP_AMOUNT, status: row.status as AirdropStatus, createdAt: now, claimed };
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
    createdAt: r.createdAt, updatedAt: r.updatedAt, credential,
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
  const head = ["id", "x_handle", "x_url", "wallet", "agent_id", "repost_url", "amount", "status", "created_at_utc"];
  const lines = rows.map((r) =>
    [r.id, r.xHandle, `https://x.com/${r.xHandle}`, r.wallet, r.agentId ?? "", r.repostUrl ?? "", r.amount, r.status, new Date(Number(r.createdAt) * 1000).toISOString()].map(csvCell).join(","),
  );
  return [head.join(","), ...lines].join("\n") + "\n";
}

export async function setAirdropStatus(ctx: AppContext, id: string, status: AirdropStatus) {
  const { db, t } = ctx.database;
  const [r] = await db.select().from(t.airdropClaims).where(eq(t.airdropClaims.id, id));
  if (!r) throw new ApiError(404, "not_found", "unknown claim");
  await db.update(t.airdropClaims).set({ status, updatedAt: nowSec() }).where(eq(t.airdropClaims.id, id));
  return { ...r, status };
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
