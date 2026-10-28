/**
 * Daily backup: airdrop_claims + mining_accounts + mining_checkins exported as JSON and committed to a PRIVATE
 * Hugging Face dataset repo (BACKUP_HF_REPO). Enabled only when HF_TOKEN is set. Runs in-process (Render free has no
 * cron): first run 5 min after start, then every BACKUP_INTERVAL_HOURS; the last success is stored in kv so restarts
 * (free-tier sleep) don't cause a backup storm. Files: snapshots/YYYY-MM-DD.json (+ latest.json overwritten).
 */
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { nowSec } from "../lib/util.js";

const KEY = "backup:last_ok";

export async function exportBackup(ctx: AppContext) {
  const { db, t } = ctx.database;
  const [airdropClaims, miningAccounts, miningCheckins] = await Promise.all([
    db.select().from(t.airdropClaims),
    db.select().from(t.miningAccounts),
    db.select().from(t.miningCheckins),
  ]);
  return { exportedAt: nowSec(), chainId: ctx.cfg.CHAIN_ID, db: ctx.database.dialect, pointsUnit: "1e-8", airdropClaims, miningAccounts, miningCheckins };
}

export async function uploadBackup(ctx: AppContext, fetchImpl: typeof fetch = fetch) {
  const token = ctx.cfg.HF_TOKEN;
  if (!token) throw new Error("HF_TOKEN not set");
  const data = await exportBackup(ctx);
  const day = new Date(data.exportedAt * 1000).toISOString().slice(0, 10);
  const content = Buffer.from(JSON.stringify(data, null, 1)).toString("base64");
  const lines = [
    { key: "header", value: { summary: `backup ${day} (${data.airdropClaims.length} claims, ${data.miningAccounts.length} miners)` } },
    { key: "file", value: { path: `snapshots/${day}.json`, content, encoding: "base64" } },
    { key: "file", value: { path: "latest.json", content, encoding: "base64" } },
  ];
  const res = await fetchImpl(`https://huggingface.co/api/datasets/${ctx.cfg.BACKUP_HF_REPO}/commit/main`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson" },
    body: lines.map((l) => JSON.stringify(l)).join("\n"),
  });
  if (!res.ok) throw new Error(`HF commit failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const { db, t } = ctx.database;
  const value = String(data.exportedAt);
  await db.insert(t.kv).values({ key: KEY, value }).onConflictDoUpdate({ target: t.kv.key, set: { value } });
  return { ok: true, path: `snapshots/${day}.json`, claims: data.airdropClaims.length, miners: data.miningAccounts.length, checkins: data.miningCheckins.length };
}

export async function lastBackupAt(ctx: AppContext): Promise<number | null> {
  const { db, t } = ctx.database;
  const [r] = await db.select().from(t.kv).where(eq(t.kv.key, KEY));
  return r ? Number(r.value) : null;
}

export function startBackupTimer(ctx: AppContext): () => void {
  if (!ctx.cfg.HF_TOKEN) return () => undefined;
  const every = ctx.cfg.BACKUP_INTERVAL_HOURS * 3600;
  const tick = async () => {
    try {
      const last = await lastBackupAt(ctx);
      if (last && nowSec() - last < every - 300) return;
      const r = await uploadBackup(ctx);
      ctx.log.info(r, "backup uploaded");
    } catch (e: any) {
      ctx.log.warn({ err: e?.message ?? String(e) }, "backup failed");
    }
  };
  const first = setTimeout(tick, 5 * 60_000);
  const iv = setInterval(tick, 30 * 60_000); // checks every 30 min, uploads once per interval
  first.unref?.();
  iv.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(iv);
  };
}
