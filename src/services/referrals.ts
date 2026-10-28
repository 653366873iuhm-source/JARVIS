import { and, eq } from "drizzle-orm";
import type { Hex } from "viem";
import type { AppContext } from "../context.js";
import { chainNow } from "../chain/client.js";
import { ReferralBindTypes, agentDomain } from "../chain/eip712.js";
import { checksum, isAddr, lc } from "../lib/util.js";
import { verifyAgentSignature } from "./sigverify.js";
import { ApiError, referralCode } from "./registration.js";

export function referralMessage(project: string, buyer: string, code: string) {
  return `AgentPad referral\nProject: ${checksum(project)}\nBuyer: ${checksum(buyer)}\nCode: ${code}`;
}

export async function getReferralCode(ctx: AppContext, wallet: string) {
  const { db, t } = ctx.database;
  const [a] = await db.select().from(t.agents).where(eq(t.agents.wallet, lc(wallet)));
  if (!a) throw new ApiError(404, "agent_not_found", "wallet is not a registered agent");
  const code = a.refCode ?? referralCode(ctx, wallet);
  // agents first seen on-chain (indexer AgentRegistered) have no stored code yet: persist it, otherwise
  // POST /v1/referrals/bind (looks codes up by agents.ref_code) rejects the code this endpoint just handed out.
  if (!a.refCode) await db.update(t.agents).set({ refCode: code }).where(eq(t.agents.wallet, a.wallet));
  return { wallet: a.wallet, code, linkTemplate: `${ctx.cfg.PUBLIC_APP_ROUTER === "path" ? "" : "/#"}/project/{project}?ref=${code}`, urlTemplate: `${ctx.cfg.PUBLIC_APP_URL.replace(/\/+$/, "")}${ctx.cfg.PUBLIC_APP_ROUTER === "path" ? "" : "/#"}/project/{project}?ref=${code}` };
}

/**
 * First-touch binding of a buyer agent to a referrer code for one project. The buyer proves intent with a wallet
 * signature (EIP-712 ReferralBind, or EIP-191 text for EOAs). Bindings are immutable; buys in the following
 * REFERRAL_WINDOW_SEC count toward the referrer's share of the daily reward pool.
 */
export async function bindReferral(ctx: AppContext, input: { project: string; buyer: string; code: string; signature: Hex; signatureType?: "eip191" | "eip712" }) {
  const { db, t } = ctx.database;
  if (!isAddr(input.project) || !isAddr(input.buyer)) throw new ApiError(400, "bad_address", "project and buyer must be addresses");
  const project = lc(input.project);
  const buyer = lc(input.buyer);
  const [p] = await db.select().from(t.projects).where(eq(t.projects.address, project));
  if (!p) throw new ApiError(404, "not_found", "unknown project");
  if (p.phase !== 0) throw new ApiError(409, "not_trading", "project is no longer trading on the curve");
  const [ref] = await db.select().from(t.agents).where(eq(t.agents.refCode, input.code));
  if (!ref) throw new ApiError(404, "code_not_found", "unknown referral code");
  if (ref.wallet === buyer) throw new ApiError(422, "self_referral", "cannot use your own code");
  const [ex] = await db.select().from(t.referralBindings).where(and(eq(t.referralBindings.project, project), eq(t.referralBindings.buyer, buyer)));
  if (ex) return { project, buyer, referrer: ex.referrer, code: ex.code, boundAt: ex.boundAt, existing: true };
  const kind = input.signatureType ?? "eip712";
  const ok =
    kind === "eip712"
      ? await verifyAgentSignature(ctx.pc, {
          kind, address: checksum(buyer), signature: input.signature,
          typedData: { domain: agentDomain(ctx.cfg.CHAIN_ID, ctx.addresses.registry), types: ReferralBindTypes, primaryType: "ReferralBind", message: { project: checksum(project), buyer: checksum(buyer), code: input.code } },
        })
      : await verifyAgentSignature(ctx.pc, { kind, address: checksum(buyer), signature: input.signature, message: referralMessage(project, buyer, input.code) });
  if (!ok) throw new ApiError(401, "bad_signature", "buyer signature invalid");
  const boundAt = await chainNow(ctx.pc);
  await db.insert(t.referralBindings).values({ project, buyer, referrer: ref.wallet, code: input.code, boundAt }).onConflictDoNothing();
  return { project, buyer, referrer: ref.wallet, code: input.code, boundAt, existing: false };
}
