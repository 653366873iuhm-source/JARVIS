import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../../context.js";
import { ApiError } from "../../services/registration.js";
import { miningFrozen } from "../../services/mining.js";
import { issueCredentialVoucher } from "../../services/credential.js";
import { getInvites, inviteLeaderboard, weeklyInviteLeaderboard } from "../../services/invites.js";
import { adminTestApprove, airdropVerifySweep, resolveAgentName } from "../../services/airdrop.js";
import { AIRDROP_STATUSES, RateLimiter, airdropClaimsCsv, airdropStats, airdropStatus, claimAirdrop, listAirdropClaims, setAirdropStatus, type AirdropStatus } from "../../services/airdrop.js";

/** Client IP behind Render/Cloudflare: cf-connecting-ip, else first X-Forwarded-For hop, else socket address. */
export function clientIp(req: FastifyRequest): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf.trim();
  const xff = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || req.ip || "unknown";
}

export function registerAirdropRoutes(app: FastifyInstance, ctx: AppContext, admin: (req: FastifyRequest) => void) {
  const perIp = new RateLimiter(10, 10 * 60_000); // 10 claim attempts / 10 min / IP (idempotent repeats are refunded)
  const global = new RateLimiter(120, 60_000); // 120 claim attempts / min overall

  app.get("/v1/airdrop/stats", async () => airdropStats(ctx));

  app.post("/v1/airdrop/claim", async (req, reply) => {
    if (miningFrozen(ctx.cfg)) throw new ApiError(410, "airdrop_closed", "The credential airdrop has ended. Past miners and credential holders get 10,000 CHYAI (see /v1/chyai). 空投申请已结束。");
    const ip = clientIp(req);
    if (!global.take("all") || !perIp.take(ip)) {
      reply.header("retry-after", "600");
      throw new ApiError(429, "rate_limited", "请求太频繁，请稍后再试");
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    for (const k of ["xHandle", "wallet", "repostUrl", "agentName"])
      if (typeof b[k] !== "string") throw new ApiError(400, "validation_error", "xHandle, wallet, repostUrl and agentName are required strings");
    const r = await claimAirdrop(ctx, { xHandle: b.xHandle as string, wallet: b.wallet as string, repostUrl: b.repostUrl as string, agentName: b.agentName as string, ref: typeof b.ref === "string" ? b.ref : undefined }, ip);
    if (r.existing) {
      perIp.refund(ip); // same person re-submitting: return their claim, don't burn their attempts
      global.refund("all");
      return reply.status(200).send(r);
    }
    return reply.status(201).send(r);
  });

  // public: resolve a Binance .ai Agent ID to its BSC wallet (read-only lookup for the site)
  const resolveIp = new RateLimiter(60, 10 * 60_000);
  app.get<{ Querystring: { name?: string } }>("/v1/airdrop/resolve", async (req, reply) => {
    if (!resolveIp.take(clientIp(req))) {
      reply.header("retry-after", "600");
      throw new ApiError(429, "rate_limited", "请求太频繁，请稍后再试");
    }
    return resolveAgentName(ctx, String(req.query.name ?? ""));
  });

  // public: invites — leaderboard + "my invites" (link, invitees, mining boost)
  app.get<{ Querystring: { limit?: string; period?: string } }>("/v1/airdrop/invites/leaderboard", async (req) =>
    req.query.period === "week"
      ? weeklyInviteLeaderboard(ctx, Number(req.query.limit ?? 10) || 10)
      : inviteLeaderboard(ctx, Number(req.query.limit ?? 50) || 50));
  app.get<{ Params: { wallet: string } }>("/v1/airdrop/invites/:wallet", async (req) => getInvites(ctx, req.params.wallet));

  // public: claim status of a wallet (+ on-chain credential state)
  app.get<{ Querystring: { wallet?: string } }>("/v1/airdrop/status", async (req) => airdropStatus(ctx, String(req.query.wallet ?? "")));

  // public: mint voucher (+ AgentRegistry registration when needed) for an APPROVED claim. Nothing is broadcast:
  // the wallet submits the returned calldata itself (gas paid by the user). Vouchers only work for msg.sender == wallet.
  const voucherIp = new RateLimiter(20, 10 * 60_000);
  app.get<{ Querystring: { wallet?: string } }>("/v1/airdrop/voucher", async (req, reply) => {
    if (miningFrozen(ctx.cfg)) throw new ApiError(410, "airdrop_closed", "Credential minting has ended. 凭证 mint 已结束。");
    if (!voucherIp.take(clientIp(req))) {
      reply.header("retry-after", "600");
      throw new ApiError(429, "rate_limited", "请求太频繁，请稍后再试");
    }
    const w = String(req.query.wallet ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(w)) throw new ApiError(400, "invalid_wallet", "wallet query parameter required");
    return issueCredentialVoucher(ctx, w);
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
  // admin, INTERNAL TESTING ONLY: create an approved claim without the X post check (.ai still checked on-chain)
  app.post("/v1/admin/airdrop/test-approve", async (req, reply) => {
    admin(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    for (const k of ["xHandle", "wallet", "aiName"])
      if (typeof b[k] !== "string") throw new ApiError(400, "validation_error", "xHandle, wallet and aiName are required strings");
    const r = await adminTestApprove(ctx, { xHandle: b.xHandle as string, wallet: b.wallet as string, aiName: b.aiName as string });
    return reply.status(201).send(r);
  });
  // admin: run the auto-verify sweep now
  app.post("/v1/admin/airdrop/verify-sweep", async (req) => {
    admin(req);
    return airdropVerifySweep(ctx);
  });
  // admin: mark a claim approved / rejected after checking follow + repost
  app.post<{ Params: { id: string } }>("/v1/airdrop/claims/:id/status", async (req) => {
    admin(req);
    const s = ((req.body ?? {}) as Record<string, unknown>).status;
    if (typeof s !== "string" || !(AIRDROP_STATUSES as readonly string[]).includes(s)) throw new ApiError(400, "validation_error", `status: ${AIRDROP_STATUSES.join(" | ")}`);
    return setAirdropStatus(ctx, req.params.id, s as AirdropStatus);
  });
}
