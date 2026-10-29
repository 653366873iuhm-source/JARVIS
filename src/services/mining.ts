/**
 * 挖矿积分 — off-chain mining points for ChyAICredential holders.
 * 积分将按规则兑换平台币，具体比例与时间另行公告，不承诺收益。
 *
 *   rate/day = credit / 1000 × MINING_POINTS_PER_1000_CREDIT_DAY × multiplier
 *   multiplier = 1 + min(LAUNCH_CAP, launches × LAUNCH_BOOST) + min(VOLUME_CAP, volumeBNB(window) × VOLUME_BOOST_PER_BNB)
 *              + min(INVITE_CAP, qualifiedInvites × INVITE_BOOST) + (early bird ? EARLYBIRD_BOOST : 0)
 *   (all additive; defaults: launch ≤ +100%, volume ≤ +200%, invites ≤ +50%, early bird +20% → max ×4.7)
 *   launches / volume come from the chain indexer (projects.launcher, trades.trader on ChyAI's bonding curves).
 *   + daily 签到: MINING_CHECKIN_POINTS once per wallet per UTC day, proven by a wallet signature (EIP-191 / ERC-1271).
 * Accrual is settled lazily (on read / check-in) and starts the first time the wallet is seen holding a credential;
 * a background sweep (MINING_ACTIVATE_SWEEP_MS) checks approved claims so mining starts within ~2 min of the mint.
 * Points are stored as integers in units of 1e-8 points ("e8"), so the site can show/tick 8 decimals exactly.
 */
import { isHiddenWallet } from "./hidden.js";
import { inviteBoostOf, qualifiedInviteCount } from "./invites.js";
import { clearEarlyBirdCache, earlyBirdEnds, earlyBirdOf, earlyBirdSummary, realAccounts, type EarlyBird } from "./earlybird.js";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Hex } from "viem";
import type { AppContext } from "../context.js";
import { checksum, lc, nowSec, uuid } from "../lib/util.js";
import { ApiError } from "./registration.js";
import { normalizeWallet } from "./airdrop.js";
import { credentialAddresses, credentialMintAddress, readCredential } from "./credential.js";
import { verifyAgentSignature } from "./sigverify.js";

const DAY = 86400;
const WEI_PER_BNB = 10n ** 18n;

export const utcDay = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
export const nextUtcMidnight = (ts: number) => (Math.floor(ts / DAY) + 1) * DAY;
export const E8 = 100_000_000;
/** e8 integer → decimal string with exactly 8 decimals ("0.01086658"). */
export function fmtE8(e8: number | bigint): string {
  const v = BigInt(Math.trunc(Number(e8)));
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / 100_000_000n}.${(a % 100_000_000n).toString().padStart(8, "0")}`;
}
/** points/day (e8) → points/second as a decimal string with 12 decimals (enough precision for client-side ticking). */
export function ratePerSecondStr(rateE8PerDay: number): string {
  const v = (BigInt(Math.round(rateE8PerDay)) * 10_000n) / 86_400n; // units of 1e-12 points per second
  return `${v / 1_000_000_000_000n}.${(v % 1_000_000_000_000n).toString().padStart(12, "0")}`;
}
const shortWallet = (w: string) => `${w.slice(0, 4)}…${w.slice(-2)}`;

/** Exact text the wallet signs for 签到 (personal_sign). Valid only on that UTC day. */
export function checkinMessage(wallet: string, day: string, chainId: number) {
  return ["ChyAI 挖矿签到 / ChyAI mining check-in", `Wallet: ${checksum(wallet)}`, `Date (UTC): ${day}`, `Chain ID: ${chainId}`].join("\n");
}

/** EIP-712 alternative for wallets that can't personal_sign (Binance Agentic Wallet `baw sign-message` is EIP-712 only). */
export function checkinTypedData(wallet: string, day: string, chainId: number) {
  return {
    domain: { name: "ChyAI Mining", version: "1", chainId },
    types: { Checkin: [{ name: "wallet", type: "address" }, { name: "day", type: "string" }] },
    primaryType: "Checkin" as const,
    message: { wallet: checksum(wallet), day },
  };
}
/** EIP712Domain-inclusive JSON (what eth_signTypedData_v4 / baw expects). */
export function checkinTypedDataJson(wallet: string, day: string, chainId: number) {
  const td = checkinTypedData(wallet, day, chainId);
  return JSON.stringify({
    ...td,
    types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }], ...td.types },
  });
}
/** Exact baw commands for today's check-in (message = eth_signTypedData_v4 request, typed data as a JSON string). */
export function bawCheckin(wallet: string, day: string, chainId: number) {
  const message = JSON.stringify({ method: "eth_signTypedData_v4", params: [checksum(wallet), checkinTypedDataJson(wallet, day, chainId)] });
  const q = `'${message.replace(/'/g, "'\\''")}'`;
  return {
    message,
    preview: `baw sign-message preview --binanceChainId ${chainId} --signType EIP712 --message ${q} --json`,
    execute: "baw sign-message execute --requestId <requestId> --json",
    result: "baw sign-message result --order-id <orderId> --json",
    submit: {
      method: "POST", path: "/v1/mining/checkin",
      body: { wallet: checksum(wallet), signType: "eip712", signature: "<data.signature>", signatureRecovery: "<data.signatureRecovery>" },
    },
  };
}

/**
 * Mining auto-start: approved airdrop claims whose wallet has no mining account yet are re-read on-chain (fresh, v2 + v3);
 * a wallet that now holds a credential gets its account opened (accrual starts) without anyone opening the site.
 */
export async function activateMintedCredentials(ctx: AppContext, limit = 200) {
  const { db, t } = ctx.database;
  const rows = await db
    .select({ wallet: t.airdropClaims.wallet, acct: t.miningAccounts.wallet })
    .from(t.airdropClaims)
    .leftJoin(t.miningAccounts, eq(t.miningAccounts.wallet, t.airdropClaims.wallet))
    .where(eq(t.airdropClaims.status, "approved"))
    .limit(5000);
  const todo = rows.filter((r) => !r.acct).slice(0, limit);
  let activated = 0;
  for (const r of todo) {
    try {
      const cred = await readCredential(ctx, r.wallet, true);
      if (!cred.active) continue;
      const { account } = await settle(ctx, r.wallet, nowSec());
      if (account) activated++;
    } catch (e) {
      ctx.log.warn({ wallet: r.wallet, err: String(e) }, "mining activation check failed");
    }
  }
  if (activated) ctx.log.info({ activated, checked: todo.length }, "mining auto-start");
  return { checked: todo.length, activated };
}

/** Re-settle early birds whose +boost just ended, so their stored rate drops (accrual is split exactly at the end anyway). */
export async function settleExpiredEarlyBirds(ctx: AppContext, now = nowSec()) {
  const { db, t } = ctx.database;
  const ends = earlyBirdEnds(ctx.cfg, await realAccounts(ctx));
  const due = [...ends].filter(([, end]) => end <= now).map(([w]) => w);
  if (!due.length) return { settled: 0 };
  const rows = await db.select().from(t.miningAccounts).where(inArray(t.miningAccounts.wallet, due));
  let settled = 0;
  for (const a of rows) {
    if (a.lastAccrualAt >= (ends.get(lc(a.wallet)) ?? 0)) continue;
    try {
      await settle(ctx, a.wallet, now);
      settled++;
    } catch (e) {
      ctx.log.warn({ wallet: a.wallet, err: String(e) }, "early-bird expiry settle failed");
    }
  }
  return { settled };
}

export function startMiningActivationTimer(ctx: AppContext) {
  if (!ctx.cfg.MINING_ACTIVATE_SWEEP_MS) return () => undefined;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await activateMintedCredentials(ctx);
      await settleExpiredEarlyBirds(ctx);
    } catch (e) {
      ctx.log.error(e, "mining activation sweep failed");
    } finally {
      running = false;
    }
  }, ctx.cfg.MINING_ACTIVATE_SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Accepts 0x-less hex and baw's split form (64-byte r‖s + signatureRecovery 00/01/1b/1c). */
export function normalizeSignature(sig: string, recovery?: string): string {
  let h = String(sig ?? "").trim();
  if (!h.startsWith("0x")) h = "0x" + h;
  if (recovery !== undefined && recovery !== null && String(recovery) !== "" && h.length === 2 + 128) {
    let v = parseInt(String(recovery).replace(/^0x/, ""), 16);
    if (v < 27) v += 27;
    h += v.toString(16).padStart(2, "0");
  }
  return h;
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

export function computeRate(cfg: AppContext["cfg"], credit: number, act: Activity, qualifiedInvites = 0, earlyBird = false) {
  const launchBoost = Math.min(cfg.MINING_LAUNCH_BOOST_CAP, act.launches * cfg.MINING_LAUNCH_BOOST);
  const volumeBoost = Math.min(cfg.MINING_VOLUME_BOOST_CAP, act.volumeBnb * cfg.MINING_VOLUME_BOOST_PER_BNB);
  // +5% per qualified invitee (applied via the link + minted credential, unique .ai), capped at +50%
  const inviteBoost = inviteBoostOf(cfg, qualifiedInvites);
  // 早鸟: first EARLYBIRD_SLOTS real minters, +EARLYBIRD_BOOST for EARLYBIRD_DAYS after the mint
  const earlyBirdBoost = earlyBird && credit > 0 ? cfg.EARLYBIRD_BOOST : 0;
  const multiplier = 1 + launchBoost + volumeBoost + inviteBoost + earlyBirdBoost;
  const base = (credit / 1000) * cfg.MINING_POINTS_PER_1000_CREDIT_DAY;
  const rateE8 = Math.round(base * multiplier * E8);
  return { basePerDay: base, launchBoost, volumeBoost, inviteBoost, earlyBirdBoost, multiplier, rateE8 };
}

type Account = typeof import("../db/schema.sqlite.js").miningAccounts.$inferSelect;

/**
 * Settled points + accrual since the last settle. When an early bird's boost ended in between (`ebEnd`), the interval
 * is split there: the stored rate up to ebEnd, the rate without the early-bird share after it.
 */
function liveE8(cfg: AppContext["cfg"], a: Account, now: number, ebEnd?: number | null) {
  const last = a.lastAccrualAt;
  if (ebEnd && last < ebEnd && now > ebEnd) {
    const base = (a.credit / 1000) * cfg.MINING_POINTS_PER_1000_CREDIT_DAY * E8;
    const bonus = Math.round(base * cfg.EARLYBIRD_BOOST);
    if (a.rateE8PerDay >= Math.round(base) + bonus - 1) {
      const after = Math.max(0, a.rateE8PerDay - bonus);
      return a.pointsE8 + Math.floor((a.rateE8PerDay * (ebEnd - last)) / DAY) + Math.floor((after * (now - ebEnd)) / DAY);
    }
  }
  return a.pointsE8 + Math.floor((a.rateE8PerDay * Math.max(0, now - last)) / DAY);
}

/** Settle accrual up to `now` and switch to the current rate. Returns the (possibly new) account row or null. */
async function settle(ctx: AppContext, wallet: string, now: number) {
  const { db, t } = ctx.database;
  const cred = await readCredential(ctx, wallet);
  const credit = cred.active ? cred.credit : 0;
  const act = await walletActivity(ctx, wallet, now);
  const invites = credit > 0 ? await qualifiedInviteCount(ctx, wallet, now) : { invited: 0, qualified: 0 };
  const eb: EarlyBird = await earlyBirdOf(ctx, wallet, now);
  const rate = computeRate(ctx.cfg, credit, act, invites.qualified, eb.active);
  for (let attempt = 0; attempt < 3; attempt++) {
    const [a] = await db.select().from(t.miningAccounts).where(eq(t.miningAccounts.wallet, wallet));
    if (!a) {
      if (credit <= 0) return { account: null, cred, act, rate, invites, eb };
      const row = { wallet, pointsE8: 0, checkinE8: 0, rateE8PerDay: rate.rateE8, credit, lastAccrualAt: now, createdAt: now, updatedAt: now };
      const ins = await db.insert(t.miningAccounts).values(row).onConflictDoNothing().returning();
      if (ins.length) clearEarlyBirdCache();
      if (ins.length) return { account: ins[0] as Account, cred, act, rate, invites, eb };
      continue; // raced with another settle → reload
    }
    const pointsE8 = liveE8(ctx.cfg, a, now, eb.endsAt);
    // optimistic lock on lastAccrualAt so concurrent settles never accrue the same interval twice
    const upd = await db
      .update(t.miningAccounts)
      .set({ pointsE8, rateE8PerDay: rate.rateE8, credit, lastAccrualAt: Math.max(now, a.lastAccrualAt), updatedAt: now })
      .where(and(eq(t.miningAccounts.wallet, wallet), eq(t.miningAccounts.lastAccrualAt, a.lastAccrualAt)))
      .returning();
    if (upd.length) return { account: upd[0] as Account, cred, act, rate, invites, eb };
  }
  throw new ApiError(503, "busy", "请稍后再试");
}

export async function getMining(ctx: AppContext, walletIn: string) {
  const wallet = normalizeWallet(walletIn);
  const now = nowSec();
  const { account, cred, act, rate, invites, eb } = await settle(ctx, wallet, now);
  const { db, t } = ctx.database;
  const today = utcDay(now);
  const [ci] = await db.select().from(t.miningCheckins).where(and(eq(t.miningCheckins.wallet, wallet), eq(t.miningCheckins.day, today)));
  const [streakRows] = await db.select({ n: count() }).from(t.miningCheckins).where(eq(t.miningCheckins.wallet, wallet));
  return {
    wallet: checksum(wallet),
    credential: { configured: cred.configured, address: cred.address, active: cred.active, credit: cred.credit, tokenId: cred.tokenId },
    points: fmtE8(account ? account.pointsE8 : 0), // decimal string, 8 decimals, settled as of `asOf`
    pointsE8: String(account ? account.pointsE8 : 0),
    checkinPoints: fmtE8(account ? account.checkinE8 : 0),
    ratePerDay: rate.rateE8 / E8,
    ratePerSecond: ratePerSecondStr(rate.rateE8), // decimal string; live value = points + ratePerSecond × (now − asOf)
    mining: !!account && rate.rateE8 > 0,
    basePerDay: rate.basePerDay,
    multiplier: rate.multiplier,
    boosts: {
      launches: act.launches,
      launchBoost: rate.launchBoost,
      volumeBnb: act.volumeBnb,
      volumeWei: act.volumeWei,
      volumeWindowDays: act.windowDays,
      volumeBoost: rate.volumeBoost,
      invited: invites.invited,
      qualifiedInvites: invites.qualified,
      inviteBoost: rate.inviteBoost,
      earlyBird: { slot: eb.slot, eligible: eb.eligible, active: eb.active && rate.earlyBirdBoost > 0, boost: rate.earlyBirdBoost, startsAt: eb.startsAt, endsAt: eb.endsAt },
      earlyBirdBoost: rate.earlyBirdBoost,
    },
    miningSince: account?.createdAt ?? null,
    checkin: {
      day: today,
      checkedInToday: !!ci,
      points: ctx.cfg.MINING_CHECKIN_POINTS,
      totalCheckins: Number(streakRows?.n ?? 0),
      nextCheckinAt: ci ? nextUtcMidnight(now) : now,
      message: checkinMessage(wallet, today, ctx.cfg.CHAIN_ID),
      typedData: checkinTypedDataJson(wallet, today, ctx.cfg.CHAIN_ID), // EIP-712 alternative (signType: "eip712")
      baw: bawCheckin(wallet, today, ctx.cfg.CHAIN_ID),
    },
    status: cred.active ? (ci ? "mining_checked_in" : "mining_checkin_available") : "no_credential",
    next: cred.active
      ? ci
        ? "挖矿中，今天已签到"
        : "挖矿中：今天还可以签到（baw sign-message EIP-712）"
      : "未 mint 凭证 → 不挖矿。下一步：用 Agent 钱包（baw）发送 /v1/airdrop/voucher 返回的 mint 交易",
    asOf: now,
  };
}

export async function checkin(ctx: AppContext, body: { wallet: string; signature: string; message?: string; signType?: string; signatureRecovery?: string }) {
  const wallet = normalizeWallet(body.wallet);
  const now = nowSec();
  const day = utcDay(now);
  const signature = normalizeSignature(body.signature, body.signatureRecovery);
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new ApiError(400, "bad_signature", "signature must be hex");
  let ok: boolean;
  if (String(body.signType ?? "").toLowerCase() === "eip712") {
    ok = await verifyAgentSignature(ctx.pc, { kind: "eip712", address: checksum(wallet), signature: signature as Hex, typedData: checkinTypedData(wallet, day, ctx.cfg.CHAIN_ID) as any });
  } else {
    const expected = checkinMessage(wallet, day, ctx.cfg.CHAIN_ID);
    if (String(body.message ?? "").replace(/\r\n/g, "\n") !== expected)
      throw new ApiError(400, "bad_message", "签到消息不正确或已过期（每个 UTC 日的签到消息不同，请刷新后重签）", { expected });
    ok = await verifyAgentSignature(ctx.pc, { kind: "eip191", address: checksum(wallet), signature: signature as Hex, message: expected });
  }
  if (!ok) throw new ApiError(401, "bad_signature", "钱包签名校验失败（EIP-712 签名只对当天 UTC 日期有效）");

  const { account } = await settle(ctx, wallet, now);
  if (!account) throw new ApiError(403, "no_credential", "该钱包没有有效的 ChyAI 凭证，先去空投页 mint 凭证");
  const { db, t } = ctx.database;
  const e8 = Math.round(ctx.cfg.MINING_CHECKIN_POINTS * E8);
  try {
    await db.insert(t.miningCheckins).values({ id: uuid(), wallet, day, pointsE8: e8, createdAt: now });
  } catch {
    throw new ApiError(409, "already_checked_in", "今天已经签到过了（每个钱包每个 UTC 日一次）", { nextCheckinAt: nextUtcMidnight(now) });
  }
  await db
    .update(t.miningAccounts)
    .set({ pointsE8: sql`${t.miningAccounts.pointsE8} + ${e8}`, checkinE8: sql`${t.miningAccounts.checkinE8} + ${e8}`, updatedAt: now })
    .where(eq(t.miningAccounts.wallet, wallet));
  return { wallet: checksum(wallet), day, added: e8 / E8, nextCheckinAt: nextUtcMidnight(now), mining: await getMining(ctx, wallet) };
}

export async function miningLeaderboard(ctx: AppContext, limit = 50) {
  const { db, t } = ctx.database;
  const now = nowSec();
  const rows = await db.select().from(t.miningAccounts).orderBy(desc(t.miningAccounts.pointsE8)).limit(Math.max(limit * 4, 200));
  const ends = earlyBirdEnds(ctx.cfg, await realAccounts(ctx));
  const ranked = rows
    .filter((a) => !isHiddenWallet(ctx.cfg, a.wallet))
    .map((a) => ({ wallet: checksum(a.wallet), e8: liveE8(ctx.cfg, a as Account, now, ends.get(lc(a.wallet))), ratePerDay: a.rateE8PerDay / E8, credit: a.credit }))
    .sort((x, y) => y.e8 - x.e8)
    .slice(0, limit);
  const names = ranked.length
    ? new Map((await db.select({ w: t.airdropClaims.wallet, a: t.airdropClaims.agentId }).from(t.airdropClaims).where(inArray(t.airdropClaims.wallet, ranked.map((r) => lc(r.wallet))))).map((r) => [r.w, r.a] as const))
    : new Map<string, string | null>();
  return { asOf: now, items: ranked.map(({ e8, ...r }, i) => ({ rank: i + 1, ...r, agentId: names.get(lc(r.wallet)) ?? null, points: fmtE8(e8) })) };
}

export async function miningStats(ctx: AppContext) {
  const { db, t } = ctx.database;
  const now = nowSec();
  const rows = (await db.select().from(t.miningAccounts)).filter((a) => !isHiddenWallet(ctx.cfg, a.wallet));
  const ends = earlyBirdEnds(ctx.cfg, await realAccounts(ctx));
  let total = 0;
  let active = 0;
  for (const a of rows) {
    total += liveE8(ctx.cfg, a as Account, now, ends.get(lc(a.wallet)));
    if (a.rateE8PerDay > 0) active++;
  }
  const [ci] = await db.select({ n: count() }).from(t.miningCheckins).where(eq(t.miningCheckins.day, utcDay(now)));
  const c = ctx.cfg;
  // small numbers are withheld (null) until MINING_STATS_MIN_PARTICIPANTS real participants: never padded or estimated
  const statsVisible = rows.length >= c.MINING_STATS_MIN_PARTICIPANTS;
  return {
    asOf: now,
    statsVisible,
    statsMinParticipants: c.MINING_STATS_MIN_PARTICIPANTS,
    participants: statsVisible ? rows.length : null,
    activeMiners: statsVisible ? active : null,
    totalPoints: statsVisible ? fmtE8(total) : null,
    checkinsToday: statsVisible ? Number(ci?.n ?? 0) : null,
    earlyBird: await earlyBirdSummary(ctx, now),
    credentialConfigured: credentialAddresses(c).length > 0,
    credentialAddress: credentialMintAddress(c),
    credentialAddresses: credentialAddresses(c),
    rules: {
      pointsPer1000CreditPerDay: c.MINING_POINTS_PER_1000_CREDIT_DAY,
      launchBoost: c.MINING_LAUNCH_BOOST,
      launchBoostCap: c.MINING_LAUNCH_BOOST_CAP,
      volumeBoostPerBnb: c.MINING_VOLUME_BOOST_PER_BNB,
      volumeBoostCap: c.MINING_VOLUME_BOOST_CAP,
      volumeWindowDays: c.MINING_VOLUME_WINDOW_DAYS,
      checkinPoints: c.MINING_CHECKIN_POINTS,
      inviteBoostPerInvitee: c.INVITE_BOOST_PER_INVITEE,
      inviteBoostCap: c.INVITE_BOOST_CAP,
      earlyBirdBoost: c.EARLYBIRD_BOOST,
      earlyBirdSlots: c.EARLYBIRD_SLOTS,
      earlyBirdDays: c.EARLYBIRD_DAYS,
      maxMultiplier: 1 + c.MINING_LAUNCH_BOOST_CAP + c.MINING_VOLUME_BOOST_CAP + c.INVITE_BOOST_CAP + c.EARLYBIRD_BOOST,
      note: "积分将按规则兑换平台币，具体比例与时间另行公告，不承诺收益",
    },
  };
}

/** Public feed of recent mining activity: daily check-ins and credential holders starting to mine. Wallets shortened. */
export async function miningActivity(ctx: AppContext, limit = 30) {
  const { db, t } = ctx.database;
  const n = Math.max(1, Math.min(100, limit));
  const [cis, starts] = await Promise.all([
    db.select().from(t.miningCheckins).orderBy(desc(t.miningCheckins.createdAt)).limit(n + 20),
    db.select().from(t.miningAccounts).orderBy(desc(t.miningAccounts.createdAt)).limit(n + 20),
  ]);
  const items = [
    ...cis.filter((c) => !isHiddenWallet(ctx.cfg, c.wallet)).map((c) => ({ kind: "checkin" as const, wallet: shortWallet(checksum(c.wallet)), points: fmtE8(c.pointsE8), ts: c.createdAt })),
    ...starts.filter((a) => !isHiddenWallet(ctx.cfg, a.wallet)).map((a) => ({ kind: "mint" as const, wallet: shortWallet(checksum(a.wallet)), credit: a.credit, ts: a.createdAt })),
  ]
    .sort((x, y) => y.ts - x.ts)
    .slice(0, n);
  return { asOf: nowSec(), items };
}
