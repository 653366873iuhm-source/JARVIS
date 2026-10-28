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
import { isAddr, lc, nowSec, uuid } from "../lib/util.js";

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

export async function claimAirdrop(ctx: AppContext, body: { xHandle: string; wallet: string }, ip = "") {
  const xHandle = normalizeXHandle(body.xHandle);
  const wallet = normalizeWallet(body.wallet);
  const { db, t } = ctx.database;
  const dupe = async () => {
    const rows = await db.select().from(t.airdropClaims).where(or(eq(t.airdropClaims.xHandle, xHandle), eq(t.airdropClaims.wallet, wallet)));
    if (rows.some((r) => r.xHandle === xHandle)) throw new ApiError(409, "handle_already_claimed", "该推特账号已经领取过（一个推特号只能领一份）");
    if (rows.some((r) => r.wallet === wallet)) throw new ApiError(409, "wallet_already_claimed", "该钱包已经领取过（同一钱包只能领一份）");
  };
  await dupe();
  const now = nowSec();
  const row = { id: uuid(), xHandle, wallet, amount: AIRDROP_AMOUNT, status: "pending_verification", ipHash: ip ? ipHash(ctx, ip) : null, createdAt: now, updatedAt: now };
  try {
    await db.insert(t.airdropClaims).values(row);
  } catch (e) {
    await dupe(); // concurrent duplicate hit the unique index → report it as the matching 409
    throw e;
  }
  const { claimed } = await airdropStats(ctx);
  return { id: row.id, xHandle, wallet, amount: AIRDROP_AMOUNT, status: row.status as AirdropStatus, createdAt: now, claimed };
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
  const head = ["id", "x_handle", "x_url", "wallet", "amount", "status", "created_at_utc"];
  const lines = rows.map((r) =>
    [r.id, r.xHandle, `https://x.com/${r.xHandle}`, r.wallet, r.amount, r.status, new Date(Number(r.createdAt) * 1000).toISOString()].map(csvCell).join(","),
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
