/**
 * Monitoring: signer balance alert + one JSON with ok flags for uptime pollers.
 *
 *   GET /v1/health          → … signer {address, balanceBnb, thresholdBnb, low}, signerLow, indexer {lag, ok}, rewards {…}
 *   GET /v1/health/full     → { ok, checks: { backend, db, rpc, indexer, site, signer, rewards }, signerLow, alerts[] }
 *                             ?strict=1 answers HTTP 503 when ok=false (for curl -f / uptime checkers)
 *
 * Nothing secret is returned: public addresses, balances, block numbers, epoch numbers and statuses only.
 */
import { desc, sql } from "drizzle-orm";
import { formatEther, type Address } from "viem";
import type { AppContext } from "../context.js";
import { CURSOR_KEY, CURSOR_TS_KEY, getKv } from "./indexer.js";

type Cached<T> = { at: number; v: T };
let balCache: Cached<SignerStatus> | null = null;
let siteCache: Cached<SiteStatus> | null = null;
export function clearHealthCache() {
  balCache = null;
  siteCache = null;
}

export interface SignerStatus {
  address: string | null;
  balanceWei: string | null;
  balanceBnb: string | null;
  thresholdBnb: number;
  low: boolean; // true below SIGNER_LOW_BALANCE_BNB (also true when the balance could not be read? no: then `error`)
  error?: string;
  relayer?: { address: string; balanceBnb: string | null; low: boolean } | null;
}

async function balanceOf(ctx: AppContext, a: Address) {
  return ctx.pc.getBalance({ address: a });
}

/** Platform signer (and relayer when it is a different address) BNB balance vs SIGNER_LOW_BALANCE_BNB. Cached. */
export async function signerStatus(ctx: AppContext, fresh = false): Promise<SignerStatus> {
  if (!fresh && balCache && Date.now() - balCache.at < ctx.cfg.SIGNER_BALANCE_CACHE_SEC * 1000) return balCache.v;
  const thresholdBnb = ctx.cfg.SIGNER_LOW_BALANCE_BNB;
  const thresholdWei = BigInt(Math.round(thresholdBnb * 1e9)) * 10n ** 9n;
  let v: SignerStatus;
  try {
    const address = (await ctx.signer.getAddress()) as Address;
    const bal = await balanceOf(ctx, address);
    v = { address, balanceWei: bal.toString(), balanceBnb: formatEther(bal), thresholdBnb, low: bal < thresholdWei };
    const relayerAddr = (await ctx.relayer?.getAddress?.().catch(() => null)) as Address | null;
    if (relayerAddr && relayerAddr.toLowerCase() !== address.toLowerCase()) {
      const rb = await balanceOf(ctx, relayerAddr).catch(() => null);
      v.relayer = { address: relayerAddr, balanceBnb: rb === null ? null : formatEther(rb), low: rb !== null && rb < thresholdWei };
    } else v.relayer = null;
  } catch (e: any) {
    v = { address: null, balanceWei: null, balanceBnb: null, thresholdBnb, low: false, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) };
  }
  balCache = { at: Date.now(), v };
  return v;
}

export interface IndexerStatus {
  lastBlock: number | null;
  lastBlockTs: number | null;
  head: number | null;
  lag: number | null;
  maxLag: number;
  ok: boolean;
}
export async function indexerStatus(ctx: AppContext, head?: bigint | null): Promise<IndexerStatus> {
  const last = Number((await getKv(ctx, CURSOR_KEY).catch(() => null)) ?? NaN);
  const ts = Number((await getKv(ctx, CURSOR_TS_KEY).catch(() => null)) ?? NaN);
  const h = head === undefined ? await ctx.pc.getBlockNumber().catch(() => null) : head;
  const lastBlock = Number.isFinite(last) ? last : null;
  const headN = h === null || h === undefined ? null : Number(h);
  const lag = lastBlock !== null && headN !== null ? Math.max(0, headN - lastBlock) : null;
  return { lastBlock, lastBlockTs: Number.isFinite(ts) ? ts : null, head: headN, lag, maxLag: ctx.cfg.INDEXER_MAX_LAG_BLOCKS, ok: lag !== null && lag <= ctx.cfg.INDEXER_MAX_LAG_BLOCKS };
}

export interface SiteStatus {
  url: string;
  ok: boolean;
  status: number | null;
  ms: number | null;
  error?: string;
}
export async function siteStatus(ctx: AppContext, fetcher: typeof fetch = fetch): Promise<SiteStatus> {
  if (siteCache && Date.now() - siteCache.at < 60_000) return siteCache.v;
  const url = (ctx.cfg.SITE_URL || ctx.cfg.PUBLIC_APP_URL).replace(/\/+$/, "") + "/";
  const t0 = Date.now();
  let v: SiteStatus;
  try {
    const r = await fetcher(url, { method: "GET", signal: AbortSignal.timeout(15_000), redirect: "follow" });
    v = { url, ok: r.ok, status: r.status, ms: Date.now() - t0 };
  } catch (e: any) {
    v = { url, ok: false, status: null, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) };
  }
  siteCache = { at: Date.now(), v };
  return v;
}

/** Latest reward epoch + whether roots are sent automatically (AUTO_SUBMIT_ADMIN_TXS && TX_SEND_ENABLED). */
export async function rewardsStatus(ctx: AppContext) {
  const { db, t } = ctx.database;
  const [last] = await db
    .select({ epoch: t.rewardEpochs.epoch, status: t.rewardEpochs.status, txHash: t.rewardEpochs.txHash, totalWei: t.rewardEpochs.totalWei, createdAt: t.rewardEpochs.createdAt, error: t.rewardEpochs.error })
    .from(t.rewardEpochs)
    .orderBy(desc(t.rewardEpochs.epoch))
    .limit(1);
  const [pending] = await db.select({ n: sql<number>`count(*)` }).from(t.adminTxs).where(sql`${t.adminTxs.kind} = 'postRoot' and ${t.adminTxs.status} = 'prepared'`);
  const expected = Math.floor(Date.now() / 1000 / 86400) - 1; // yesterday (UTC) should be settled after 00:10 UTC
  const autoSend = ctx.cfg.AUTO_SUBMIT_ADMIN_TXS && ctx.cfg.TX_SEND_ENABLED;
  return {
    autoSubmit: ctx.cfg.AUTO_SUBMIT_ADMIN_TXS,
    txSendEnabled: ctx.cfg.TX_SEND_ENABLED,
    autoSend,
    lastEpoch: last ? { ...last, error: last.error ? String(last.error).slice(0, 200) : null } : null,
    expectedEpoch: expected,
    upToDate: !!last && last.epoch >= expected,
    preparedRoots: Number(pending?.n ?? 0), // postRoot txs waiting (should be 0 when autoSend)
    ok: !last || last.status !== "failed",
  };
}

/** One JSON for uptime pollers. backend=true by definition when this answers. */
export async function fullHealth(ctx: AppContext, opts: { fetcher?: typeof fetch } = {}) {
  let dbOk = true;
  let dbError: string | undefined;
  try {
    await getKv(ctx, CURSOR_KEY);
  } catch (e: any) {
    dbOk = false;
    dbError = String(e?.message ?? e).slice(0, 200);
  }
  const head = await ctx.pc.getBlockNumber().catch(() => null);
  const [indexer, site, signer, rewards] = await Promise.all([
    indexerStatus(ctx, head),
    siteStatus(ctx, opts.fetcher),
    signerStatus(ctx),
    rewardsStatus(ctx).catch((e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 200) }) as any),
  ]);
  const checks = {
    backend: { ok: true },
    db: { ok: dbOk, dialect: ctx.database.dialect, ...(dbError ? { error: dbError } : {}) },
    rpc: { ok: head !== null, block: head === null ? null : Number(head) },
    indexer,
    site,
    signer: { ...signer, ok: !signer.low && !signer.error },
    rewards,
  };
  const alerts: string[] = [];
  if (!dbOk) alerts.push("db_down");
  if (head === null) alerts.push("rpc_down");
  if (!indexer.ok) alerts.push(indexer.lag === null ? "indexer_unknown" : `indexer_lag_${indexer.lag}`);
  if (!site.ok) alerts.push(`site_down_${site.status ?? "unreachable"}`);
  if (signer.low) alerts.push(`signer_low_${signer.balanceBnb}`);
  if (signer.relayer?.low) alerts.push(`relayer_low_${signer.relayer.balanceBnb}`);
  if (!rewards.ok) alerts.push("rewards_failed");
  return {
    ok: alerts.length === 0,
    asOf: Math.floor(Date.now() / 1000),
    chainId: ctx.cfg.CHAIN_ID,
    signerLow: signer.low,
    indexerLagging: !indexer.ok,
    siteDown: !site.ok,
    alerts,
    checks,
  };
}

/** Periodic log line when the signer runs low (Render logs); the user-facing alert polls /v1/health/full. */
export function startSignerWatch(ctx: AppContext, ms = 30 * 60_000) {
  const tick = async () => {
    const s = await signerStatus(ctx, true).catch(() => null);
    if (s?.low) ctx.log.warn({ signer: s.address, balanceBnb: s.balanceBnb, thresholdBnb: s.thresholdBnb }, "platform signer balance LOW — top up");
  };
  const timer = setInterval(tick, ms);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
