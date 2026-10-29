/**
 * 空投邀请 — airdrop invites.
 *
 *  - Every credential holder has an invite link: `<site>/#/airdrop?ref=<name>.ai` (or `?ref=<wallet>`).
 *  - The invitee's airdrop claim carries `ref`; the binding is made once, when they apply (first touch, immutable).
 *  - The inviter's mining speed gets +INVITE_BOOST_PER_INVITEE (5%) for every QUALIFIED invitee, capped at
 *    INVITE_BOOST_CAP (+50%). Qualified = the invitee minted a credential (mining account with credit > 0),
 *    has a unique .ai (one claim per .ai is enforced by the claims table). Optional extra gates (both 0 = off by
 *    default since 2026-10-29): X account age ≥ INVITE_MIN_X_AGE_DAYS and check-ins on ≥ INVITE_MIN_CHECKIN_DAYS days.
 *  - No self-invites (same wallet / X handle / .ai), at most INVITE_MAX_PER_INVITER invitees per inviter, and the
 *    inviter must hold an active credential at bind time.
 *
 * Storage: the generic `kv` table (no schema migration): `invite:by:<invitee>` → binding JSON and
 * `invite:of:<inviter>:<invitee>` → the same JSON (prefix scans for an inviter's list and the leaderboard).
 */
import { count, eq, inArray, like } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { checksum, isAddr, lc, nowSec } from "../lib/util.js";
import { readCredential } from "./credential.js";
import { isHiddenWallet } from "./hidden.js";
import { ApiError } from "./registration.js";

const DAY = 86400;
export interface InviteBinding {
  inviter: string; // lowercase wallet
  invitee: string; // lowercase wallet
  ref: string; // what the invitee submitted (normalized)
  inviteeXHandle: string;
  inviteeAgentId: string;
  xCreatedAt: number | null; // invitee X account creation (unix s); null = not known yet (re-checked later)
  boundAt: number;
}
const byKey = (invitee: string) => `invite:by:${lc(invitee)}`;
const ofKey = (inviter: string, invitee: string) => `invite:of:${lc(inviter)}:${lc(invitee)}`;

/** "Alice.ai" / "@alice" / "0xAbc…" → "alice.ai" | "0xabc…" | null (invalid). */
export function normalizeRef(input: unknown): string | null {
  const s: string = String(input ?? "").trim();
  if (!s) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase();
  const n = s.toLowerCase().replace(/^@+/, "").replace(/\.ai$/, "");
  return /^[a-z0-9]{3,20}$/.test(n) ? `${n}.ai` : null;
}

/** Invite link of a wallet (its .ai name when it has one, else the wallet). Hash routing like the deployed site. */
export function inviteLink(ctx: AppContext, ref: string) {
  const base = ctx.cfg.PUBLIC_APP_URL.replace(/\/+$/, "");
  return `${base}${ctx.cfg.PUBLIC_APP_ROUTER === "path" ? "" : "/#"}/airdrop?ref=${encodeURIComponent(ref)}`;
}

async function claimByRef(ctx: AppContext, ref: string) {
  const { db, t } = ctx.database;
  const col = ref.startsWith("0x") ? t.airdropClaims.wallet : t.airdropClaims.agentId;
  const [r] = await db.select().from(t.airdropClaims).where(eq(col, ref));
  return r ?? null;
}

async function kvGet(ctx: AppContext, key: string) {
  const { db, t } = ctx.database;
  const [r] = await db.select().from(t.kv).where(eq(t.kv.key, key));
  return r ? (JSON.parse(r.value) as InviteBinding) : null;
}
async function kvPut(ctx: AppContext, key: string, v: InviteBinding) {
  const { db, t } = ctx.database;
  const value = JSON.stringify(v);
  await db.insert(t.kv).values({ key, value }).onConflictDoUpdate({ target: t.kv.key, set: { value } });
}
async function listOf(ctx: AppContext, inviter: string): Promise<InviteBinding[]> {
  const { db, t } = ctx.database;
  const rows = await db.select().from(t.kv).where(like(t.kv.key, `invite:of:${lc(inviter)}:%`));
  return rows.map((r) => JSON.parse(r.value) as InviteBinding);
}
async function allBindings(ctx: AppContext): Promise<InviteBinding[]> {
  const { db, t } = ctx.database;
  const rows = await db.select().from(t.kv).where(like(t.kv.key, "invite:of:%"));
  return rows.map((r) => JSON.parse(r.value) as InviteBinding);
}

async function xCreatedAt(ctx: AppContext, handle: string): Promise<number | null> {
  try {
    const u = await ctx.x?.getUserByUsername(handle);
    return u && Number.isFinite(u.createdAt) && u.createdAt > 0 ? u.createdAt : null;
  } catch {
    return null;
  }
}

export type BindResult = { bound: boolean; inviter?: string; ref?: string; existing?: boolean; reason?: string; message?: string };

/**
 * Binds `invitee` to the inviter named by `ref` (called when the invitee applies). Never throws for invite problems:
 * the claim itself goes through and the result says why no binding was made.
 */
export async function bindInvite(ctx: AppContext, inv: { wallet: string; xHandle: string; agentId: string }, refIn: unknown): Promise<BindResult | null> {
  if (refIn === undefined || refIn === null || refIn === "") return null;
  const ref = normalizeRef(refIn);
  if (!ref) return { bound: false, reason: "invalid_ref", message: "邀请码格式不正确（.ai 名称或钱包地址）" };
  const invitee = lc(inv.wallet);
  const existing = await kvGet(ctx, byKey(invitee));
  if (existing) return { bound: true, existing: true, inviter: checksum(existing.inviter), ref: existing.ref };
  const c = await claimByRef(ctx, ref);
  if (!c) return { bound: false, reason: "inviter_not_found", message: "邀请人不存在（需要已申请空投并 mint 凭证）" };
  if (c.wallet === invitee || c.xHandle === inv.xHandle || (c.agentId && c.agentId === inv.agentId))
    return { bound: false, reason: "self_invite", message: "不能邀请自己" };
  let cred;
  try {
    cred = await readCredential(ctx, c.wallet, true);
  } catch {
    cred = null;
  }
  if (!cred?.active) return { bound: false, reason: "inviter_no_credential", message: "邀请人还没有 mint 凭证，邀请未绑定" };
  const mine = await listOf(ctx, c.wallet);
  if (mine.length >= ctx.cfg.INVITE_MAX_PER_INVITER)
    return { bound: false, reason: "invite_cap_reached", message: `邀请人已达邀请上限（${ctx.cfg.INVITE_MAX_PER_INVITER} 人）` };
  const b: InviteBinding = {
    inviter: c.wallet, invitee, ref, inviteeXHandle: inv.xHandle, inviteeAgentId: inv.agentId,
    xCreatedAt: await xCreatedAt(ctx, inv.xHandle), boundAt: nowSec(),
  };
  // by-key first: a concurrent second bind for the same invitee loses on the primary key
  const { db, t } = ctx.database;
  const ins = await db.insert(t.kv).values({ key: byKey(invitee), value: JSON.stringify(b) }).onConflictDoNothing().returning();
  if (!ins.length) {
    const again = await kvGet(ctx, byKey(invitee));
    return { bound: true, existing: true, inviter: again ? checksum(again.inviter) : undefined, ref: again?.ref };
  }
  await kvPut(ctx, ofKey(c.wallet, invitee), b);
  return { bound: true, existing: false, inviter: checksum(c.wallet), ref };
}

export interface InviteeProgress {
  wallet: string;
  agentId: string | null;
  boundAt: number;
  minted: boolean;
  checkinDays: number;
  xAgeOk: boolean | null; // null = X account age not known yet
  qualified: boolean;
}

/** Progress of each invitee of `inviter` (batched DB reads; X age re-checked for at most `xRefresh` unknowns). */
export async function inviteProgress(ctx: AppContext, inviter: string, now = nowSec(), xRefresh = 3): Promise<InviteeProgress[]> {
  const list = await listOf(ctx, inviter);
  if (!list.length) return [];
  const { db, t } = ctx.database;
  const wallets = list.map((b) => b.invitee);
  const [accts, cis] = await Promise.all([
    db.select({ w: t.miningAccounts.wallet, credit: t.miningAccounts.credit }).from(t.miningAccounts).where(inArray(t.miningAccounts.wallet, wallets)),
    db.select({ w: t.miningCheckins.wallet, n: count() }).from(t.miningCheckins).where(inArray(t.miningCheckins.wallet, wallets)).groupBy(t.miningCheckins.wallet),
  ]);
  const credit = new Map(accts.map((a) => [a.w, Number(a.credit)] as const));
  const days = new Map(cis.map((c) => [c.w, Number(c.n)] as const));
  let refreshed = 0;
  const out: InviteeProgress[] = [];
  for (const b of list) {
    if (b.xCreatedAt == null && refreshed < xRefresh) {
      refreshed++;
      const x = await xCreatedAt(ctx, b.inviteeXHandle);
      if (x != null) {
        b.xCreatedAt = x;
        await kvPut(ctx, byKey(b.invitee), b);
        await kvPut(ctx, ofKey(b.inviter, b.invitee), b);
      }
    }
    const minted = (credit.get(b.invitee) ?? 0) > 0;
    const checkinDays = days.get(b.invitee) ?? 0;
    const xAgeOk = b.xCreatedAt == null ? null : now - b.xCreatedAt >= ctx.cfg.INVITE_MIN_X_AGE_DAYS * DAY;
    out.push({
      wallet: checksum(b.invitee), agentId: b.inviteeAgentId ?? null, boundAt: b.boundAt, minted, checkinDays, xAgeOk,
      qualified: minted && !!b.inviteeAgentId && (ctx.cfg.INVITE_MIN_X_AGE_DAYS <= 0 || xAgeOk === true) && checkinDays >= ctx.cfg.INVITE_MIN_CHECKIN_DAYS,
    });
  }
  return out.sort((a, b) => b.boundAt - a.boundAt);
}

export const inviteBoostOf = (cfg: AppContext["cfg"], qualified: number) => Math.min(cfg.INVITE_BOOST_CAP, Math.max(0, qualified) * cfg.INVITE_BOOST_PER_INVITEE);

/** Qualified invitee count of a wallet (used by the mining rate; no X refresh on this hot path). */
export async function qualifiedInviteCount(ctx: AppContext, inviter: string, now = nowSec()) {
  const p = await inviteProgress(ctx, inviter, now, 0);
  return { invited: p.length, qualified: p.filter((x) => x.qualified).length };
}

/** GET /v1/airdrop/invites/:wallet — the "my invites" card. */
export async function getInvites(ctx: AppContext, walletIn: string) {
  const s = String(walletIn ?? "").trim();
  if (!isAddr(s)) throw new ApiError(400, "invalid_wallet", "BSC 钱包地址格式不正确（0x 开头 40 位十六进制）");
  const wallet = lc(s);
  const { db, t } = ctx.database;
  const [claim] = await db.select().from(t.airdropClaims).where(eq(t.airdropClaims.wallet, wallet));
  let active = false;
  try {
    active = !!(await readCredential(ctx, wallet)).active;
  } catch {
    active = false;
  }
  const ref = claim?.agentId ?? wallet;
  const invitees = await inviteProgress(ctx, wallet);
  const qualified = invitees.filter((i) => i.qualified).length;
  const inv = await kvGet(ctx, byKey(wallet));
  const c = ctx.cfg;
  return {
    wallet: checksum(wallet),
    eligible: active, // only credential holders get an invite link
    ref: active ? ref : null,
    link: active ? inviteLink(ctx, ref) : null,
    invited: invitees.length,
    qualified,
    boost: inviteBoostOf(c, qualified),
    invitedBy: inv ? checksum(inv.inviter) : null,
    rules: {
      boostPerInvitee: c.INVITE_BOOST_PER_INVITEE, boostCap: c.INVITE_BOOST_CAP, maxInvitees: c.INVITE_MAX_PER_INVITER,
      minCheckinDays: c.INVITE_MIN_CHECKIN_DAYS, minXAccountAgeDays: c.INVITE_MIN_X_AGE_DAYS,
    },
    invitees,
    asOf: nowSec(),
  };
}

/** GET /v1/airdrop/invites/leaderboard — inviters by qualified invitees, then by invitees bound. */
export async function inviteLeaderboard(ctx: AppContext, limit = 50) {
  const all = (await allBindings(ctx)).filter((b) => !isHiddenWallet(ctx.cfg, b.inviter) && !isHiddenWallet(ctx.cfg, b.invitee));
  const inviters = [...new Set(all.map((b) => b.inviter))];
  const { db, t } = ctx.database;
  const names = inviters.length
    ? new Map((await db.select({ w: t.airdropClaims.wallet, a: t.airdropClaims.agentId }).from(t.airdropClaims).where(inArray(t.airdropClaims.wallet, inviters))).map((r) => [r.w, r.a] as const))
    : new Map<string, string | null>();
  const now = nowSec();
  const rows = [];
  for (const w of inviters) {
    const { invited, qualified } = await qualifiedInviteCount(ctx, w, now);
    rows.push({ wallet: checksum(w), agentId: names.get(w) ?? null, invited, qualified, boost: inviteBoostOf(ctx.cfg, qualified) });
  }
  rows.sort((a, b) => b.qualified - a.qualified || b.invited - a.invited || (a.wallet < b.wallet ? -1 : 1));
  return { asOf: now, items: rows.slice(0, Math.max(1, Math.min(200, limit))).map((r, i) => ({ rank: i + 1, ...r })) };
}

/** Start of the current invite week: Monday 00:00 Asia/Shanghai (UTC+8, no DST), as unix seconds. */
export function inviteWeekStart(now = nowSec()) {
  const OFF = 8 * 3600;
  const day = Math.floor((now + OFF) / DAY); // days since 1970-01-01 (a Thursday) on the UTC+8 clock
  const dow = (day + 3) % 7; // 0 = Monday
  return (day - dow) * DAY - OFF;
}

/** GET /v1/airdrop/invites/leaderboard?period=week — inviters ranked by invitees bound since Monday 00:00 UTC+8
 *  (qualified first, then bound), top 10 by default. Display only: no boost/reward fields. */
export async function weeklyInviteLeaderboard(ctx: AppContext, limit = 10, now = nowSec()) {
  const since = inviteWeekStart(now);
  const recent = (await allBindings(ctx)).filter(
    (b) => b.boundAt >= since && !isHiddenWallet(ctx.cfg, b.inviter) && !isHiddenWallet(ctx.cfg, b.invitee),
  );
  const inviters = [...new Set(recent.map((b) => b.inviter))];
  const { db, t } = ctx.database;
  const names = inviters.length
    ? new Map((await db.select({ w: t.airdropClaims.wallet, a: t.airdropClaims.agentId }).from(t.airdropClaims).where(inArray(t.airdropClaims.wallet, inviters))).map((r) => [r.w, r.a] as const))
    : new Map<string, string | null>();
  const rows = [];
  for (const w of inviters) {
    const p = (await inviteProgress(ctx, w, now, 0)).filter((x) => x.boundAt >= since && !isHiddenWallet(ctx.cfg, x.wallet));
    if (!p.length) continue;
    rows.push({ wallet: checksum(w), agentId: names.get(w) ?? null, invited: p.length, qualified: p.filter((x) => x.qualified).length });
  }
  rows.sort((a, b) => b.qualified - a.qualified || b.invited - a.invited || (a.wallet < b.wallet ? -1 : 1));
  return { asOf: now, period: "week" as const, since, items: rows.slice(0, Math.max(1, Math.min(50, limit))).map((r, i) => ({ rank: i + 1, ...r })) };
}

/** Admin/test helper: the binding of an invitee, if any. */
export const inviteOf = (ctx: AppContext, invitee: string) => kvGet(ctx, byKey(invitee));
