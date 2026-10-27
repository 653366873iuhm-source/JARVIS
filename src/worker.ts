import { Cron } from "croner";
import { and, desc, eq, gt, or } from "drizzle-orm";
import type { AppContext } from "./context.js";
import { Indexer, clockNow } from "./services/indexer.js";
import { promotionTick } from "./services/promotion.js";
import { epochOf, runRewardEpoch } from "./services/rewards.js";
import { requalifyAgents } from "./services/requalify.js";
import { runSybilScan } from "./services/sybil.js";
import { metadataTick } from "./services/metadata.js";

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

/** Background jobs: indexer + promotion gate loops, and cron jobs for rewards / requalification / sybil scan. */
export function startWorker(ctx: AppContext) {
  const indexer = new Indexer(ctx);
  const stops: (() => void)[] = [];
  stops.push(loop("indexer", ctx.cfg.INDEXER_POLL_MS, () => indexer.syncToHead(), ctx));
  stops.push(loop("promotion", ctx.cfg.PROMO_POLL_MS, () => promotionTick(ctx), ctx));
  stops.push(loop("metadata", ctx.cfg.METADATA_POLL_MS, () => metadataTick(ctx), ctx));
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
