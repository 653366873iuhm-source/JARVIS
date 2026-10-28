/**
 * NFT holdings reconciliation (free eth_call reads only, nothing is sent).
 * Checks every indexed nft_tokens row against BondingNFT.ownerOf(tokenId): a token that reverts (retired by sell /
 * redeem / burn) is removed, a changed owner is updated. Fixes rows left behind when an older indexer build missed a
 * v2 TransferDeferred log (e.g. CHYSELL token 1 after the mainnet sell test).
 */
import { and, eq } from "drizzle-orm";
import { parseAbi, type Address } from "viem";
import type { AppContext } from "../context.js";
import { lc } from "../lib/util.js";

const OwnerAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);

export async function reconcileNftHoldings(ctx: AppContext, opts: { project?: string; limit?: number; dryRun?: boolean } = {}) {
  const { db, t } = ctx.database;
  const where = opts.project ? eq(t.nftTokens.project, lc(opts.project)) : undefined;
  const rows = (await (where ? db.select().from(t.nftTokens).where(where) : db.select().from(t.nftTokens))).slice(0, opts.limit ?? 5000);
  const changes: { project: string; tokenId: number; from: string; to: string | null }[] = [];
  let errors = 0;
  for (const r of rows) {
    let owner: string | null;
    try {
      owner = lc((await ctx.pc.readContract({ address: r.project as Address, abi: OwnerAbi, functionName: "ownerOf", args: [BigInt(r.tokenId)] })) as string);
    } catch (e: any) {
      const msg = String(e?.shortMessage ?? e?.message ?? e);
      // ERC721NonexistentToken (0x7e273289) / generic revert = token retired; network errors are skipped
      if (/revert|7e273289|nonexistent/i.test(msg)) owner = null;
      else {
        errors++;
        continue;
      }
    }
    if (owner === lc(r.owner)) continue;
    changes.push({ project: r.project, tokenId: r.tokenId, from: r.owner, to: owner });
    if (opts.dryRun) continue;
    const key = and(eq(t.nftTokens.project, r.project), eq(t.nftTokens.tokenId, r.tokenId));
    if (owner === null) await db.delete(t.nftTokens).where(key);
    else await db.update(t.nftTokens).set({ owner }).where(key);
  }
  if (changes.length) ctx.log.info({ changes: changes.length, dryRun: !!opts.dryRun }, "nft holdings reconciled");
  return { checked: rows.length, changed: changes.length, errors, dryRun: !!opts.dryRun, changes };
}
