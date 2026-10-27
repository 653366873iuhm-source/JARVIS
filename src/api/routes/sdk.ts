/**
 * SDK routes (sdk/API_CONTRACT.md #1, #2, #5, #6, #7), registered under /v1:
 *   POST /v1/agents/register-request                          two-phase registration (status machine)
 *   GET  /v1/agents/:agentId/registration-signature?wallet=   200 ready / 202 pending / 403 rejected (flat)
 *   GET  /v1/projects/:address/quote?side=mint|burn&count=    curve quote at one pinned block
 *   POST /v1/promotions/code                                  promotion code + 403 not_registered / not_holder
 *   POST /v1/promotions/submit                                promoter submits its post URL (verified via FxTwitter)
 *   POST /v1/agents/eligibility-posts                         wallet-signed fresh eligibility post URLs (30-day re-check)
 *   GET  /v1/rewards/:wallet/proof                            reward proofs + promoterExemptions
 *
 * Registration is an adapter over the existing createChallenge / verifyRegistration logic. Request state is kept
 * in the `kv` table (key `regreq:<agentId>|<wallet>`), so no schema change is needed.
 */
import type { FastifyInstance } from "fastify";
import { desc, eq, like } from "drizzle-orm";
import { z } from "zod";
import { encodeFunctionData, type Address, type Hex } from "viem";
import type { AppContext } from "../../context.js";
import { AgentRegistryAbi, BondingNFTAbi, LaunchFactoryAbi } from "../../chain/abi.js";
import { chainNow } from "../../chain/client.js";
import { RegisterTypes, registryDomain } from "../../chain/eip712.js";
import { ApiError, createChallenge, submitEligibilityPosts, verifyRegistration } from "../../services/registration.js";
import { verifyAgentSignature } from "../../services/sigverify.js";
import { promoCode, promoterProof, submitPromoPost } from "../../services/promotion.js";
import { rewardsFor } from "../../services/rewards.js";
import { clockNow } from "../../services/indexer.js";
import { MAX_CURVE_NFTS, PROMOTION_MAX, quoteBuy, quoteSell } from "../../lib/curve.js";
import { checksum, handleHash, isAddr, lc, normAgentId, normHandle, nowSec } from "../../lib/util.js";

// ------------------------------------------------------------------ shared helpers

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new ApiError(400, "validation_error", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}
function addrParam(v: string | undefined) {
  if (!isAddr(v)) throw new ApiError(400, "bad_address", "invalid address");
  return lc(v);
}

// ------------------------------------------------------------------ registration state machine

export type RegStatus = "awaiting_wallet_signature" | "awaiting_x_proof" | "verifying" | "approved" | "rejected";

export interface RegRequest {
  requestId: string;
  agentId: string;
  wallet: string; // lowercase
  xHandle: string;
  intent: "launch" | "trade";
  status: RegStatus;
  challengeId: string;
  issuedAt: number;
  expiresAt: number;
  xCode: string;
  xExpiresAt: number;
  walletVerified: boolean;
  walletSignature: Hex | null;
  tweetUrl: string | null;
  /** intent=launch: the agent's own post URLs (last 30 days) for the eligibility check. */
  eligibilityPostUrls?: string[] | null;
  reason: string | null;
  lastXCheckAt: number | null;
  /** Platform registration signature from verifyRegistration (refreshed on read when stale). */
  result: { expiry: string; nonce: string; deadline: string; signature: Hex; canLaunch: boolean; canTrade: boolean; xHandleHash: Hex } | null;
  createdAt: number;
  updatedAt: number;
}

/** Seconds between re-checks of a SUBMITTED proof post triggered by polling the signature route (no X search). */
export const X_RECHECK_SEC = 10;
/** retryAfter returned with 202 pending. */
export const RETRY_AFTER_SEC = 5;

export const regKey = (agentId: string, wallet: string) => `regreq:${agentId}|${lc(wallet)}`;

/** Verification errors that end a request (a new phase-1 call starts a fresh one). Others are retried or rethrown. */
export function classifyVerifyError(code: string): "awaiting_x_proof" | "rejected" | "reissue" | "rethrow" {
  if (code === "x_post_not_found" || code === "bad_tweet_url" || code === "x_post_url_required" || code === "x_post_wrong_author") return "awaiting_x_proof";
  if (code === "challenge_expired") return "reissue";
  if (
    code.startsWith("agent_id_") || code === "x_not_found" || code === "x_post_too_old" || code === "x_handle_taken" ||
    code === "wallet_bound" || code === "agent_removed" || code === "bad_signature"
  )
    return "rejected";
  return "rethrow";
}

export function xPostText(agentId: string, xCode: string) {
  return `Verifying my AI agent ${agentId} on AgentPad: ${xCode}`;
}

/** RegisterRequestResponse (contract #1). */
export function toRegisterRequestResponse(r: RegRequest) {
  return {
    requestId: r.requestId,
    agentId: r.agentId,
    wallet: checksum(r.wallet),
    xHandle: r.xHandle,
    intent: r.intent,
    status: r.status,
    binding: { challenge: r.challengeId, issuedAt: r.issuedAt, expiresAt: r.expiresAt },
    xChallenge: { code: r.xCode, text: xPostText(r.agentId, r.xCode), expiresAt: r.xExpiresAt },
    reason: r.reason,
  };
}

/** Body of GET registration-signature for a non-ready request: [httpStatus, body]. */
export function pendingOrRejected(r: RegRequest): [number, unknown] {
  if (r.status === "rejected") return [403, { status: "rejected", reason: r.reason ?? "rejected" }];
  return [202, { status: "pending", requestStatus: r.status, retryAfter: RETRY_AFTER_SEC, reason: r.reason }];
}

async function loadReq(ctx: AppContext, key: string): Promise<RegRequest | null> {
  const { db, t } = ctx.database;
  const [row] = await db.select().from(t.kv).where(eq(t.kv.key, key));
  return row ? (JSON.parse(row.value) as RegRequest) : null;
}
async function saveReq(ctx: AppContext, r: RegRequest) {
  const { db, t } = ctx.database;
  r.updatedAt = nowSec();
  const value = JSON.stringify(r);
  const key = regKey(r.agentId, r.wallet);
  await db.insert(t.kv).values({ key, value }).onConflictDoUpdate({ target: t.kv.key, set: { value } });
}

/** Issues (or re-issues) the binding challenge for a request. Keeps the X code across re-issues so an existing post still counts. */
async function issueChallenge(ctx: AppContext, r: Pick<RegRequest, "agentId" | "wallet" | "xHandle" | "intent"> & { xCode?: string }) {
  const ch = await createChallenge(ctx, { agentId: r.agentId, wallet: r.wallet, xHandle: r.xHandle, intent: r.intent });
  let xCode = ch.xCode;
  if (r.xCode) {
    const { db, t } = ctx.database;
    await db.update(t.challenges).set({ xCode: r.xCode }).where(eq(t.challenges.id, ch.challengeId));
    xCode = r.xCode;
  }
  return { challengeId: ch.challengeId, issuedAt: ch.typedData.message.issuedAt, expiresAt: ch.expiresAt, xCode };
}

/**
 * Runs the full verification (agentId resolution, X post, uniqueness, eligibility, platform signature) once the
 * wallet is verified. Updates `r` in place according to the outcome.
 */
async function attemptVerify(ctx: AppContext, r: RegRequest) {
  if (!r.walletVerified || !r.walletSignature || r.status === "approved" || r.status === "rejected") return;
  r.status = "verifying";
  r.lastXCheckAt = nowSec();
  await saveReq(ctx, r);
  try {
    const v = await verifyRegistration(ctx, {
      challengeId: r.challengeId, signature: r.walletSignature, signatureType: "eip712", tweetUrl: r.tweetUrl ?? undefined,
      eligibilityPostUrls: r.eligibilityPostUrls ?? undefined,
    });
    r.status = "approved";
    r.reason = null;
    r.result = { expiry: v.expiry, nonce: v.nonce, deadline: v.deadline, signature: v.signature, canLaunch: v.canLaunch, canTrade: v.canTrade, xHandleHash: v.xHandleHash };
  } catch (e) {
    if (!(e instanceof ApiError)) {
      r.status = "awaiting_x_proof";
      await saveReq(ctx, r);
      throw e;
    }
    const kind = classifyVerifyError(e.code);
    if (kind === "awaiting_x_proof" || kind === "reissue") {
      r.status = "awaiting_x_proof";
      r.reason = `${e.code}: ${e.message}`;
    } else if (kind === "rejected") {
      r.status = "rejected";
      r.reason = `${e.code}: ${e.message}`;
    } else {
      r.status = "awaiting_x_proof";
      await saveReq(ctx, r);
      throw e;
    }
  }
  await saveReq(ctx, r);
}

const RegisterBody = z.object({
  agentId: z.string(),
  wallet: addr,
  xHandle: z.string(),
  chainId: z.number().int(),
  intent: z.enum(["launch", "trade"]).optional(),
  challenge: z.string().optional(),
  issuedAt: z.number().int().optional(),
  expiresAt: z.number().int().optional(),
  walletSignature: hex.optional(),
  xProofTweetUrl: z.string().optional(),
  eligibilityPostUrls: z.array(z.string()).max(200).optional(),
});

export async function registerRequest(ctx: AppContext, body: unknown) {
  const b = parse(RegisterBody, body);
  if (b.chainId !== ctx.cfg.CHAIN_ID) throw new ApiError(400, "wrong_chain", `chainId must be ${ctx.cfg.CHAIN_ID}`);
  const agentId = b.agentId.trim();
  if (agentId !== normAgentId(agentId) || !agentId.endsWith(".ai")) throw new ApiError(400, "invalid_agent_id", "agentId must be a lowercase .ai Agent ID");
  const xHandle = normHandle(b.xHandle);
  const intent = b.intent ?? "launch";
  const wallet = lc(b.wallet);
  const now = nowSec();

  let r = await loadReq(ctx, regKey(agentId, wallet));
  const paramsChanged = r && (r.xHandle !== xHandle || r.intent !== intent);
  if (!r || r.status === "rejected" || (paramsChanged && r.status !== "approved")) {
    // new request (first call, previous one rejected, or handle/intent changed before approval)
    const ch = await issueChallenge(ctx, { agentId, wallet, xHandle, intent });
    r = {
      requestId: `req_${ch.challengeId}`, agentId, wallet, xHandle, intent, status: "awaiting_wallet_signature",
      challengeId: ch.challengeId, issuedAt: ch.issuedAt, expiresAt: ch.expiresAt, xCode: ch.xCode, xExpiresAt: ch.expiresAt,
      walletVerified: false, walletSignature: null, tweetUrl: null, reason: null, lastXCheckAt: null, result: null, createdAt: now, updatedAt: now,
    };
    await saveReq(ctx, r);
  } else if (r.status !== "approved" && r.expiresAt < now) {
    // binding challenge expired: re-issue it (same X code), wallet must sign again
    const ch = await issueChallenge(ctx, { ...r, xCode: r.xCode });
    Object.assign(r, { challengeId: ch.challengeId, issuedAt: ch.issuedAt, expiresAt: ch.expiresAt, xExpiresAt: ch.expiresAt, walletVerified: false, walletSignature: null, status: "awaiting_wallet_signature" as RegStatus });
    await saveReq(ctx, r);
  }
  if (r.status === "approved") return toRegisterRequestResponse(r);

  if (b.walletSignature) {
    if (b.challenge !== r.challengeId || (b.issuedAt !== undefined && b.issuedAt !== r.issuedAt) || (b.expiresAt !== undefined && b.expiresAt !== r.expiresAt)) {
      throw new ApiError(400, "bad_challenge", "unknown or expired challenge; request a new one");
    }
    const { db, t } = ctx.database;
    const [ch] = await db.select().from(t.challenges).where(eq(t.challenges.id, r.challengeId));
    if (!ch) throw new ApiError(400, "bad_challenge", "unknown challenge");
    const ok = await verifyAgentSignature(ctx.pc, { kind: "eip712", address: checksum(wallet), signature: b.walletSignature as Hex, typedData: JSON.parse(ch.typedData) });
    if (!ok) throw new ApiError(401, "bad_wallet_signature", "wallet signature does not match the AgentBinding challenge");
    r.walletVerified = true;
    r.walletSignature = b.walletSignature as Hex;
    if (r.status === "awaiting_wallet_signature") r.status = "awaiting_x_proof";
    if (b.xProofTweetUrl) r.tweetUrl = b.xProofTweetUrl;
    if (b.eligibilityPostUrls?.length) r.eligibilityPostUrls = b.eligibilityPostUrls;
    await saveReq(ctx, r);
    await attemptVerify(ctx, r);
  } else if (r.walletVerified && (b.xProofTweetUrl || b.eligibilityPostUrls?.length)) {
    // wallet already proven on an earlier call: the agent only submits its proof post URL (and eligibility URLs) now
    if (b.challenge !== undefined && b.challenge !== r.challengeId) throw new ApiError(400, "bad_challenge", "unknown or expired challenge; request a new one");
    if (b.xProofTweetUrl) r.tweetUrl = b.xProofTweetUrl;
    if (b.eligibilityPostUrls?.length) r.eligibilityPostUrls = b.eligibilityPostUrls;
    if (r.status === "awaiting_x_proof") await attemptVerify(ctx, r);
    else await saveReq(ctx, r);
  }
  return toRegisterRequestResponse(r);
}

async function findRequest(ctx: AppContext, agentId: string, wallet: string | undefined): Promise<RegRequest | null> {
  if (wallet) return loadReq(ctx, regKey(agentId, wallet));
  const { db, t } = ctx.database;
  const rows = await db.select().from(t.kv).where(like(t.kv.key, `regreq:${agentId}|%`));
  const reqs = rows.map((x) => JSON.parse(x.value) as RegRequest).sort((a, b) => b.updatedAt - a.updatedAt);
  return reqs[0] ?? null;
}

/** GET registration-signature: returns [httpStatus, body]. */
export async function registrationSignature(ctx: AppContext, agentIdRaw: string, walletRaw: string | undefined): Promise<[number, unknown]> {
  const agentId = normAgentId(agentIdRaw);
  const wallet = walletRaw ? addrParam(walletRaw) : undefined;
  const r = await findRequest(ctx, agentId, wallet);
  if (!r) throw new ApiError(404, "not_found", "no registration request for this agentId/wallet");

  // a submitted proof URL that didn't verify yet (not visible yet / transient lookup failure): re-check, throttled.
  // Without a submitted URL there is nothing to check (no X search) — the agent must submit xProofTweetUrl.
  if (r.status === "awaiting_x_proof" && r.walletVerified && r.tweetUrl && (r.lastXCheckAt ?? 0) + X_RECHECK_SEC <= nowSec()) {
    await attemptVerify(ctx, r);
  }
  if (r.status !== "approved") return pendingOrRejected(r);

  const { db, t } = ctx.database;
  const [a] = await db.select().from(t.agents).where(eq(t.agents.wallet, r.wallet));
  if (!a || a.agentId !== r.agentId) return [202, { status: "pending", requestStatus: "verifying", retryAfter: RETRY_AFTER_SEC, reason: null }];
  if (a.removed) return [403, { status: "rejected", reason: "agent_removed: this wallet was removed from the whitelist" }];

  const w = checksum(r.wallet);
  const nonce = (await ctx.pc.readContract({ address: ctx.addresses.registry, abi: AgentRegistryAbi, functionName: "nonces", args: [w] })) as bigint;
  const now = await chainNow(ctx.pc);
  let res = r.result;
  // refresh when the stored signature can no longer be submitted (nonce used / deadline close)
  if (!res || BigInt(res.nonce) !== nonce || Number(res.deadline) < now + 120) {
    const xHandleHash = handleHash(a.xHandle);
    const message = {
      agentId: a.agentId, wallet: w, xHandleHash, canLaunch: a.canLaunch, canTrade: a.canTrade,
      expiry: BigInt(a.expiry ?? now + ctx.cfg.REGISTRATION_TTL_DAYS * 86400), nonce, deadline: BigInt(now + 3600),
    };
    const signature = await ctx.signer.signTypedData({ domain: registryDomain(ctx.cfg.CHAIN_ID, ctx.addresses.registry), types: RegisterTypes, primaryType: "Register", message });
    res = { expiry: message.expiry.toString(), nonce: nonce.toString(), deadline: message.deadline.toString(), signature, canLaunch: a.canLaunch, canTrade: a.canTrade, xHandleHash };
    r.result = res;
    await saveReq(ctx, r);
  }
  return [
    200,
    {
      status: "ready", chainId: ctx.cfg.CHAIN_ID, registry: ctx.addresses.registry, agentId: r.agentId, wallet: w, xHandleHash: res.xHandleHash,
      canLaunch: res.canLaunch, canTrade: res.canTrade, expiry: res.expiry, nonce: res.nonce, deadline: res.deadline, signature: res.signature,
      // extra (harmless): ready-to-send AgentRegistry.register calldata
      calldata: encodeFunctionData({
        abi: AgentRegistryAbi, functionName: "register",
        args: [r.agentId, w, res.xHandleHash, res.canLaunch, res.canTrade, BigInt(res.expiry), BigInt(res.deadline), res.signature],
      }),
    },
  ];
}

// ------------------------------------------------------------------ quote

export interface CurveSnapshot { virtualBnb: bigint; virtualToken: bigint; totalSupply: bigint; feeBps: number }

/** QuoteResponse (contract #5) from a state snapshot; throws 400 bad_amount like BondingNFT.quoteMint/quoteBurn. */
export function toQuote(project: string, side: "mint" | "burn", count: number, blockNumber: bigint, s: CurveSnapshot) {
  if (!Number.isSafeInteger(count) || count <= 0) throw new ApiError(400, "bad_amount", "count must be a positive integer");
  const fee = BigInt(s.feeBps);
  let amount: bigint, f: bigint, total: bigint;
  if (side === "mint") {
    const remaining = BigInt(MAX_CURVE_NFTS) - s.totalSupply;
    if (BigInt(count) > remaining) throw new ApiError(400, "bad_amount", `count ${count} exceeds remaining curve supply ${remaining}`);
    const q = quoteBuy(s.virtualBnb, s.virtualToken, count, fee);
    [amount, f, total] = [q.cost, q.fee, q.total];
  } else {
    if (BigInt(count) > s.totalSupply) throw new ApiError(400, "bad_amount", `count ${count} exceeds supply ${s.totalSupply}`);
    const q = quoteSell(s.virtualBnb, s.virtualToken, count, fee);
    [amount, f, total] = [q.gross, q.fee, q.net];
  }
  return {
    project: checksum(project), side, count, amount: amount.toString(), fee: f.toString(), total: total.toString(), blockNumber: blockNumber.toString(),
    state: { virtualBnb: s.virtualBnb.toString(), virtualToken: s.virtualToken.toString(), totalSupply: s.totalSupply.toString(), feeBps: s.feeBps },
  };
}

async function quoteRoute(ctx: AppContext, address: string, q: { side?: string; count?: string }) {
  const project = addrParam(address);
  const side = q.side ?? "mint";
  if (side !== "mint" && side !== "burn") throw new ApiError(400, "bad_side", "side must be mint or burn");
  const count = q.count === undefined || q.count === "" ? NaN : Number(q.count);
  if (!Number.isSafeInteger(count) || count <= 0) throw new ApiError(400, "bad_amount", "count must be a positive integer");
  const { db, t } = ctx.database;
  const [p] = await db.select({ a: t.projects.address }).from(t.projects).where(eq(t.projects.address, project));
  if (!p) {
    const isProject = await ctx.pc.readContract({ address: ctx.addresses.factory, abi: LaunchFactoryAbi, functionName: "isProject", args: [checksum(project)] }).catch(() => false);
    if (!isProject) throw new ApiError(404, "not_found", "unknown project");
  }
  const blockNumber = await ctx.pc.getBlockNumber({ cacheTime: 0 });
  const read = (functionName: "virtualBnb" | "virtualToken" | "totalSupply" | "feeBps") =>
    ctx.pc.readContract({ address: checksum(project), abi: BondingNFTAbi, functionName, blockNumber }) as Promise<bigint | number>;
  const [vb, vt, ts, fee] = await Promise.all([read("virtualBnb"), read("virtualToken"), read("totalSupply"), read("feeBps")]);
  return toQuote(project, side, count, blockNumber, { virtualBnb: BigInt(vb), virtualToken: BigInt(vt), totalSupply: BigInt(ts), feeBps: Number(fee) });
}

// ------------------------------------------------------------------ promotion code

/** Frontend base URL for share links (config PUBLIC_APP_URL; the env var is read directly for callers without a ctx). */
export const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL ?? "http://localhost:5173").replace(/\/+$/, "");
/** Frontend route of a project page (frontend/src/App.tsx: /project/:address). */
export const projectLink = (base: string, address: string) => `${base.replace(/\/+$/, "")}/project/${address}`;

/** PromotionCodeResponse (contract #7). */
export function toPromotionCode(
  p: { address: string; tag: string; symbol: string; promotionStart: number | null; graduatedAt: number | null },
  wallet: string, code: string, xHandle: string | null, now: number, appUrl: string = PUBLIC_APP_URL,
) {
  const window = p.promotionStart != null ? { opensAt: p.promotionStart, closesAt: p.graduatedAt ?? p.promotionStart + PROMOTION_MAX } : null;
  return {
    project: checksum(p.address),
    wallet: checksum(wallet),
    code,
    tag: p.tag,
    cashtag: `$${p.symbol}`,
    link: projectLink(appUrl, checksum(p.address)),
    requiredText: [p.tag, code],
    rules: [
      `Post from your bound X account${xHandle ? ` (@${xHandle})` : ""}.`,
      `Include both ${p.tag} and your code ${code} in the post's own text (original post, quote post or reply).`,
      "Then submit the post URL: POST /v1/promotions/submit {project, wallet, url}. Posts are never searched for.",
      "Plain retweets can't be verified: quote-post instead.",
      "Only posts created after the promotion phase starts (sell-out) count.",
      "One post per agent counts; extra posts are ignored.",
      "Write it in your own words: near-duplicate texts are rejected.",
      "You must hold at least one NFT of the project when the gate is evaluated.",
    ],
    window,
    expiresAt: window ? window.closesAt : now + 86_400,
    // extra
    xHandle,
  };
}

async function promotionCodeRoute(ctx: AppContext, body: unknown) {
  const b = parse(z.object({ project: addr, wallet: addr }), body);
  const project = lc(b.project);
  const wallet = lc(b.wallet);
  const { db, t } = ctx.database;
  const [p] = await db.select().from(t.projects).where(eq(t.projects.address, project));
  if (!p) throw new ApiError(404, "not_found", "unknown project");
  const canTrade = await ctx.pc.readContract({ address: ctx.addresses.registry, abi: AgentRegistryAbi, functionName: "canTrade", args: [checksum(wallet)] });
  if (!canTrade) throw new ApiError(403, "not_registered", "wallet is not a registered agent (AgentRegistry.canTrade is false)");
  const bal = (await ctx.pc.readContract({ address: checksum(project), abi: BondingNFTAbi, functionName: "balanceOf", args: [checksum(wallet)] })) as bigint;
  if (bal === 0n) throw new ApiError(403, "not_holder", "wallet holds no NFTs of this project");
  const [a] = await db.select({ xHandle: t.agents.xHandle }).from(t.agents).where(eq(t.agents.wallet, wallet));
  return toPromotionCode(p, wallet, promoCode(ctx, project, wallet), a?.xHandle ?? null, await clockNow(ctx), ctx.cfg.PUBLIC_APP_URL);
}

// ------------------------------------------------------------------ rewards proof

/** RewardsProofResponse.rewards[] from rewardsFor() items (contract #6). */
export function toRewardProofs(r: { rewardPool: string; items: { epoch: number; amountWei: string; proof: string[]; claimed: boolean; root?: string | null; calldata?: string }[] }) {
  return r.items.map((i) => ({
    epoch: String(i.epoch), amount: i.amountWei, proof: i.proof as Hex[], claimed: i.claimed, rewardPool: checksum(r.rewardPool),
    // extras
    root: i.root ?? null, calldata: i.calldata,
  }));
}

async function rewardsProofRoute(ctx: AppContext, walletRaw: string) {
  const wallet = addrParam(walletRaw);
  const base = await rewardsFor(ctx, wallet);
  const { db, t } = ctx.database;
  // projects whose latest submitted attestation lists this wallet
  const atts = await db.select().from(t.attestations).where(eq(t.attestations.status, "submitted")).orderBy(desc(t.attestations.nonce));
  const latest = new Map<string, (typeof atts)[number]>();
  for (const a of atts) if (!latest.has(a.project)) latest.set(a.project, a);
  const promoterExemptions: { project: Address; root: Hex; proof: Hex[]; claimed: boolean }[] = [];
  for (const [project, a] of latest) {
    let promoters: string[] = [];
    try {
      promoters = (JSON.parse(a.promoters) as string[]).map(lc);
    } catch {
      continue;
    }
    if (!promoters.includes(wallet)) continue;
    const pr = await promoterProof(ctx, project, wallet);
    if (!pr) continue;
    const claimed = (await ctx.pc
      .readContract({ address: checksum(project), abi: BondingNFTAbi, functionName: "isPromoter", args: [checksum(wallet)] })
      .catch(() => false)) as boolean;
    promoterExemptions.push({ project: checksum(project), root: pr.root as Hex, proof: pr.proof as Hex[], claimed });
  }
  return { wallet: checksum(wallet), rewards: toRewardProofs(base), promoterExemptions };
}

// ------------------------------------------------------------------ registration with fastify

export function registerSdkRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post("/v1/agents/register-request", async (req) => registerRequest(ctx, req.body));
  app.get<{ Params: { agentId: string }; Querystring: { wallet?: string } }>("/v1/agents/:agentId/registration-signature", async (req, reply) => {
    const [status, body] = await registrationSignature(ctx, decodeURIComponent(req.params.agentId), req.query.wallet || undefined);
    return reply.status(status).send(body);
  });
  app.get<{ Params: { address: string }; Querystring: { side?: string; count?: string } }>("/v1/projects/:address/quote", async (req) =>
    quoteRoute(ctx, req.params.address, req.query),
  );
  app.post("/v1/promotions/code", async (req) => promotionCodeRoute(ctx, req.body));
  app.post("/v1/promotions/submit", async (req) => {
    const b = parse(z.object({ project: addr, wallet: addr, url: z.string().min(1) }), req.body);
    return submitPromoPost(ctx, { project: b.project, wallet: b.wallet, url: b.url });
  });
  app.post("/v1/agents/eligibility-posts", async (req) => {
    const b = parse(z.object({ wallet: addr, postUrls: z.array(z.string()).min(1).max(200), issuedAt: z.number().int(), signature: hex }), req.body);
    return submitEligibilityPosts(ctx, { wallet: b.wallet, postUrls: b.postUrls, issuedAt: b.issuedAt, signature: b.signature as Hex });
  });
  app.get<{ Params: { wallet: string } }>("/v1/rewards/:wallet/proof", async (req) => rewardsProofRoute(ctx, req.params.wallet));
}

