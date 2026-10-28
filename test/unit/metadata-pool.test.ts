/** NFT metadata/rarity indexing and PancakeSwap pool pricing (graduated projects), on a seeded SQLite DB. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { openDatabase, type Database } from "../../src/db/index.js";
import { loadConfig } from "../../src/config.js";
import { buildServer } from "../../src/api/server.js";
import type { AppContext } from "../../src/context.js";
import { TOKENS_PER_NFT, VIRTUAL_BNB0, VIRTUAL_TOKEN0, nftPrice } from "../../src/lib/curve.js";
import { DEFAULT_TRAITS, deriveTraits, gatewayUrl, rarityFromTraits, setMetadataFetcher, syncCollections, syncTokenTraits } from "../../src/services/metadata.js";
import { poolNftPrice } from "../../src/services/indexer.js";
import { deriveTraits as sdkDeriveTraits } from "../../../sdk/src/metadata.js";

const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const L = A(0xb1);
const T = A(0xb2);
const P1 = A(0xa1); // trading, scheme collection with custom traits
const P2 = A(0xa2); // graduated, pool priced
const P3 = A(0xa3); // collection fetch fails -> per-token JSON fallback
const PAIR = A(0xe2);
const E18 = 10n ** 18n;
let database: Database;
let app: FastifyInstance;
let ctx: AppContext;
let dbFile: string;
let now: number;
const get = async (url: string) => {
  const r = await app.inject({ method: "GET", url });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};
const SEED = (id: number) => (id % 5 === 0 ? 0n : BigInt(id) * 0x1234567890abcdefn + 99n); // id 5,10 = VRF pending

const TRAITS = [
  { trait_type: "Background", values: [{ value: "Gold", weight: 1, image: "ipfs://img/gold.png" }, { value: "Grey", weight: 99 }] },
  { trait_type: "Rarity", values: [{ value: "Common", weight: 70 }, { value: "Rare", weight: 20 }, { value: "Epic", weight: 8 }, { value: "Legendary", weight: 2 }] },
];
const RB = 19n * E18; // pool: 19 BNB / 200M tokens
const RT = 200_000_000n * E18;

beforeAll(async () => {
  dbFile = path.join(os.tmpdir(), `agentpad-meta-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  database = await openDatabase(`file:${dbFile}`);
  const { db, t } = database;
  const pc = { readContract: async ({ functionName, args }: any) => (functionName === "traitSeed" ? SEED(Number(args[0])) : 0n) };
  ctx = { cfg: loadConfig({ NODE_ENV: "test", IPFS_GATEWAY: "https://gw.test/ipfs/" }), database, pc, bus: new EventEmitter(), log: { info() {}, warn() {}, error() {}, debug() {} } } as unknown as AppContext;
  now = Math.floor(Date.now() / 1000);
  const PRICE = nftPrice(VIRTUAL_BNB0, VIRTUAL_TOKEN0).toString();
  const proj = (address: string, symbol: string, phase: number, idx: number, extra: Record<string, unknown> = {}) => ({
    address, token: A(0xc0 + idx), launcher: L, agentIdHash: "0x", name: `${symbol} Coin`, symbol, baseUri: `ipfs://cid${symbol}/`, idx, tag: `#AP_${symbol}`,
    createdAt: now - 5000 + idx, createdBlock: 1 + idx, phase, virtualBnb: VIRTUAL_BNB0.toString(), virtualToken: VIRTUAL_TOKEN0.toString(), priceWei: PRICE, sold: phase === 2 ? 10000 : 100, ...extra,
  });
  await db.insert(t.projects).values([
    proj(P1, "ONE", 0, 0),
    proj(P2, "TWO", 2, 1, { pair: PAIR, graduatedAt: now - 4000, poolTokenIs0: false, poolReserveBnb: RB.toString(), poolReserveToken: RT.toString(), poolUpdatedAt: now - 60, priceWei: poolNftPrice(RB, RT).toString() }),
    proj(P3, "THREE", 0, 2),
  ]);
  await db.insert(t.nftTokens).values([
    ...Array.from({ length: 12 }, (_, i) => ({ project: P1, tokenId: i + 1, owner: i < 6 ? T : L })),
    ...[1, 2].map((i) => ({ project: P3, tokenId: i, owner: T })),
  ]);
  // P2: curve trade before graduation, then two pool swaps (buy then sell)
  await db.insert(t.trades).values({ id: "0x1:0", project: P2, trader: T, side: "buy", count: 10, bnbWei: (E18 / 10n).toString(), feeWei: "0", priceWei: PRICE, firstTokenId: 1, blockNumber: 1, logIndex: 0, txHash: "0x" + "1".repeat(64), ts: now - 5000 });
  const sw = (i: number, side: string, bnb: bigint, tok: bigint, price: bigint, ts: number) => ({
    id: `0x${i}:9`, project: P2, pair: PAIR, trader: T, side, bnbWei: bnb.toString(), tokenWei: tok.toString(), priceWei: price.toString(), blockNumber: 100 + i, logIndex: 9, txHash: `0x${String(i).padStart(64, "0")}`, ts,
  });
  await db.insert(t.poolSwaps).values([
    sw(1, "buy", E18, 160_000n * E18 * 10n, poolNftPrice(RB, RT) + 1000n, now - 200),
    sw(2, "sell", E18 / 2n, 80_000n * E18 * 3n, poolNftPrice(RB, RT), now - 100),
  ]);
  setMetadataFetcher(async (url: string) => {
    if (url === "https://gw.test/ipfs/cidONE/collection.json") return { name: "ONE", story: "A story about ONE that is long enough.", image: "ipfs://img/cover.png", traits: TRAITS };
    if (url === "https://gw.test/ipfs/cidTWO/collection.json") return { name: "TWO", description: "two desc", image: "https://cdn.test/two.png" }; // no traits -> default table
    if (url.startsWith("https://gw.test/ipfs/cidTHREE/") && !url.endsWith("collection.json")) return { image: "ipfs://three/tok.png", attributes: [{ trait_type: "Rarity", value: "Epic" }] };
    throw new Error("404");
  });
  app = await buildServer(ctx);
});

afterAll(async () => {
  setMetadataFetcher(null);
  await app?.close();
  await database?.close();
  fs.rmSync(dbFile, { force: true });
});

describe("trait derivation", () => {
  it("matches the SDK's deriveTraits exactly and maps rarity", () => {
    for (let i = 1n; i < 200n; i++) {
      const seed = i * 0xdeadbeefn;
      expect(deriveTraits(seed, TRAITS as any).map(({ trait_type, value }) => ({ trait_type, value }))).toEqual(sdkDeriveTraits(seed, TRAITS as any));
      expect(deriveTraits(seed).map(({ trait_type, value }) => ({ trait_type, value }))).toEqual(sdkDeriveTraits(seed));
    }
    expect(deriveTraits(0n)).toEqual([]);
    expect(rarityFromTraits([{ trait_type: "Rarity", value: "Uncommon" }])).toBe("common");
    expect(rarityFromTraits([{ trait_type: "Rarity", value: "Legendary" }])).toBe("legendary");
    expect(rarityFromTraits([{ trait_type: "Hat", value: "x", p: 0.1 }, { trait_type: "Eyes", value: "y", p: 0.1 }])).toBe("legendary"); // joint 1%
    expect(rarityFromTraits([{ trait_type: "Hat", value: "x", p: 0.5 }])).toBe("common");
    expect(rarityFromTraits([])).toBeNull();
    expect(gatewayUrl("ipfs://ipfs/abc/1.png", "https://g/ipfs")).toBe("https://g/ipfs/abc/1.png");
    // the default table yields every class over enough seeds
    const seen = new Set(Array.from({ length: 3000 }, (_, i) => rarityFromTraits(deriveTraits(BigInt(i + 1) * 7919n, DEFAULT_TRAITS))));
    expect([...seen].sort()).toEqual(["common", "epic", "legendary", "rare"]);
  });
});

describe("metadata indexing", () => {
  it("fetches collection.json (story/image/traits) and derives per-token rarity + image from the VRF seed", async () => {
    expect((await get(`/v1/projects/${P1}/nfts`)).body.every((n: any) => n.rarity === null)).toBe(true);
    await syncCollections(ctx);
    // P3's collection failed: retried with backoff; force attempts past the fallback threshold
    const { db, t } = database;
    const { eq } = await import("drizzle-orm");
    await db.update(t.projects).set({ metaAttempts: 3, metaCheckedAt: 0 }).where(eq(t.projects.address, P3));
    await syncTokenTraits(ctx);
    const p1 = (await get(`/v1/projects/${P1}`)).body;
    expect(p1.story).toBe("A story about ONE that is long enough.");
    expect(p1.image).toBe("https://gw.test/ipfs/img/cover.png");
    expect((await get(`/v1/projects/${P2}`)).body).toMatchObject({ story: "two desc", image: "https://cdn.test/two.png" });
    const nfts = (await get(`/v1/projects/${P1}/nfts`)).body;
    expect(nfts.length).toBe(12);
    for (const n of nfts) {
      const seed = SEED(n.tokenId);
      if (seed === 0n) {
        expect(n.rarity).toBeNull(); // VRF pending
        expect(n.image).toBe("https://gw.test/ipfs/img/cover.png");
        continue;
      }
      const tr = deriveTraits(seed, TRAITS as any);
      expect(n.rarity).toBe(rarityFromTraits(tr));
      expect(["common", "rare", "epic", "legendary"]).toContain(n.rarity);
      expect(n.image).toBe(tr[0].value === "Gold" ? "https://gw.test/ipfs/img/gold.png" : "https://gw.test/ipfs/img/cover.png");
      expect(n.traits).toEqual(tr.map(({ trait_type, value }) => ({ trait_type, value })));
    }
    const p3 = (await get(`/v1/projects/${P3}/nfts`)).body;
    expect(p3.map((n: any) => [n.rarity, n.image])).toEqual([["epic", "https://gw.test/ipfs/three/tok.png"], ["epic", "https://gw.test/ipfs/three/tok.png"]]);
    // holders carry per-rarity counts
    const holders = (await get(`/v1/projects/${P1}/holders`)).body;
    const th = holders.find((h: any) => h.wallet === T);
    const sum = Object.values(th.rarities as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(sum).toBe(nfts.filter((n: any) => n.owner === T && n.rarity).length);
  });
});

describe("graduated projects: PancakeSwap pool price", () => {
  it("price / mcap from pair reserves; candles + ticker + 24h volume include pool swaps; hot includes graduated", async () => {
    const p = (await get(`/v1/projects/${P2}`)).body;
    expect(p.phase).toBe("graduated");
    expect(p.priceSource).toBe("pool");
    expect(p.spotPriceWei).toBe(((RB * E18) / RT).toString());
    expect(p.marketCapBnb).toBe(((RB * 1_000_000_000n * E18) / RT).toString());
    expect(p.nftPriceWei).toBe(((RB * TOKENS_PER_NFT) / RT).toString());
    expect(BigInt(p.volumeBnb24h)).toBe(E18 + E18 / 2n + E18 / 10n); // 2 pool swaps + the curve trade
    expect(p.trades24h).toBe(3);
    const tick = (await get("/v1/ticker")).body;
    expect(tick[0]).toMatchObject({ project: P2, venue: "pool", side: "burn", count: 3, bnb: (E18 / 2n).toString(), fee: "0", symbol: "TWO" });
    expect(tick[1]).toMatchObject({ venue: "pool", side: "mint", count: 20 });
    const trades = (await get(`/v1/projects/${P2}/trades`)).body;
    expect(trades.map((x: any) => x.venue)).toEqual(["pool", "pool", "curve"]);
    const c = (await get(`/v1/projects/${P2}/candles?tf=1d`)).body;
    expect(c.at(-1).c).toBeCloseTo(Number(poolNftPrice(RB, RT)) / 1e18, 12);
    const hot = (await get("/v1/projects?filter=hot")).body;
    expect(hot.items.map((x: any) => x.address)).toEqual([P2, P1, P3].filter((a) => hot.items.some((x: any) => x.address === a)));
    expect(hot.items.length).toBe(3); // FE contract: hot = all projects
    expect(hot.items[0].address).toBe(P2); // highest 24h volume first
  });
});
