/**
 * 挖矿积分 — off-chain mining points for ChyAICredential holders.
 * 积分将按规则兑换平台币，具体比例与时间另行公告，不承诺收益。
 *
 *   rate/day = credit / 1000 × MINING_POINTS_PER_1000_CREDIT_DAY × multiplier
 *   multiplier = 1 + min(LAUNCH_CAP, launches × LAUNCH_BOOST) + min(VOLUME_CAP, volumeBNB(window) × VOLUME_BOOST_PER_BNB)
 *   launches / volume come from the chain indexer (projects.launcher, trades.trader on ChyAI's bonding curves).
 *   + daily 签到: MINING_CHECKIN_POINTS once per wallet per UTC day, proven by a wallet signature (EIP-191 / ERC-1271).
 * Accrual is settled lazily (on read / check-in) and starts the first time the wallet is seen holding a credential.
 * Points are stored as integer milli-points.
 */
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import type { Hex } from "viem";
import type { AppContext } from "../context.js";
import { checksum, lc, nowSec, uuid } from "../lib/util.js";
import { ApiError } from "./registration.js";
import { normalizeWallet } from "./airdrop.js";
import { readCredential } from "./credential.js";
import { verifyAgentSignature } from "./sigverify.js";

const DAY = 86400;
const WEI_PER_BNB = 10n ** 18n;

export const utcDay = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
export const nextUtcMidnight = (ts: number) => (Math.floor(ts / DAY) + 1) * DAY;
const pts = (milli: number) => Math.floor(milli) / 1000;

/** Exact text the wallet signs for 签到 (personal_sign). Valid only on that UTC day. */
export function checkinMessage(wallet: string, day: string, chainId: number) {
  return ["ChyAI 挖矿签到 / ChyAI mining check-in", `Wallet: ${checksum(wallet)}`, `Date (UTC): ${day}`, `Chain ID: ${chainId}`].join("\n");
}

export interface Activity {
  launches: number;
  volumeWei: string;
  volumeBnb: number;
  windowDays: number;
}

export async function walletActivity(ctx: AppContext, wallet: string, now = nowSec()): Promise<Activity> {
  const { db, t } = ctx.database;
  const w = lc(wallet);
  const [l] = await db.select({ n: count() }).from(t.projects).where(eq(t.projects.launcher, w));
  const since = now - ctx.cfg.MINING_VOLUME_WINDOW_DAYS * DAY;
  const rows = await db.select({ bnbWei: t.trades.bnbWei }).from(t.trades).where(and(eq(t.trades.trader, w), gte(t.trades.ts, since)));
  let vol = 0n;
  for (const r of rows) {
    try {
      vol += BigInt(r.bnbWei);
    } catch {
      /* skip malformed */
    }
  }
  return { launches: Number(l?.n ?? 0), volumeWei: vol.toString(), volumeBnb: Number((vol * 10_000n) / WEI_PER_BNB) / 10_000, windowDays: ctx.cfg.MINING_VOLUME_WINDOW_DAYS };
}

export function computeRate(cfg: AppContext["cfg"], credit: number, act: Activity) {
  const launchBoost = Math.min(cfg.MINING_LAUNCH_BOOST_CAP, act.launches * cfg.MINING_LAUNCH_BOOST);
  const volumeBoost = Math.min(cfg.MINING_VOLUME_BOOST_CAP, act.volumeBnb * cfg.MINING_VOLUME_BOOST_PER_BNB);
  const multiplier = 1 + launchBoost + volumeBoost;
  const base = (credit / 1000) * cfg.MINING_POINTS_PER_1000_CREDIT_DAY;
  const rateMilli = Math.round(base * multiplier * 1000);
  return { basePerDay: base, launchBoost, volumeBoost, multiplier, rateMilli };
}

type Account = typeof import("../db/schema.sqlite.js").miningAccounts.$inferSelect;

const liveMilli = (a: Account, now: number) => a.pointsMilli + Math.floor((a.rateMilliPerDay * Math.max(0, now - a.lastAccrualAt)) / DAY);

/** Settle accrual up to `now` and switch to the current rate. Returns the (possibly new) account row or null. */
async function settle(ctx: AppContext, wallet: string, now: number) {
  const { db, t } = ctx.database;
  const cred = await readCredential(ctx, wallet);
  const credit = cred.active ? cred.credit : 0;
  const act = await walletActivity(ctx, wallet, now);
  const rate = computeRate(ctx.cfg, credit, act);
  for (let attempt = 0; attempt < 3; attempt++) {
    const [a] = await db.select().from(t.miningAccounts).where(eq(t.miningAccounts.wallet, wallet));
    if (!a) {
      if (credit <= 0) return { account: null, cred, act, rate };
      const row = { wallet, pointsMilli: 0, checkinMilli: 0, rateMilliPerDay: rate.rateMilli, credit, lastAccrualAt: now, createdAt: now, updatedAt: now };
      const ins = await db.insert(t.miningAccounts).values(row).onConflictDoNothing().returning();
      if (ins.length) return { account: ins[0] as Account, cred, act, rate };
      continue; // raced with another settle → reload
    }
    const pointsMilli = liveMilli(a, now);
    // optimistic lock on lastAccrualAt so concurrent settles never accrue the same interval twice
    const upd = await db
      .update(t.miningAccounts)
      .set({ pointsMilli, rateMilliPerDay: rate.rateMilli, credit, lastAccrualAt: Math.max(now, a.lastAccrualAt), updatedAt: now })
      .where(and(eq(t.miningAccounts.wallet, wallet), eq(t.miningAccounts.lastAccrualAt, a.lastAccrualAt)))
      .returning();
    if (upd.length) return { account: upd[0] as Account, cred, act, rate };
  }
  throw new ApiError(503, "busy", "请稍后再试");
}

export async function getMining(ctx: AppContext, walletIn: string) {
  const wallet = normalizeWallet(walletIn);
  const now = nowSec();
  const { account, cred, act, rate } = await settle(ctx, wallet, now);
  const { db, t } = ctx.database;
  const today = utcDay(now);
  const [ci] = await db.select().from(t.miningCheckins).where(and(eq(t.miningCheckins.wallet, wallet), eq(t.miningCheckins.day, today)));
  const [streakRows] = await db.select({ n: count() }).from(t.miningCheckins).where(eq(t.miningCheckins.wallet, wallet));
  return {
    wallet: checksum(wallet),
    credential: { configured: cred.configured, address: cred.address, active: cred.active, credit: cred.credit, tokenId: cred.tokenId },
    points: account ? pts(account.pointsMilli) : 0,
    checkinPoints: account ? pts(account.checkinMilli) : 0,
    ratePerDay: rate.rateMilli / 1000,
    basePerDay: rate.basePerDay,
    multiplier: rate.multiplier,
    boosts: {
      launches: act.launches,
      launchBoost: rate.launchBoost,
      volumeBnb: act.volumeBnb,
      volumeWei: act.volumeWei,
      volumeWindowDays: act.windowDays,
      volumeBoost: rate.volumeBoost,
    },
    miningSince: account?.createdAt ?? null,
    checkin: {
      day: today,
      checkedInToday: !!ci,
      points: ctx.cfg.MINING_CHECKIN_POINTS,
      totalCheckins: Number(streakRows?.n ?? 0),
      nextCheckinAt: ci ? nextUtcMidnight(now) : now,
      message: checkinMessage(wallet, today, ctx.cfg.CHAIN_ID),
    },
    asOf: now,
  };
}

export async function checkin(ctx: AppContext, body: { wallet: string; signature: string; message: string }) {
  const wallet = normalizeWallet(body.wallet);
  const now = nowSec();
  const day = utcDay(now);
  const expected = checkinMessage(wallet, day, ctx.cfg.CHAIN_ID);
  if (String(body.message ?? "").replace(/\r\n/g, "\n") !== expected)
    throw new ApiError(400, "bad_message", "签到消息不正确或已过期（每个 UTC 日的签到消息不同，请刷新后重签）", { expected });
  if (!/^0x[0-9a-fA-F]+$/.test(String(body.signature ?? ""))) throw new ApiError(400, "bad_signature", "signature must be 0x hex");
  const ok = await verifyAgentSignature(ctx.pc, { kind: "eip191", address: checksum(wallet), signature: body.signature as Hex, message: expected });
  if (!ok) throw new ApiError(401, "bad_signature", "钱包签名校验失败");

  const { account } = await settle(ctx, wallet, now);
  if (!account) throw new ApiError(403, "no_credential", "该钱包没有有效的 ChyAI 凭证，先去空投页 mint 凭证");
  const { db, t } = ctx.database;
  const milli = Math.round(ctx.cfg.MINING_CHECKIN_POINTS * 1000);
  try {
    await db.insert(t.miningCheckins).values({ id: uuid(), wallet, day, pointsMilli: milli, createdAt: now });
  } catch {
    throw new ApiError(409, "already_checked_in", "今天已经签到过了（每个钱包每个 UTC 日一次）", { nextCheckinAt: nextUtcMidnight(now) });
  }
  await db
    .update(t.miningAccounts)
    .set({ pointsMilli: sql`${t.miningAccounts.pointsMilli} + ${milli}`, checkinMilli: sql`${t.miningAccounts.checkinMilli} + ${milli}`, updatedAt: now })
    .where(eq(t.miningAccounts.wallet, wallet));
  return { wallet: checksum(wallet), day, added: milli / 1000, nextCheckinAt: nextUtcMidnight(now), mining: await getMining(ctx, wallet) };
}

export async function miningLeaderboard(ctx: AppContext, limit = 50) {
  const { db, t } = ctx.database;
  const now = nowSec();
  const rows = await db.select().from(t.miningAccounts).orderBy(desc(t.miningAccounts.pointsMilli)).limit(Math.max(limit * 4, 200));
  const ranked = rows
    .map((a) => ({ wallet: checksum(a.wallet), points: pts(liveMilli(a as Account, now)), ratePerDay: a.rateMilliPerDay / 1000, credit: a.credit }))
    .sort((x, y) => y.points - x.points)
    .slice(0, limit)
    .map((r, i) => ({ rank: i + 1, ...r }));
  return { asOf: now, items: ranked };
}

export async function miningStats(ctx: AppContext) {
  const { db, t } = ctx.database;
  const now = nowSec();
  const rows = await db.select().from(t.miningAccounts);
  let total = 0;
  let active = 0;
  for (const a of rows) {
    total += liveMilli(a as Account, now);
    if (a.rateMilliPerDay > 0) active++;
  }
  const [ci] = await db.select({ n: count() }).from(t.miningCheckins).where(eq(t.miningCheckins.day, utcDay(now)));
  const c = ctx.cfg;
  return {
    asOf: now,
    participants: rows.length,
    activeMiners: active,
    totalPoints: pts(total),
    checkinsToday: Number(ci?.n ?? 0),
    credentialConfigured: !!c.CREDENTIAL_ADDRESS,
    credentialAddress: c.CREDENTIAL_ADDRESS ?? null,
    rules: {
      pointsPer1000CreditPerDay: c.MINING_POINTS_PER_1000_CREDIT_DAY,
      launchBoost: c.MINING_LAUNCH_BOOST,
      launchBoostCap: c.MINING_LAUNCH_BOOST_CAP,
      volumeBoostPerBnb: c.MINING_VOLUME_BOOST_PER_BNB,
      volumeBoostCap: c.MINING_VOLUME_BOOST_CAP,
      volumeWindowDays: c.MINING_VOLUME_WINDOW_DAYS,
      checkinPoints: c.MINING_CHECKIN_POINTS,
      note: "积分将按规则兑换平台币，具体比例与时间另行公告，不承诺收益",
    },
  };
}
