import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.js";
import { ApiError } from "../../services/registration.js";
import { RateLimiter } from "../../services/airdrop.js";
import { checkin, getMining, miningActivity, miningLeaderboard, miningStats } from "../../services/mining.js";
import { clientIp } from "./airdrop.js";

/** 挖矿积分 (off-chain mining points for ChyAICredential holders). */
export function registerMiningRoutes(app: FastifyInstance, ctx: AppContext) {
  const perIp = new RateLimiter(20, 10 * 60_000);
  app.get("/v1/mining/stats", async () => miningStats(ctx));
  app.get("/v1/mining/leaderboard", async () => miningLeaderboard(ctx, 50));
  app.get<{ Querystring: { limit?: string } }>("/v1/mining/activity", async (req) => miningActivity(ctx, Number(req.query.limit ?? 30) || 30));
  app.get<{ Params: { wallet: string } }>("/v1/mining/:wallet", async (req) => getMining(ctx, req.params.wallet));
  app.post("/v1/mining/checkin", async (req, reply) => {
    if (!perIp.take(clientIp(req))) {
      reply.header("retry-after", "600");
      throw new ApiError(429, "rate_limited", "请求太频繁，请稍后再试");
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const typed = String(b.signType ?? "").toLowerCase() === "eip712";
    for (const k of typed ? ["wallet", "signature"] : ["wallet", "signature", "message"])
      if (typeof b[k] !== "string") throw new ApiError(400, "validation_error", typed ? "wallet and signature are required strings" : "wallet, signature and message are required strings");
    return checkin(ctx, {
      wallet: b.wallet as string, signature: b.signature as string, message: b.message as string | undefined,
      signType: b.signType as string | undefined, signatureRecovery: typeof b.signatureRecovery === "string" ? b.signatureRecovery : undefined,
    });
  });
}
