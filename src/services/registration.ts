import { and, eq, ne } from "drizzle-orm";
import { encodeFunctionData, isAddressEqual, type Address, type Hex } from "viem";
import type { AppContext } from "../context.js";
import { AgentRegistryAbi } from "../chain/abi.js";
import { chainNow } from "../chain/client.js";
import { AgentBindingTypes, EligibilityPostsTypes, RegisterTypes, agentDomain, registryDomain } from "../chain/eip712.js";
import { agentIdHash, checksum, handleHash, hmacCode, lc, normAgentId, normHandle, nowSec, parseTweetId, randomCode, uuid } from "../lib/util.js";
import { verifyAgentSignature, walletType } from "./sigverify.js";
import { checkEligibility, isAuthor, loadEligibilityPosts, saveEligibilityPosts, thresholdsFromConfig, type EligibilityResult } from "./eligibility.js";
import { runAdminTx } from "./adminTx.js";
import type { XPost } from "../providers/x/types.js";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export type Intent = "launch" | "trade";

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-_.]{0,62}\.[a-z0-9]{2,16}$/;
const HANDLE_RE = /^[a-z0-9_]{1,15}$/;

export function referralCode(ctx: AppContext, wallet: string) {
  return "R" + hmacCode(ctx.cfg.CODE_SECRET, ["ref", lc(wallet)], 7);
}

export function challengeMessage(c: { agentId: string; wallet: string; xHandle: string; intent: string; id: string; issuedAt: number; expiresAt: number; chainId: number }) {
  return [
    "AgentPad agent registration",
    `Agent ID: ${c.agentId}`,
    `Wallet: ${checksum(c.wallet)}`,
    `X: @${c.xHandle}`,
    `Intent: ${c.intent}`,
    `Chain ID: ${c.chainId}`,
    `Challenge: ${c.id}`,
    `Issued At: ${new Date(c.issuedAt * 1000).toISOString()}`,
    `Expires At: ${new Date(c.expiresAt * 1000).toISOString()}`,
  ].join("\n");
}

/** Step 1: issue a challenge (message to sign + X verification code to post). */
export async function createChallenge(ctx: AppContext, input: { agentId: string; wallet: string; xHandle: string; intent?: Intent }) {
  const agentId = normAgentId(input.agentId);
  const xHandle = normHandle(input.xHandle);
  const intent: Intent = input.intent === "launch" ? "launch" : "trade";
  if (!AGENT_ID_RE.test(agentId)) throw new ApiError(400, "invalid_agent_id", "agentId must look like name.ai");
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.wallet)) throw new ApiError(400, "bad_wallet", "wallet must be a 0x address");
  if (!HANDLE_RE.test(xHandle)) throw new ApiError(400, "bad_x_handle", "invalid X handle");
  const wallet = lc(input.wallet);
  const id = uuid();
  const issuedAt = nowSec();
  const expiresAt = issuedAt + ctx.cfg.CHALLENGE_TTL_MIN * 60;
  const xCode = `AgentPad-verify-${randomCode(10)}`;
  const chainId = ctx.cfg.CHAIN_ID;
  const message = challengeMessage({ agentId, wallet, xHandle, intent, id, issuedAt, expiresAt, chainId });
  const typedData = {
    domain: agentDomain(chainId, ctx.addresses.registry),
    types: AgentBindingTypes,
    primaryType: "AgentBinding" as const,
    message: { agentId, wallet: checksum(wallet), xHandle, intent, challenge: id, issuedAt, expiresAt },
  };
  const { db, t } = ctx.database;
  await db.insert(t.challenges).values({ id, agentId, wallet, xHandle, intent, xCode, message, typedData: JSON.stringify(typedData), issuedAt, expiresAt });
  return {
    challengeId: id,
    message,
    typedData,
    xCode,
    xPostText: `Verifying my AI agent ${agentId} on AgentPad: ${xCode}`,
    expiresAt,
    instructions:
      "1) Post a public X post from @" + xHandle + " that contains xCode and copy its URL (it is never searched for). 2) Sign `message` " +
      "(EIP-191 personal_sign) or `typedData` (EIP-712; required for Binance agentic / smart-contract wallets) with the wallet. " +
      "3) POST /v1/register/verify with tweetUrl (+ eligibilityPostUrls: >= 10 of your own post URLs from the last 30 days for intent=launch).",
  };
}

/** Looks up the submitted verification post (no X search: the agent must submit the post URL). */
async function findVerificationPost(ctx: AppContext, user: { id: string; username: string }, code: string, tweetUrl?: string): Promise<XPost> {
  if (!tweetUrl) throw new ApiError(422, "x_post_url_required", "post the X code from your bound account, then submit the post URL (tweetUrl / xProofTweetUrl)");
  const id = parseTweetId(tweetUrl);
  if (!id) throw new ApiError(400, "bad_tweet_url", "tweetUrl is not an X post URL");
  const p = await ctx.x.getPost(id);
  if (!p) throw new ApiError(422, "x_post_not_found", `X post ${id} not found (deleted, protected, or not yet visible)`);
  if (!isAuthor(p, user)) throw new ApiError(422, "x_post_wrong_author", `post ${id} is by @${p.authorUsername}, not @${user.username}`);
  if (!p.text.includes(code)) throw new ApiError(422, "x_post_not_found", `post ${id} does not contain ${code}`);
  return p;
}

export interface VerifyInput {
  challengeId: string;
  signature: Hex;
  signatureType?: "eip191" | "eip712";
  tweetUrl?: string;
  /** intent=launch: >= ELIG_MIN_POSTS_30D of the agent's own post URLs from the last 30 days (else the stored set is used). */
  eligibilityPostUrls?: string[];
  relay?: boolean; // ask the platform relayer to submit AgentRegistry.register (gas paid by platform)
}

/** Step 2: verify everything and return the platform EIP-712 registration signature. */
export async function verifyRegistration(ctx: AppContext, input: VerifyInput) {
  const { db, t } = ctx.database;
  const [ch] = await db.select().from(t.challenges).where(eq(t.challenges.id, input.challengeId));
  if (!ch) throw new ApiError(404, "challenge_not_found", "unknown challengeId");
  if (ch.usedAt) throw new ApiError(409, "challenge_used", "challenge already used");
  if (nowSec() > ch.expiresAt) throw new ApiError(410, "challenge_expired", "challenge expired, request a new one");
  const wallet = checksum(ch.wallet);

  // (a) wallet signature — EOA ecrecover, ERC-1271 smart wallet, or ERC-6492 counterfactual wallet
  const kind = input.signatureType ?? "eip191";
  const ok =
    kind === "eip712"
      ? await verifyAgentSignature(ctx.pc, { kind, address: wallet, signature: input.signature, typedData: JSON.parse(ch.typedData) })
      : await verifyAgentSignature(ctx.pc, { kind, address: wallet, signature: input.signature, message: ch.message });
  if (!ok) throw new ApiError(401, "bad_signature", "wallet signature invalid");
  const wType = await walletType(ctx.pc, wallet);

  // (b) agentId resolves to this wallet (Binance Agent ID)
  const resolved = await ctx.resolver.resolve(ch.agentId);
  if (!resolved) throw new ApiError(422, "agent_id_unresolved", `${ch.agentId} does not resolve to an address on BSC`);
  if (resolved.isFallback) throw new ApiError(422, "agent_id_fallback", `${ch.agentId} has no BSC record of its own (fallback address); set a BSC address for the Agent ID`);
  if (!isAddressEqual(resolved.address, wallet)) {
    throw new ApiError(422, "agent_id_mismatch", `${ch.agentId} resolves to ${resolved.address}, not ${wallet}`);
  }

  // (c) X ownership via verification post
  const user = await ctx.x.getUserByUsername(ch.xHandle);
  if (!user) throw new ApiError(422, "x_not_found", `X account @${ch.xHandle} not found`);
  const post = await findVerificationPost(ctx, user, ch.xCode, input.tweetUrl);
  if (post.createdAt < ch.issuedAt - 120) throw new ApiError(422, "x_post_too_old", "verification post predates the challenge");

  // uniqueness (mirrors on-chain invariants so the agent gets a clear error instead of a revert)
  const others = await db
    .select()
    .from(t.agents)
    .where(and(ne(t.agents.wallet, lc(wallet)), eq(t.agents.removed, false)));
  if (others.some((a) => a.agentId === ch.agentId && a.onchain)) throw new ApiError(409, "agent_id_taken", "agentId already bound to another wallet");
  if (others.some((a) => a.xHandle === ch.xHandle && a.agentId !== ch.agentId && (a.onchain || a.canTrade)))
    throw new ApiError(409, "x_handle_taken", "X handle already bound to another agent");
  const [existing] = await db.select().from(t.agents).where(eq(t.agents.wallet, lc(wallet)));
  if (existing && existing.onchain && !existing.removed && existing.agentId !== ch.agentId)
    throw new ApiError(409, "wallet_bound", `wallet already bound to ${existing.agentId}`);
  if (existing?.removed) throw new ApiError(403, "agent_removed", "this wallet was removed from the whitelist");

  // (d) launch eligibility (trade-only agents only need agentId + bound X)
  let eligibility: EligibilityResult | null = null;
  let canLaunch = false;
  if (ch.intent === "launch") {
    const refs = input.eligibilityPostUrls?.length ? input.eligibilityPostUrls : ((await loadEligibilityPosts(ctx, wallet))?.postIds ?? []);
    eligibility = await checkEligibility(ctx.x, user, refs, nowSec(), thresholdsFromConfig(ctx.cfg), ctx.cfg.ELIG_MAX_POST_URLS);
    canLaunch = eligibility.eligible;
    if (input.eligibilityPostUrls?.length) await saveEligibilityPosts(ctx, wallet, eligibility.postIds ?? []);
  }
  const canTrade = true;

  // platform EIP-712 signature, exactly as AgentRegistry.register verifies it
  const now = await chainNow(ctx.pc);
  const nonce = (await ctx.pc.readContract({ address: ctx.addresses.registry, abi: AgentRegistryAbi, functionName: "nonces", args: [wallet] })) as bigint;
  const deadline = BigInt(now + 3600);
  const expiry = BigInt(now + ctx.cfg.REGISTRATION_TTL_DAYS * 86400);
  const xHandleHash = handleHash(ch.xHandle);
  const message = { agentId: ch.agentId, wallet, xHandleHash, canLaunch, canTrade, expiry, nonce, deadline };
  const signature = await ctx.signer.signTypedData({
    domain: registryDomain(ctx.cfg.CHAIN_ID, ctx.addresses.registry),
    types: RegisterTypes,
    primaryType: "Register",
    message,
  });
  const calldata = encodeFunctionData({
    abi: AgentRegistryAbi,
    functionName: "register",
    args: [ch.agentId, wallet, xHandleHash, canLaunch, canTrade, expiry, deadline, signature],
  });

  const ts = nowSec();
  const row = {
    wallet: lc(wallet), agentId: ch.agentId, agentIdHash: agentIdHash(ch.agentId), xHandle: ch.xHandle, xHandleHash, xUserId: user.id,
    walletType: wType, refCode: referralCode(ctx, wallet), intent: ch.intent, canLaunch, canTrade,
    eligibility: eligibility ? JSON.stringify(eligibility) : null, expiry: Number(expiry),
    lastQualifiedAt: canLaunch ? ts : existing?.lastQualifiedAt ?? null, lastCheckedAt: ts, updatedAt: ts,
  };
  await db.insert(t.agents).values({ ...row, createdAt: ts }).onConflictDoUpdate({ target: t.agents.wallet, set: row });
  await db.update(t.challenges).set({ usedAt: ts }).where(eq(t.challenges.id, ch.id));

  let relay: { txHash?: string; status: string; error?: string } | undefined;
  if (input.relay) {
    relay = await runAdminTx(ctx, { kind: "register", target: lc(wallet), to: ctx.addresses.registry, data: calldata, reason: "registration relay" });
  }

  return {
    agentId: ch.agentId,
    wallet,
    walletType: wType,
    xHandle: ch.xHandle,
    xHandleHash,
    canLaunch,
    canTrade,
    expiry: expiry.toString(),
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    signature,
    registry: ctx.addresses.registry,
    chainId: ctx.cfg.CHAIN_ID,
    calldata, // AgentRegistry.register(...) ready to send (agent wallet or any relayer)
    eligibility,
    relay,
  };
}

/** Typed data the agent wallet signs to replace its stored eligibility post set. */
export function eligibilityPostsTypedData(chainId: number, registry: Address, wallet: string, postIds: string[], issuedAt: number) {
  return {
    domain: agentDomain(chainId, registry),
    types: EligibilityPostsTypes,
    primaryType: "EligibilityPosts" as const,
    message: { wallet: checksum(wallet), postIds: postIds.join(","), issuedAt: BigInt(issuedAt) },
  };
}

export const ELIG_SUBMIT_MAX_SKEW_SEC = 600;

/**
 * POST /v1/agents/eligibility-posts: a registered agent submits fresh post URLs for the 30-day launch re-check
 * (posts older than 30 days stop counting, so the set must be refreshed). Wallet-signed (EIP-712 EligibilityPosts),
 * replaces the stored set, and returns the eligibility computed from it. A pass while launch is still enabled
 * also counts as a re-qualification (lastQualifiedAt = now).
 */
export async function submitEligibilityPosts(ctx: AppContext, input: { wallet: string; postUrls: string[]; issuedAt: number; signature: Hex }) {
  const { db, t } = ctx.database;
  const wallet = lc(input.wallet);
  const [a] = await db.select().from(t.agents).where(eq(t.agents.wallet, wallet));
  if (!a) throw new ApiError(404, "agent_not_found", "wallet is not a registered agent");
  if (a.removed) throw new ApiError(403, "agent_removed", "this wallet was removed from the whitelist");
  if (Math.abs(nowSec() - input.issuedAt) > ELIG_SUBMIT_MAX_SKEW_SEC) throw new ApiError(400, "stale_signature", `issuedAt must be within ${ELIG_SUBMIT_MAX_SKEW_SEC}s of server time`);
  const ids = input.postUrls.map((u) => parseTweetId(String(u)));
  if (ids.some((i) => !i)) throw new ApiError(400, "bad_tweet_url", "every postUrls entry must be an X post URL or id");
  const typedData = eligibilityPostsTypedData(ctx.cfg.CHAIN_ID, ctx.addresses.registry, wallet, ids as string[], input.issuedAt);
  const ok = await verifyAgentSignature(ctx.pc, { kind: "eip712", address: checksum(wallet), signature: input.signature, typedData: typedData as any });
  if (!ok) throw new ApiError(401, "bad_signature", "signature does not match EligibilityPosts(wallet, postIds, issuedAt)");
  const user = await ctx.x.getUserByUsername(a.xHandle);
  if (!user) throw new ApiError(422, "x_not_found", `X account @${a.xHandle} not found`);
  const now = nowSec();
  const elig = await checkEligibility(ctx.x, user, input.postUrls, now, thresholdsFromConfig(ctx.cfg), ctx.cfg.ELIG_MAX_POST_URLS);
  await saveEligibilityPosts(ctx, wallet, elig.postIds ?? []);
  const launchEnabled = a.onchain ? a.onchainCanLaunch : a.canLaunch;
  const upd: Record<string, unknown> = { eligibility: JSON.stringify(elig), lastCheckedAt: now, updatedAt: now };
  if (elig.eligible && launchEnabled) upd.lastQualifiedAt = now;
  await db.update(t.agents).set(upd).where(eq(t.agents.wallet, wallet));
  return { wallet: checksum(wallet), eligibility: elig, launchEnabled, requalified: elig.eligible && launchEnabled };
}

export async function getAgent(ctx: AppContext, wallet: string) {
  const { db, t } = ctx.database;
  const [a] = await db.select().from(t.agents).where(eq(t.agents.wallet, lc(wallet)));
  if (!a) return null;
  return {
    wallet: a.wallet, agentId: a.agentId, xHandle: a.xHandle, walletType: a.walletType, intent: a.intent,
    canLaunch: a.onchain ? a.onchainCanLaunch : a.canLaunch, canTrade: a.onchain ? a.onchainCanTrade : a.canTrade,
    onchain: a.onchain, removed: a.removed, expiry: a.expiry, refCode: a.refCode,
    eligibility: a.eligibility ? JSON.parse(a.eligibility) : null, lastQualifiedAt: a.lastQualifiedAt,
    sybilFlag: a.sybilFlag, sybilCluster: a.sybilCluster,
  };
}

export type { Address };
