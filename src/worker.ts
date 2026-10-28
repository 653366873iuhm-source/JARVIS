import { Cron } from "croner";
import { and, desc, eq, gt, or } from "drizzle-orm";
import type { AppContext } from "./context.js";
import { Indexer, clockNow } from "./services/indexer.js";
import { promotionTick } from "./services/promotion.js";
import { epochOf, runRewardEpoch } from "./services/rewards.js";
import { requalifyAgents } from "./services/requalify.js";
import { runSybilScan } from "./services/sybil.js";
import { metadataTick } from "./services/metadata.js";
import { reconcileNftHoldings } from "./services/reconcile.js";
import { startSignerWatch } from "./services/health.js";

function loop(name: string, ms: number, fn: () => Promise<unknown>, ctx: AppContext) {
  let running = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      ctx.log.error(e, `${name} failed`);
    } finally {
      running = false;
    }
  }, ms);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Settles the previous UTC day's reward epoch when no row exists yet (cron missed). Same code path as the cron. */
export async function rewardCatchUp(ctx: AppContext) {
  const { db, t } = ctx.database;
  const now = await clockNow(ctx);
  if (now % 86400 < 15 * 60) return { skipped: "cron window" }; // let the 00:10 UTC cron run first
  const epoch = epochOf(now) - 1;
  const [row] = await db.select().from(t.rewardEpochs).where(eq(t.rewardEpochs.epoch, epoch));
  if (row && row.status !== "computed") return { epoch, skipped: row.status };
  const r = await runRewardEpoch(ctx, { epoch });
  ctx.log.info({ epoch, status: r.status }, "reward epoch settled (catch-up)");
  return r;
}

/** Background jobs: indexer + promotion gate loops, and cron jobs for rewards / requalification / sybil scan. */
export function startWorker(ctx: AppContext) {
  const indexer = new Indexer(ctx);
  const stops: (() => void)[] = [];
  stops.push(loop("indexer", ctx.cfg.INDEXER_POLL_MS, () => indexer.syncToHead(), ctx));
  stops.push(loop("promotion", ctx.cfg.PROMO_POLL_MS, () => promotionTick(ctx), ctx));
  stops.push(loop("metadata", ctx.cfg.METADATA_POLL_MS, () => metadataTick(ctx), ctx));
  // free hosts sleep / redeploy: settle yesterday's reward epoch if the 00:10 UTC cron did not run (idempotent)
  if (ctx.cfg.REWARD_CATCHUP_MS > 0) stops.push(loop("reward-catchup", ctx.cfg.REWARD_CATCHUP_MS, () => rewardCatchUp(ctx), ctx));
  stops.push(loop("nft-reconcile", 6 * 3600_000, () => reconcileNftHoldings(ctx), ctx));
  // setInterval only fires after the first interval; on a free host that redeploys often, also run both once ~2 min after boot
  if (ctx.cfg.REWARD_CATCHUP_MS > 0 || ctx.cfg.NODE_ENV === "production") {
    const boot = setTimeout(async () => {
      if (ctx.cfg.REWARD_CATCHUP_MS > 0) await rewardCatchUp(ctx).catch((e) => ctx.log.error(e, "reward-catchup (boot) failed"));
      await reconcileNftHoldings(ctx).catch((e) => ctx.log.error(e, "nft-reconcile (boot) failed"));
    }, 120_000);
    boot.unref?.();
    stops.push(() => clearTimeout(boot));
  }
  stops.push(startSignerWatch(ctx));
  const crons = [
    new Cron(ctx.cfg.REWARD_CRON, { timezone: "UTC", protect: true }, async () => {
      const epoch = epochOf(await clockNow(ctx)) - 1; // settle yesterday (UTC)
      const r = await runRewardEpoch(ctx, { epoch });
      ctx.log.info({ epoch, status: r.status }, "reward epoch settled");
    }),
    new Cron(ctx.cfg.REQUALIFY_CRON, { timezone: "UTC", protect: true }, async () => {
      const r = await requalifyAgents(ctx);
      ctx.log.info({ checked: r.checked, revoked: r.results.filter((x) => !x.eligible).length }, "requalification done");
    }),
    new Cron(ctx.cfg.SYBIL_CRON, { timezone: "UTC", protect: true }, async () => {
      const r = await runSybilScan(ctx);
      ctx.log.info({ clusters: r.clusters.length }, "sybil scan done");
    }),
  ];
  return () => {
    stops.forEach((s) => s());
    crons.forEach((c) => c.stop());
  };
}

/**
 * For ROLE=api processes (indexer runs elsewhere): tail the trades table and re-emit new rows on the bus so
 * WebSocket clients still get live trades. Portable across SQLite and Postgres (no LISTEN/NOTIFY needed).
 */
export function startTradeTail(ctx: AppContext, ms = 1000) {
  const { db, t } = ctx.database;
  let lastBlock = -1;
  let lastLog = -1;
  return loop(
    "trade-tail",
    ms,
    async () => {
      if (lastBlock < 0) {
        const [r] = await db.select().from(t.trades).orderBy(desc(t.trades.blockNumber), desc(t.trades.logIndex)).limit(1);
        lastBlock = r?.blockNumber ?? 0;
        lastLog = r?.logIndex ?? -1;
        return;
      }
      const rows = await db
        .select()
        .from(t.trades)
        .where(or(gt(t.trades.blockNumber, lastBlock), and(eq(t.trades.blockNumber, lastBlock), gt(t.trades.logIndex, lastLog))))
        .orderBy(t.trades.blockNumber, t.trades.logIndex)
        .limit(500);
      for (const r of rows) {
        ctx.bus.emit("trade", r);
        lastBlock = r.blockNumber;
        lastLog = r.logIndex;
      }
    },
    ctx,
  );
}
