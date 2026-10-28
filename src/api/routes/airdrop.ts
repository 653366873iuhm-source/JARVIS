import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../../context.js";
import { ApiError } from "../../services/registration.js";
import { AIRDROP_STATUSES, RateLimiter, airdropClaimsCsv, airdropStats, claimAirdrop, listAirdropClaims, setAirdropStatus, type AirdropStatus } from "../../services/airdrop.js";

/** Client IP behind Render/Cloudflare: cf-connecting-ip, else first X-Forwarded-For hop, else socket address. */
export function clientIp(req: FastifyRequest): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf.trim();
  const xff = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || req.ip || "unknown";
}

export function registerAirdropRoutes(app: FastifyInstance, ctx: AppContext, admin: (req: FastifyRequest) => void) {
  const perIp = new RateLimiter(5, 10 * 60_000); // 5 claim attempts / 10 min / IP
  const global = new RateLimiter(120, 60_000); // 120 claim attempts / min overall

  app.get("/v1/airdrop/stats", async () => airdropStats(ctx));

  app.post("/v1/airdrop/claim", async (req, reply) => {
    const ip = clientIp(req);
    if (!global.take("all") || !perIp.take(ip)) {
      reply.header("retry-after", "600");
      throw new ApiError(429, "rate_limited", "请求太频繁，请稍后再试");
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.xHandle !== "string" || typeof b.wallet !== "string") throw new ApiError(400, "validation_error", "xHandle and wallet are required strings");
    const r = await claimAirdrop(ctx, { xHandle: b.xHandle, wallet: b.wallet }, ip);
    return reply.status(201).send(r);
  });

  // admin: CSV export (default) or JSON with ?format=json
  app.get<{ Querystring: { format?: string } }>("/v1/airdrop/claims", async (req, reply) => {
    admin(req);
    if (req.query.format === "json") return (await listAirdropClaims(ctx)).map(({ ipHash: _ip, ...r }) => r);
    const csv = await airdropClaimsCsv(ctx);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="chyai-airdrop-claims.csv"`)
      .send(csv);
  });
  // admin: mark a claim approved / rejected after checking follow + repost
  app.post<{ Params: { id: string } }>("/v1/airdrop/claims/:id/status", async (req) => {
    admin(req);
    const s = ((req.body ?? {}) as Record<string, unknown>).status;
    if (typeof s !== "string" || !(AIRDROP_STATUSES as readonly string[]).includes(s)) throw new ApiError(400, "validation_error", `status: ${AIRDROP_STATUSES.join(" | ")}`);
    return setAirdropStatus(ctx, req.params.id, s as AirdropStatus);
  });
}
