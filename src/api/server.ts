import { exportBackup, uploadBackup, lastBackupAt } from "../services/backup.js";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { ApiError, createChallenge, getAgent, verifyRegistration } from "../services/registration.js";
import { candles, leaderboard, listProjects, projectDetail, projectHolders, projectTrades, recentTrades } from "../services/market.js";
import { promoCode, promoterProof, promotionStatus, promotionTick, submitPromoPost } from "../services/promotion.js";
import { bindReferral, getReferralCode } from "../services/referrals.js";
import { rewardsFor, runRewardEpoch, epochOf } from "../services/rewards.js";
import { listClusters, removeAgent, revokeLaunch, runSybilScan } from "../services/sybil.js";
import { requalifyAgents } from "../services/requalify.js";
import { sendAdminTx } from "../services/adminTx.js";
import { adminLaunchVoucher } from "../services/launchVoucher.js";
import { Indexer, clockNow } from "../services/indexer.js";
import { isAddr, jsonStringify, lc } from "../lib/util.js";
import { registerSdkRoutes } from "./routes/sdk.js";
import { registerAirdropRoutes } from "./routes/airdrop.js";
import { registerMiningRoutes } from "./routes/mining.js";
import { registerAgentFlowRoutes } from "./routes/agentflow.js";
import { feCandles, feHolders, handleTradeSocket, registerFrontendRoutes } from "./routes/frontend.js";
import { corsOrigin } from "./cors.js";
import { AgentRegistryAbi, FeeSplitterAbi, LaunchFactoryAbi } from "../chain/abi.js";

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new ApiError(400, "validation_error", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}
const num = (v: unknown) => (v === undefined || v === "" ? undefined : Number(v));
function addrParam(v: string) {
  if (!isAddr(v)) throw new ApiError(400, "bad_address", "invalid address");
  return lc(v);
}

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: ctx.cfg.NODE_ENV === "test" ? false : { level: ctx.cfg.LOG_LEVEL } });
  await app.register(cors, { origin: corsOrigin(ctx.cfg) });
  await app.register(websocket);

  // bigint-safe JSON
  app.setReplySerializer((payload) => jsonStringify(payload));
  // Error envelope (all routes): { error: { code, message, details? } }
  const fail = (code: string, message: string, details?: unknown) => ({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send(fail(err.code, err.message, err.details));
    if (err?.validation) return reply.status(400).send(fail("validation_error", err.message, err.validation));
    // fastify-level client errors (bad JSON body, payload too large, …)
    if (typeof err?.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send(fail(String(err.code ?? "bad_request").toLowerCase(), String(err.message ?? "bad request")));
    }
    ctx.log.error(err, "unhandled API error");
    return reply.status(500).send(fail("internal_error", String(err?.message ?? err)));
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send(fail("not_found", `${req.method} ${req.url.split("?")[0]}`)));

  const admin = (req: FastifyRequest) => {
    const h = req.headers.authorization ?? "";
    if (h !== `Bearer ${ctx.cfg.ADMIN_TOKEN}`) throw new ApiError(401, "unauthorized", "admin token required");
  };

  // ?deep=1 adds live on-chain reads (registry/factory/fee-splitter config) so a deploy can prove it talks to the right chain.
  let deepCache: { at: number; v: unknown } | null = null;
  const onchain = async () => {
    if (deepCache && Date.now() - deepCache.at < 30_000) return deepCache.v;
    const rd = (address: `0x${string}`, abi: any, functionName: string) =>
      ctx.pc.readContract({ address, abi, functionName } as any).catch((e: any) => ({ error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) }));
    const a = ctx.addresses;
    const [platformSigner, registryOwner, factoryOwner, projectCount, charityShareBps, settings] = await Promise.all([
      rd(a.registry, AgentRegistryAbi, "platformSigner"), rd(a.registry, AgentRegistryAbi, "owner"),
      rd(a.factory, LaunchFactoryAbi, "owner"), rd(a.factory, LaunchFactoryAbi, "projectCount"),
      rd(a.factory, LaunchFactoryAbi, "CHARITY_SHARE_BPS"), rd(a.factory, LaunchFactoryAbi, "settings"),
    ]);
    const [charity, totalDonated] = a.feeSplitter
      ? await Promise.all([rd(a.feeSplitter, FeeSplitterAbi, "charity"), rd(a.feeSplitter, FeeSplitterAbi, "totalDonated")])
      : [null, null];
    const signer = await ctx.signer.getAddress().catch(() => null);
    const v = {
      platformSigner, registryOwner, factoryOwner, projectCount, charityShareBps, settings, charity, totalDonated,
      backendSigner: signer,
      signerMatches: typeof platformSigner === "string" && !!signer && platformSigner.toLowerCase() === signer.toLowerCase(),
    };
    deepCache = { at: Date.now(), v };
    return v;
  };
  const health = async (req: FastifyRequest<{ Querystring: Record<string, string> }>) => {
    const block = await ctx.pc.getBlockNumber().catch(() => null);
    const base = { ok: true, chainId: ctx.cfg.CHAIN_ID, block, db: ctx.database.dialect, contracts: ctx.addresses, txSendEnabled: ctx.cfg.TX_SEND_ENABLED, backup: { enabled: !!ctx.cfg.HF_TOKEN, lastOkAt: await lastBackupAt(ctx).catch(() => null) } };
    const deep = req.query?.deep;
    if (deep === "1" || deep === "true") return { ...base, onchain: await onchain() };
    return base;
  };
  app.get<{ Querystring: Record<string, string> }>("/health", health);
  app.get<{ Querystring: Record<string, string> }>("/v1/health", health); // platform health checks (render.yaml / fly.toml)

  // ------------------------------------------------------------------ registration
  app.post("/v1/register/challenge", async (req) => {
    const b = parse(z.object({ agentId: z.string(), wallet: addr, xHandle: z.string(), intent: z.enum(["launch", "trade"]).optional() }), req.body);
    return createChallenge(ctx, b);
  });
  app.post("/v1/register/verify", async (req) => {
    const b = parse(
      z.object({
        challengeId: z.string(), signature: hex, signatureType: z.enum(["eip191", "eip712"]).optional(), tweetUrl: z.string().optional(),
        eligibilityPostUrls: z.array(z.string()).max(200).optional(), relay: z.boolean().optional(),
      }),
      req.body,
    );
    return verifyRegistration(ctx, b as any);
  });
  // GET /v1/agents/:query (wallet or .ai id -> AgentProfile, a superset of the old /v1/agents/:wallet record) and
  // GET /v1/agents/leaderboard live in routes/frontend.ts.

  // ------------------------------------------------------------------ market data
  app.get<{ Querystring: Record<string, string> }>("/v1/projects", async (req) => {
    const q = req.query;
    return listProjects(ctx, {
      filter: q.filter, phase: q.phase, sort: q.sort, order: q.order, limit: num(q.limit), offset: num(q.offset), cursor: q.cursor,
      since: num(q.since), search: q.q, launcher: q.launcher,
    });
  });
  app.get<{ Params: { address: string } }>("/v1/projects/:address", async (req) => projectDetail(ctx, addrParam(req.params.address)));
  app.get<{ Params: { address: string }; Querystring: Record<string, string> }>("/v1/projects/:address/trades", async (req) =>
    projectTrades(ctx, addrParam(req.params.address), { limit: num(req.query.limit), before: num(req.query.before), trader: req.query.trader }),
  );
  app.get<{ Params: { address: string }; Querystring: Record<string, string> }>("/v1/projects/:address/holders", async (req) =>
    feHolders(ctx, addrParam(req.params.address), num(req.query.limit)),
  );
  app.get<{ Params: { address: string }; Querystring: Record<string, string> }>("/v1/projects/:address/candles", async (req) =>
    feCandles(ctx, addrParam(req.params.address), { tf: req.query.tf ?? req.query.interval, from: num(req.query.from), to: num(req.query.to) }),
  );
  app.get<{ Querystring: Record<string, string> }>("/v1/trades/recent", async (req) => recentTrades(ctx, num(req.query.limit) ?? 30));
  app.get<{ Querystring: Record<string, string> }>("/v1/leaderboard", async (req) => leaderboard(ctx, { sort: req.query.sort, limit: num(req.query.limit) }));

  await registerFrontendRoutes(app, ctx);

  // ------------------------------------------------------------------ promotion gate
  app.get<{ Params: { project: string } }>("/v1/promotion/:project", async (req) => promotionStatus(ctx, addrParam(req.params.project)));
  app.get<{ Params: { project: string }; Querystring: { wallet?: string } }>("/v1/promotion/:project/code", async (req) => {
    const project = addrParam(req.params.project);
    const wallet = addrParam(req.query.wallet ?? "");
    const { db, t } = ctx.database;
    const [p] = await db.select().from(t.projects).where(eq(t.projects.address, project));
    if (!p) throw new ApiError(404, "not_found", "unknown project");
    const [a] = await db.select().from(t.agents).where(eq(t.agents.wallet, wallet));
    if (!a) throw new ApiError(404, "agent_not_found", "wallet is not a registered agent");
    const code = promoCode(ctx, project, wallet);
    return {
      project, wallet, tag: p.tag, code, xHandle: a.xHandle,
      rules: "Post once from your bound X account, in your own words, containing both the tag and the code. One post per agent counts; near-duplicate texts are rejected.",
    };
  });
  app.post<{ Params: { project: string } }>("/v1/promotion/:project/posts", async (req) => {
    // legacy alias of POST /v1/promotions/submit (agent found from the post author when wallet is omitted)
    const b = parse(z.object({ tweetUrl: z.string(), wallet: addr.optional() }), req.body);
    return submitPromoPost(ctx, { project: addrParam(req.params.project), url: b.tweetUrl, wallet: b.wallet });
  });
  app.get<{ Params: { project: string; wallet: string } }>("/v1/promotion/:project/proof/:wallet", async (req) => {
    const r = await promoterProof(ctx, addrParam(req.params.project), addrParam(req.params.wallet));
    if (!r) throw new ApiError(404, "not_a_promoter", "wallet is not in the attested promoter set");
    return r;
  });

  // ------------------------------------------------------------------ referrals & rewards
  app.get<{ Querystring: { wallet?: string } }>("/v1/referrals/code", async (req) => getReferralCode(ctx, addrParam(req.query.wallet ?? "")));
  app.post("/v1/referrals/bind", async (req) => {
    const b = parse(z.object({ project: addr, buyer: addr, code: z.string(), signature: hex, signatureType: z.enum(["eip191", "eip712"]).optional() }), req.body);
    return bindReferral(ctx, b as any);
  });
  app.get<{ Params: { wallet: string } }>("/v1/rewards/:wallet", async (req) => rewardsFor(ctx, addrParam(req.params.wallet)));
  app.get("/v1/rewards", async () => {
    const { db, t } = ctx.database;
    const rows = await db.select().from(t.rewardEpochs).orderBy(desc(t.rewardEpochs.epoch)).limit(60);
    return rows.map(({ tree: _tree, ...r }) => r);
  });

  // ------------------------------------------------------------------ admin
  app.get("/v1/admin/backup/export", async (req) => {
    admin(req);
    return exportBackup(ctx);
  });
  app.post("/v1/admin/backup/run", async (req) => {
    admin(req);
    if (!ctx.cfg.HF_TOKEN) throw new ApiError(400, "backup_disabled", "HF_TOKEN not configured");
    return uploadBackup(ctx);
  });
  app.get("/v1/admin/sybil/clusters", async (req) => {
    admin(req);
    return listClusters(ctx);
  });
  app.post<{ Params: { wallet: string } }>("/v1/admin/agents/:wallet/remove", async (req) => {
    admin(req);
    const b = parse(z.object({ reason: z.string().default("sybil") }), req.body ?? {});
    return removeAgent(ctx, addrParam(req.params.wallet), b.reason);
  });
  app.post<{ Params: { wallet: string } }>("/v1/admin/agents/:wallet/revoke-launch", async (req) => {
    admin(req);
    const b = parse(z.object({ reason: z.string().default("admin") }), req.body ?? {});
    return revokeLaunch(ctx, addrParam(req.params.wallet), b.reason);
  });
  // INTERNAL TESTING ONLY (smoke test): signed register(...) with canLaunch=true for an already-registered wallet. Not broadcast.
  app.post<{ Params: { wallet: string } }>("/v1/admin/agents/:wallet/launch-voucher", async (req) => {
    admin(req);
    const b = parse(z.object({ agentId: z.string().min(4), expiryHours: z.number().int().optional(), deadlineMin: z.number().int().optional() }), req.body ?? {});
    return adminLaunchVoucher(ctx, addrParam(req.params.wallet), b.agentId, { expiryHours: b.expiryHours, deadlineMin: b.deadlineMin });
  });
  app.get("/v1/admin/txs", async (req) => {
    admin(req);
    const { db, t } = ctx.database;
    return db.select().from(t.adminTxs).orderBy(desc(t.adminTxs.createdAt)).limit(200);
  });
  app.post<{ Params: { id: string } }>("/v1/admin/txs/:id/send", async (req) => {
    admin(req);
    return sendAdminTx(ctx, req.params.id);
  });
  app.post<{ Params: { job: string } }>("/v1/admin/jobs/:job/run", async (req) => {
    admin(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    switch (req.params.job) {
      case "index":
        await new Indexer(ctx).syncToHead();
        return { ok: true };
      case "promotion":
        return promotionTick(ctx);
      case "rewards": {
        const epoch = typeof body.epoch === "number" ? body.epoch : epochOf(await clockNow(ctx)) - 1;
        return runRewardEpoch(ctx, { epoch, from: body.from as number | undefined, to: body.to as number | undefined, dryRun: !!body.dryRun });
      }
      case "requalify":
        return requalifyAgents(ctx, { now: body.now as number | undefined, force: !!body.force });
      case "sybil":
        return runSybilScan(ctx);
      default:
        throw new ApiError(404, "unknown_job", "jobs: index | promotion | rewards | requalify | sybil");
    }
  });

  // ------------------------------------------------------------------ websocket: live trades
  // ws://host/v1/ws            all trades + project lifecycle events
  // ws://host/v1/ws?project=0x  only that project
  app.get<{ Querystring: { project?: string } }>("/v1/ws", { websocket: true }, (socket, req) => {
    handleTradeSocket(ctx, socket as any, req.query.project);
  });

  registerAirdropRoutes(app, ctx, admin); // 发射台推特空投 campaign
  registerMiningRoutes(app, ctx); // 挖矿积分
  registerAgentFlowRoutes(app, ctx); // one-command agent flow: /agent.md, /v1/agent/flow
  registerSdkRoutes(app, ctx); // SDK contract routes (register-request, registration-signature, quote, promotions/code, rewards proof)
  return app;
}
