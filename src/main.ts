import { loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { buildServer } from "./api/server.js";
import { startTradeTail, startWorker } from "./worker.js";
import { startBackupTimer } from "./services/backup.js";
import { startAirdropVerifyTimer } from "./services/airdrop.js";

async function main() {
  const cfg = loadConfig();
  const ctx = await createContext(cfg);
  const stops: (() => void)[] = [];
  if (cfg.ROLE === "worker" || cfg.ROLE === "all") {
    stops.push(startWorker(ctx));
    stops.push(startBackupTimer(ctx));
    stops.push(startAirdropVerifyTimer(ctx));
  }
  if (cfg.ROLE === "api" || cfg.ROLE === "all") {
    if (cfg.ROLE === "api") stops.push(startTradeTail(ctx));
    const app = await buildServer(ctx);
    await app.listen({ port: cfg.PORT, host: cfg.HOST });
    stops.push(() => void app.close());
  }
  ctx.log.info({ role: cfg.ROLE, chainId: cfg.CHAIN_ID, db: ctx.database.dialect, signer: await ctx.signer.getAddress().catch(() => "n/a") }, "AgentPad backend started");
  const shutdown = async () => {
    stops.forEach((s) => s());
    await ctx.database.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
