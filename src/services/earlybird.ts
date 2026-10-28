/**
 * 早鸟 (early bird): the first EARLYBIRD_SLOTS real credential minters get +EARLYBIRD_BOOST mining speed for
 * EARLYBIRD_DAYS after their mint, if they minted no later than EARLYBIRD_END_AT.
 *
 *  - "Real" = not in HIDE_WALLETS (test wallets never take a slot).
 *  - Order = mining account creation (the mining account opens when the credential is first seen on-chain: within
 *    ~2 min of the mint via the activation sweep), ties by wallet. Covers ChyAICredential v2 + V3 (any valid contract).
 *  - remaining = max(0, EARLYBIRD_SLOTS − real minted credentials). Nothing here is estimated or padded.
 *  - The boost is additive with the launch (cap +100%), volume (cap +200%) and invite (cap +50%) boosts:
 *    max multiplier = 1 + 1 + 2 + 0.5 + 0.2 = 4.7.
 */
import type { AppContext } from "../context.js";
import { lc } from "../lib/util.js";
import { isHiddenWallet } from "./hidden.js";

const DAY = 86400;
type Cfg = AppContext["cfg"];
export interface AccountRow {
  wallet: string;
  createdAt: number;
}
export interface EarlyBird {
  slot: number | null; // 1-based rank among real minters (null: hidden wallet / programme off)
  eligible: boolean; // within the first EARLYBIRD_SLOTS and minted by EARLYBIRD_END_AT
  startsAt: number | null;
  endsAt: number | null; // boost ends (mint + EARLYBIRD_DAYS)
  active: boolean;
  boost: number; // boost while active (0 otherwise)
}

/** EARLYBIRD_END_AT (ISO with zone, or unix seconds) → unix seconds. */
export function earlyBirdEndAt(cfg: Cfg): number {
  const v = String(cfg.EARLYBIRD_END_AT ?? "").trim();
  if (/^\d+$/.test(v)) return Number(v);
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

let cache: { at: number; rows: AccountRow[] } | null = null;
export function clearEarlyBirdCache() {
  cache = null;
}

/** Real (non-hidden) mining accounts in early-bird order. Cached 30 s; cleared whenever an account opens. */
export async function realAccounts(ctx: AppContext): Promise<AccountRow[]> {
  if (cache && Date.now() - cache.at < 30_000) return cache.rows;
  const { db, t } = ctx.database;
  const rows = (await db.select({ wallet: t.miningAccounts.wallet, createdAt: t.miningAccounts.createdAt }).from(t.miningAccounts))
    .map((r) => ({ wallet: lc(r.wallet), createdAt: Number(r.createdAt) }))
    .filter((r) => !isHiddenWallet(ctx.cfg, r.wallet))
    .sort((a, b) => a.createdAt - b.createdAt || (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  cache = { at: Date.now(), rows };
  return rows;
}

const NONE: EarlyBird = { slot: null, eligible: false, startsAt: null, endsAt: null, active: false, boost: 0 };

/** Early-bird state of `wallet` given the ordered real accounts. A wallet with no account yet is ranked as the next one. */
export function earlyBirdFromRows(cfg: Cfg, rows: AccountRow[], wallet: string, now: number): EarlyBird {
  const w = lc(wallet);
  if (cfg.EARLYBIRD_SLOTS <= 0 || cfg.EARLYBIRD_BOOST <= 0 || isHiddenWallet(cfg, w)) return NONE;
  const idx = rows.findIndex((r) => r.wallet === w);
  const slot = idx >= 0 ? idx + 1 : rows.length + 1;
  const startsAt = idx >= 0 ? rows[idx]!.createdAt : now;
  const eligible = slot <= cfg.EARLYBIRD_SLOTS && startsAt <= earlyBirdEndAt(cfg);
  if (!eligible) return { ...NONE, slot };
  const endsAt = startsAt + cfg.EARLYBIRD_DAYS * DAY;
  const active = now < endsAt;
  return { slot, eligible, startsAt, endsAt, active, boost: active ? cfg.EARLYBIRD_BOOST : 0 };
}

export async function earlyBirdOf(ctx: AppContext, wallet: string, now: number) {
  return earlyBirdFromRows(ctx.cfg, await realAccounts(ctx), wallet, now);
}

/** wallet → boost end, for every eligible early bird (used to split accrual exactly at the end of the boost). */
export function earlyBirdEnds(cfg: Cfg, rows: AccountRow[]): Map<string, number> {
  const m = new Map<string, number>();
  if (cfg.EARLYBIRD_SLOTS <= 0 || cfg.EARLYBIRD_BOOST <= 0) return m;
  const endAt = earlyBirdEndAt(cfg);
  rows.slice(0, cfg.EARLYBIRD_SLOTS).forEach((r) => {
    if (r.createdAt <= endAt) m.set(r.wallet, r.createdAt + cfg.EARLYBIRD_DAYS * DAY);
  });
  return m;
}

/** Public summary: slots left = slots − real minted credentials (never estimated). */
export async function earlyBirdSummary(ctx: AppContext, now: number) {
  const c = ctx.cfg;
  const rows = await realAccounts(ctx);
  const endsAt = earlyBirdEndAt(c);
  const remaining = Math.max(0, c.EARLYBIRD_SLOTS - rows.length);
  return {
    slots: c.EARLYBIRD_SLOTS,
    boost: c.EARLYBIRD_BOOST,
    days: c.EARLYBIRD_DAYS,
    minted: rows.length, // real minted credentials (v2 + V3, hidden test wallets excluded)
    remaining,
    endsAt, // unix seconds: mints after this get no early-bird boost
    open: c.EARLYBIRD_SLOTS > 0 && c.EARLYBIRD_BOOST > 0 && now < endsAt && remaining > 0,
    note: `前 ${c.EARLYBIRD_SLOTS} 名早鸟：凭证 mint 后 ${c.EARLYBIRD_DAYS} 天内挖矿速度 +${Math.round(c.EARLYBIRD_BOOST * 100)}%（按开始挖矿时间排序，测试钱包不计）`,
  };
}
