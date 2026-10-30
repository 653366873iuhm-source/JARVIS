/** Early bird (+20% for the first N real minters, 30 days, end date), withheld public mining stats, /v1/health/full
 *  ok flags + signer low-balance alert, /v1/config announcements + community links, NFT holdings reconciliation. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";

const active = new Set<string>();
vi.mock("../../src/services/credential.js", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    readCredential: async (_ctx: unknown, wallet: string) => {
      const on = active.has(wallet.toLowerCase());
      return { configured: true, address: "0x171C8cc26FcE4E34e21A883FCfcc85e835C11768", active: on, credit: on ? 1000 : 0, tokenId: on ? 1 : 0, used: on };
    },
  };
});

import { openDatabase, type Database } from "../../src/db/index.js";
import { loadConfig } from "../../src/config.js";
import { buildServer } from "../../src/api/server.js";
import type { AppContext } from "../../src/context.js";
import { MockAgentIdResolver } from "../../src/providers/agentid/index.js";
import { MockXProvider } from "../../src/providers/x/mock.js";
import { computeRate } from "../../src/services/mining.js";
import { clearEarlyBirdCache, earlyBirdEndAt, earlyBirdFromRows } from "../../src/services/earlybird.js";
import { clearHealthCache, fullHealth } from "../../src/services/health.js";
import { parseAnnouncements, safeUrl } from "../../src/services/stats.js";
import { reconcileNftHoldings } from "../../src/services/reconcile.js";
import { CURSOR_KEY, setKv } from "../../src/services/indexer.js";

const HIDDEN = "0x49e6fb3812fdfd67edfe17259f03ccbe59f39bce";
const SIGNER = "0x2b7b523E8DA2007798caFdC133de9bfF2Cf72dD1";
const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const now = () => Math.floor(Date.now() / 1000);
let database: Database;
let app: FastifyInstance;
let ctx: AppContext;
let dbFile: string;
const chain = { head: 1000n, balance: 2_000_000_000_000_000n, owners: new Map<string, string | null>() };

const get = async (url: string) => {
  const r = await app.inject({ method: "GET", url });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};

beforeAll(async () => {
  dbFile = path.join(os.tmpdir(), `agentpad-eb-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  database = await openDatabase(`file:${dbFile}`);
  const pc = {
    getBlockNumber: async () => chain.head,
    getBalance: async () => chain.balance,
    readContract: async (q: any) => {
      if (q.functionName === "ownerOf") {
        const o = chain.owners.get(`${q.address.toLowerCase()}:${q.args[0]}`);
        if (!o) throw new Error("execution reverted: ERC721NonexistentToken 0x7e273289");
        return o;
      }
      throw new Error("unexpected read " + q.functionName);
    },
  };
  ctx = {
    cfg: loadConfig({
      NODE_ENV: "test", ADMIN_TOKEN: "t", MINING_ACTIVATE_SWEEP_MS: "0", EARLYBIRD_SLOTS: "3", MINING_STATS_MIN_PARTICIPANTS: "4",
      PUBLIC_APP_URL: "https://chyai.example", INDEXER_MAX_LAG_BLOCKS: "100", COMMUNITY_TELEGRAM: "javascript:alert(1)",
    }),
    database, resolver: new MockAgentIdResolver(), x: new MockXProvider(), bus: new EventEmitter(), pc,
    signer: { getAddress: async () => SIGNER }, relayer: { getAddress: async () => SIGNER },
    addresses: {}, log: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as AppContext;
  app = await buildServer(ctx);
});
afterAll(async () => {
  await app?.close();
  await database?.close();
  for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true });
});

describe("early bird", () => {
  it("default end date is 2026-11-30 23:59 Asia/Shanghai; boost stacks additively with invites", () => {
    expect(earlyBirdEndAt(loadConfig({ NODE_ENV: "test" }))).toBe(Date.UTC(2026, 10, 30, 15, 59) / 1000);
    expect(earlyBirdEndAt(loadConfig({ NODE_ENV: "test", EARLYBIRD_END_AT: "1790000000" }))).toBe(1790000000);
    const act = { launches: 0, volumeWei: "0", volumeBnb: 0, windowDays: 7 };
    const r = computeRate(ctx.cfg, 1000, act, 2, true);
    expect(r.earlyBirdBoost).toBeCloseTo(0.2);
    expect(r.multiplier).toBeCloseTo(1.3); // 1 + 0.10 invites + 0.20 early bird
    expect(r.rateE8).toBe(13 * 1e8);
    expect(computeRate(ctx.cfg, 0, act, 0, true).earlyBirdBoost).toBe(0); // no credential, no boost
    // hard caps: launch +100%, volume +200%, invites +50%, early bird +20% → ×4.7
    const max = computeRate(ctx.cfg, 1000, { launches: 99, volumeWei: "0", volumeBnb: 999, windowDays: 7 }, 99, true);
    expect(max.multiplier).toBeCloseTo(4.7);
  });

  it("slots go to the first real minters only; hidden wallets never take one; end date and 30-day window apply", () => {
    const t0 = 1_790_000_000;
    const rows = [
      { wallet: A(1), createdAt: t0 },
      { wallet: A(2), createdAt: t0 + 10 },
      { wallet: A(3), createdAt: t0 + 20 },
      { wallet: A(4), createdAt: t0 + 30 },
    ];
    const c = ctx.cfg; // 3 slots
    expect(earlyBirdFromRows(c, rows, A(1), t0 + 100)).toMatchObject({ slot: 1, eligible: true, active: true, boost: 0.2, endsAt: t0 + 30 * 86400 });
    expect(earlyBirdFromRows(c, rows, A(4), t0 + 100)).toMatchObject({ slot: 4, eligible: false, active: false, boost: 0 });
    expect(earlyBirdFromRows(c, rows, A(1), t0 + 31 * 86400)).toMatchObject({ eligible: true, active: false, boost: 0 });
    expect(earlyBirdFromRows(c, rows, HIDDEN, t0)).toMatchObject({ slot: null, eligible: false });
    const late = loadConfig({ NODE_ENV: "test", EARLYBIRD_SLOTS: "3", EARLYBIRD_END_AT: String(t0 + 5) });
    expect(earlyBirdFromRows(late, rows, A(2), t0 + 100).eligible).toBe(false); // minted after the end date
  });

  it("mining API: early birds get +20%, later minters and hidden wallets do not; stats withheld below the threshold", async () => {
    clearEarlyBirdCache();
    const s0 = await get("/v1/mining/stats");
    expect(s0.body).toMatchObject({ statsVisible: false, participants: null, activeMiners: null, totalPoints: null, checkinsToday: null });
    expect(s0.body.earlyBird).toMatchObject({ slots: 3, minted: 0, remaining: 3, boost: 0.2, days: 30, open: true });

    active.add(HIDDEN);
    const h = await get(`/v1/mining/${HIDDEN}`);
    expect(h.body.boosts.earlyBird).toMatchObject({ slot: null, active: false });
    expect(h.body.multiplier).toBeCloseTo(1);
    for (let i = 1; i <= 4; i++) {
      active.add(A(0x100 + i));
      const m = await get(`/v1/mining/${A(0x100 + i)}`);
      if (i <= 3) {
        expect(m.body.boosts.earlyBird).toMatchObject({ slot: i, active: true, boost: 0.2 });
        expect(m.body.ratePerDay).toBeCloseTo(12);
      } else {
        expect(m.body.boosts.earlyBird).toMatchObject({ slot: 4, active: false, boost: 0 });
        expect(m.body.ratePerDay).toBeCloseTo(10);
      }
    }
    clearEarlyBirdCache();
    const s1 = await get("/v1/mining/stats");
    expect(s1.body.earlyBird).toMatchObject({ minted: 4, remaining: 0, open: false }); // hidden wallet not counted
    expect(s1.body).toMatchObject({ statsVisible: true, participants: 4, activeMiners: 4 });
    expect(s1.body.rules).toMatchObject({ earlyBirdBoost: 0.2, earlyBirdSlots: 3, earlyBirdDays: 30 });
    expect(s1.body.rules.maxMultiplier).toBeCloseTo(4.7);
  });

  it("accrual splits exactly at the end of the boost", async () => {
    const { db, t } = ctx.database;
    const w = A(0x101); // slot 1
    const created = now() - 31 * 86400;
    // boost ended 1 day ago; last settle 2 days ago at the boosted rate 12/day
    await db.update(t.miningAccounts).set({ createdAt: created, lastAccrualAt: now() - 2 * 86400, pointsE8: 0, rateE8PerDay: 12 * 1e8 }).where((await import("drizzle-orm")).eq(t.miningAccounts.wallet, w));
    clearEarlyBirdCache();
    const m = await get(`/v1/mining/${w}`);
    // ~1 day at 12 + ~1 day at 10 = ~22 (not 24)
    expect(Number(m.body.points)).toBeGreaterThan(21.9);
    expect(Number(m.body.points)).toBeLessThan(22.1);
    expect(m.body.boosts.earlyBird).toMatchObject({ eligible: true, active: false });
    expect(m.body.ratePerDay).toBeCloseTo(10);
  });
});

describe("monitoring", () => {
  it("/v1/health exposes signerLow + indexer lag; /v1/health/full has ok flags; strict=1 → 503 on failure", async () => {
    await setKv(ctx, CURSOR_KEY, "990");
    const okFetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    clearHealthCache();
    const good = await fullHealth(ctx, { fetcher: okFetch });
    expect(good).toMatchObject({ ok: true, signerLow: false, indexerLagging: false, siteDown: false, alerts: [] });
    expect(good.checks.indexer).toMatchObject({ lastBlock: 990, head: 1000, lag: 10, ok: true });
    expect(good.checks.signer).toMatchObject({ address: SIGNER, balanceBnb: "0.002", thresholdBnb: 0.0008, low: false });

    chain.balance = 700_000_000_000_000n; // 0.0007 BNB < 0.0008
    chain.head = 2000n; // lag 1010 > 100
    clearHealthCache();
    const bad = await fullHealth(ctx, { fetcher: (async () => ({ ok: false, status: 502 })) as unknown as typeof fetch });
    expect(bad.ok).toBe(false);
    expect(bad.signerLow).toBe(true);
    expect(bad.alerts).toEqual(expect.arrayContaining(["signer_low_0.0007", "indexer_lag_1010", "site_down_502"]));

    const h = await get("/v1/health");
    expect(h.body).toMatchObject({ ok: true, signerLow: true, signer: { low: true }, indexer: { lag: 1010, ok: false }, autoSubmitAdminTxs: true });
    const strict = await app.inject({ method: "GET", url: "/v1/health/full?strict=1" });
    expect(strict.statusCode).toBe(503);
    const loose = await app.inject({ method: "GET", url: "/v1/health/full" });
    expect(loose.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/admin/status" })).statusCode).toBe(401);
    const adm = await app.inject({ method: "GET", url: "/v1/admin/status", headers: { authorization: "Bearer t" } });
    expect(JSON.parse(adm.body)).toMatchObject({ signerLow: true, earlyBird: { slots: 3 } });
    chain.balance = 2_000_000_000_000_000n;
    chain.head = 1000n;
    clearHealthCache();
  });

  it("/v1/config: default announcement (zh+en, links to the CHYAI sale) and community links (unset/unsafe hidden)", async () => {
    const c = await get("/v1/config");
    expect(c.body.announcements).toEqual([
      { id: "chyai-sale-2026-10", zh: "平台币 CHYAI 打新即将开放（越早价格越低）；老矿工和凭证持有者每个钱包额外空投 10,000 CHYAI", en: "The CHYAI platform-token sale opens soon (the earlier, the lower the price); past miners and credential holders get an extra 10,000 CHYAI each", href: "/sale", level: "info" },
    ]);
    expect(c.body.community).toEqual({ x: "https://x.com/ChyAI_Official", telegram: "", discord: "" });
    expect(parseAnnouncements("not json")).toEqual([]);
    expect(parseAnnouncements("[]")).toEqual([]);
    expect(parseAnnouncements('[{"id":"a","zh":"中","href":"javascript:x"}]')).toEqual([{ id: "a", zh: "中", en: "中", href: null, level: "info" }]);
    expect(safeUrl("http://t.me/x")).toBe("");
    expect(safeUrl("https://t.me/chyai")).toBe("https://t.me/chyai");
  });

  it("reconciles indexed NFT holdings against ownerOf (retired token removed, moved token updated)", async () => {
    const { db, t } = ctx.database;
    const P = A(0xbb41);
    await db.insert(t.nftTokens).values([
      { project: P, tokenId: 1, owner: HIDDEN },
      { project: P, tokenId: 2, owner: HIDDEN },
      { project: P, tokenId: 3, owner: HIDDEN },
    ]);
    chain.owners.set(`${P}:2`, HIDDEN);
    chain.owners.set(`${P}:3`, A(7));
    const dry = await reconcileNftHoldings(ctx, { project: P, dryRun: true });
    expect(dry).toMatchObject({ checked: 3, changed: 2, dryRun: true });
    const r = await reconcileNftHoldings(ctx, { project: P });
    expect(r.changes).toEqual([
      { project: P, tokenId: 1, from: HIDDEN, to: null },
      { project: P, tokenId: 3, from: HIDDEN, to: A(7) },
    ]);
    const left = await db.select().from(t.nftTokens);
    expect(left.map((x) => [x.tokenId, x.owner])).toEqual([
      [2, HIDDEN],
      [3, A(7)],
    ]);
  });
});
