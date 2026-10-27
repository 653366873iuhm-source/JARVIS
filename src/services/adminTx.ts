import { eq } from "drizzle-orm";
import type { Address, Hex } from "viem";
import type { AppContext } from "../context.js";
import { nowSec, uuid } from "../lib/util.js";

export type AdminTxKind = "revokeLaunch" | "removeAgent" | "postRoot" | "submitPromotion" | "graduate" | "register";

/**
 * Every state-changing platform transaction goes through here: it is first written to admin_txs ("prepared"),
 * then sent when `send` is true. Kinds that need msg.sender == platformSigner (postRoot, revokeLaunch, removeAgent)
 * are sent by the platform signer; permissionless ones (submitPromotion, graduate, register relay) by the relayer.
 * With AUTO_SUBMIT_ADMIN_TXS=false the governance-type txs stay "prepared" for the owner/multisig to execute
 * (GET /v1/admin/txs gives to+data), or can be sent later with POST /v1/admin/txs/:id/send.
 */
export async function runAdminTx(
  ctx: AppContext,
  p: { kind: AdminTxKind; target: string; to: Address; data: Hex; value?: bigint; reason?: string; send?: boolean },
): Promise<{ id: string; status: string; txHash?: string; error?: string }> {
  const { db, t } = ctx.database;
  const id = uuid();
  const now = nowSec();
  await db.insert(t.adminTxs).values({
    id, kind: p.kind, target: p.target, to: p.to, data: p.data, value: (p.value ?? 0n).toString(), reason: p.reason ?? null,
    status: "prepared", createdAt: now, updatedAt: now,
  });
  const permissionless = p.kind === "submitPromotion" || p.kind === "graduate" || p.kind === "register";
  const send = p.send ?? (permissionless || ctx.cfg.AUTO_SUBMIT_ADMIN_TXS);
  if (!send || !ctx.cfg.TX_SEND_ENABLED) return { id, status: "prepared" };
  return sendAdminTx(ctx, id);
}

export async function sendAdminTx(ctx: AppContext, id: string) {
  const { db, t } = ctx.database;
  const [row] = await db.select().from(t.adminTxs).where(eq(t.adminTxs.id, id));
  if (!row) throw new Error(`admin tx ${id} not found`);
  if (row.status === "confirmed") return { id, status: row.status, txHash: row.txHash ?? undefined };
  if (!ctx.cfg.TX_SEND_ENABLED) return { id, status: row.status, error: "tx sending disabled (TX_SEND_ENABLED=false)" };
  const permissionless = row.kind === "submitPromotion" || row.kind === "graduate" || row.kind === "register";
  const sender = permissionless ? ctx.relayer : ctx.signer;
  try {
    const txHash = await sender.sendTransaction({ to: row.to as Address, data: row.data as Hex, value: BigInt(row.value) });
    await db.update(t.adminTxs).set({ status: "confirmed", txHash, error: null, updatedAt: nowSec() }).where(eq(t.adminTxs.id, id));
    return { id, status: "confirmed", txHash };
  } catch (e: any) {
    const error = String(e?.shortMessage ?? e?.message ?? e).slice(0, 1000);
    await db.update(t.adminTxs).set({ status: "failed", error, updatedAt: nowSec() }).where(eq(t.adminTxs.id, id));
    ctx.log.error({ id, kind: row.kind, error }, "admin tx failed");
    return { id, status: "failed", error };
  }
}
