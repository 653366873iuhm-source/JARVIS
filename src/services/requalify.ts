import { eq } from "drizzle-orm";
import { encodeFunctionData } from "viem";
import type { AppContext } from "../context.js";
import { AgentRegistryAbi } from "../chain/abi.js";
import { checksum, nowSec } from "../lib/util.js";
import { checkEligibility, loadEligibilityPosts, thresholdsFromConfig } from "./eligibility.js";
import { runAdminTx } from "./adminTx.js";

/**
 * Every REQUALIFY_INTERVAL_DAYS (30) days each launch-enabled agent is re-checked against the X criteria: the user
 * (followers, joined) is re-fetched via FxTwitter and the agent's STORED eligibility post URLs are re-fetched for
 * fresh metrics. Only posts from the last 30 days count, so an agent must submit fresh post URLs
 * (POST /v1/agents/eligibility-posts) before its re-check or it fails the ">= 10 posts" rule.
 * Failing agents get AgentRegistry.revokeLaunch(wallet) (trading + existing projects unaffected). The job runs daily
 * and only re-checks agents whose last qualification is older than the interval. To regain launch rights an agent
 * re-registers (challenge -> verify) once it meets the criteria again.
 */
export async function requalifyAgents(ctx: AppContext, opts: { now?: number; force?: boolean } = {}) {
  const { db, t } = ctx.database;
  const now = opts.now ?? nowSec();
  const due = (await db.select().from(t.agents)).filter(
    (a) => a.onchain && a.onchainCanLaunch && !a.removed && (opts.force || (a.lastQualifiedAt ?? 0) <= now - ctx.cfg.REQUALIFY_INTERVAL_DAYS * 86400),
  );
  const results: { wallet: string; eligible: boolean; reasons: string[]; tx?: { status: string; txHash?: string; error?: string } }[] = [];
  for (const a of due) {
    try {
      const user = await ctx.x.getUserByUsername(a.xHandle);
      const stored = await loadEligibilityPosts(ctx, a.wallet);
      const elig = user
        ? await checkEligibility(ctx.x, user, stored?.postIds ?? [], now, thresholdsFromConfig(ctx.cfg), ctx.cfg.ELIG_MAX_POST_URLS)
        : { eligible: false, reasons: ["x_account_missing"], checkedAt: now };
      const upd: Record<string, unknown> = { lastCheckedAt: now, eligibility: JSON.stringify(elig), updatedAt: nowSec() };
      if (elig.eligible) {
        upd.lastQualifiedAt = now;
        await db.update(t.agents).set(upd).where(eq(t.agents.wallet, a.wallet));
        results.push({ wallet: a.wallet, eligible: true, reasons: [] });
        continue;
      }
      await db.update(t.agents).set(upd).where(eq(t.agents.wallet, a.wallet));
      const data = encodeFunctionData({ abi: AgentRegistryAbi, functionName: "revokeLaunch", args: [checksum(a.wallet)] });
      const tx = await runAdminTx(ctx, { kind: "revokeLaunch", target: a.wallet, to: ctx.addresses.registry, data, reason: elig.reasons.join("; ") });
      results.push({ wallet: a.wallet, eligible: false, reasons: elig.reasons, tx });
    } catch (e: any) {
      ctx.log.error(e, `requalify failed for ${a.wallet}`);
      results.push({ wallet: a.wallet, eligible: false, reasons: [`error: ${e?.message ?? e}`] });
    }
  }
  return { checked: due.length, results };
}
