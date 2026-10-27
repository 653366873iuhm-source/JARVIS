/**
 * NFT metadata + rarity indexing.
 *
 * Metadata scheme (written by the SDK's `uploadLaunchAssets`, sdk/src/metadata.ts):
 *   <baseURI>collection.json  { name, symbol, story, description, image, traits: TraitSpec[], traitDerivation }
 *   <baseURI><tokenId>        per-token ERC-721 JSON (tokenURI = baseURI + tokenId), image = cover
 * Traits are NOT in the per-token files: they are derived from the on-chain VRF seed
 *   seed = BondingNFT.traitSeed(tokenId)  (0 = VRF pending)
 *   for trait i: r = uint256(keccak256(abi.encode(seed, i))) % sum(weights_i); first value with cumulative weight > r
 * so the backend reproduces them exactly (same code as the SDK's deriveTraits).
 *
 * Collections that do not follow the scheme (no `traits` in collection.json) fall back to the per-token JSON
 * (`image` + an attribute named "Rarity"), and when that is missing too, to the default rarity table.
 *
 * Rarity (FE: common | rare | epic | legendary) = the "Rarity" trait value when present
 * (Common/Uncommon -> common, Rare -> rare, Epic -> epic, Legendary/Mythic -> legendary); otherwise from the joint
 * probability of the token's trait values (<= 2% legendary, <= 10% epic, <= 30% rare, else common).
 */
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { encodeAbiParameters, keccak256 } from "viem";
import type { AppContext } from "../context.js";
import { BondingNFTAbi } from "../chain/abi.js";
import { clockNow } from "./indexer.js";

export interface TraitValue { value: string; weight: number; image?: string }
export interface TraitSpec { trait_type: string; values: TraitValue[] }
export type Rarity = "common" | "rare" | "epic" | "legendary";

/** Same default table as sdk/src/metadata.ts DEFAULT_TRAITS. */
export const DEFAULT_TRAITS: TraitSpec[] = [
  { trait_type: "Rarity", values: [
    { value: "Common", weight: 6000 }, { value: "Uncommon", weight: 2500 }, { value: "Rare", weight: 1100 },
    { value: "Epic", weight: 350 }, { value: "Legendary", weight: 50 },
  ] },
];

export function deriveTraits(seed: bigint, traits: TraitSpec[] = DEFAULT_TRAITS): { trait_type: string; value: string; image?: string; p: number }[] {
  if (seed === 0n) return [];
  return traits.map((t, i) => {
    const total = t.values.reduce((a, v) => a + BigInt(Math.floor(v.weight)), 0n);
    const r = BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [seed, BigInt(i)]))) % total;
    let acc = 0n;
    let pick = t.values[t.values.length - 1];
    for (const v of t.values) {
      acc += BigInt(Math.floor(v.weight));
      if (r < acc) {
        pick = v;
        break;
      }
    }
    return { trait_type: t.trait_type, value: pick.value, ...(pick.image ? { image: pick.image } : {}), p: Math.floor(pick.weight) / Number(total) };
  });
}

const RARITY_WORDS: Record<string, Rarity> = {
  common: "common", uncommon: "common", rare: "rare", epic: "epic", legendary: "legendary", mythic: "legendary",
  普通: "common", 稀有: "rare", 史诗: "epic", 传说: "legendary",
};

export function rarityFromTraits(traits: { trait_type: string; value: string; p?: number }[]): Rarity | null {
  if (!traits.length) return null;
  const named = traits.find((t) => t.trait_type.toLowerCase() === "rarity" || t.trait_type === "稀有度");
  if (named) {
    const r = RARITY_WORDS[String(named.value).trim().toLowerCase()];
    if (r) return r;
  }
  if (traits.some((t) => t.p === undefined)) return "common";
  const joint = traits.reduce((a, t) => a * (t.p as number), 1);
  return joint <= 0.02 ? "legendary" : joint <= 0.1 ? "epic" : joint <= 0.3 ? "rare" : "common";
}

/** ipfs://cid/path -> <gateway>cid/path; ar:// -> arweave.net; http(s) unchanged. */
export function gatewayUrl(uri: string | null | undefined, gateway: string): string | null {
  if (!uri) return null;
  const g = gateway.endsWith("/") ? gateway : `${gateway}/`;
  if (uri.startsWith("ipfs://")) return g + uri.slice(7).replace(/^ipfs\//, "");
  if (uri.startsWith("ar://")) return `https://arweave.net/${uri.slice(5)}`;
  if (/^https?:\/\//.test(uri) || uri.startsWith("data:")) return uri;
  return null;
}

function isTraitSpecs(v: unknown): v is TraitSpec[] {
  return Array.isArray(v) && v.length > 0 && v.every((t: any) => t && typeof t.trait_type === "string" && Array.isArray(t.values) && t.values.length > 0 && t.values.every((x: any) => typeof x?.value === "string" && Number(x?.weight) > 0));
}

export type FetchJson = (url: string) => Promise<unknown>;

export function makeFetchJson(timeoutMs: number, maxBytes = 512 * 1024): FetchJson {
  return async (url: string) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    const text = await r.text();
    if (text.length > maxBytes) throw new Error(`metadata too large (${text.length} bytes)`);
    return JSON.parse(text);
  };
}

let fetchOverride: FetchJson | null = null;
/** Tests: replace the HTTP fetcher (null restores the default). */
export function setMetadataFetcher(f: FetchJson | null) {
  fetchOverride = f;
}

const MAX_META_ATTEMPTS = 8;
const SEED_BATCH = 200;
const SEED_CONCURRENCY = 16;

/** Fetch collection.json for projects that have none yet (exponential backoff on failure). */
export async function syncCollections(ctx: AppContext): Promise<number> {
  const { db, t } = ctx.database;
  const fetchJson = fetchOverride ?? makeFetchJson(ctx.cfg.METADATA_FETCH_TIMEOUT_MS);
  const now = await clockNow(ctx);
  const rows = await db.select().from(t.projects).where(or(isNull(t.projects.metaStatus), eq(t.projects.metaStatus, "error")));
  let done = 0;
  for (const p of rows) {
    if (p.metaStatus === "error") {
      if (p.metaAttempts >= MAX_META_ATTEMPTS) continue;
      const wait = Math.min(60 * 2 ** p.metaAttempts, 6 * 3600);
      if ((p.metaCheckedAt ?? 0) + wait > now) continue;
    }
    const url = gatewayUrl(`${p.baseUri}collection.json`, ctx.cfg.IPFS_GATEWAY);
    let set: Record<string, unknown>;
    try {
      if (!url) throw new Error(`unsupported baseURI scheme: ${p.baseUri}`);
      const j = (await fetchJson(url)) as Record<string, unknown>;
      const traits = isTraitSpecs(j?.traits) ? j.traits : null;
      const story = typeof j?.story === "string" ? j.story : typeof j?.description === "string" ? j.description : null;
      const image = typeof j?.image === "string" ? gatewayUrl(j.image, ctx.cfg.IPFS_GATEWAY) : null;
      set = { story: story?.slice(0, 4000) ?? null, image, traits: traits ? JSON.stringify(traits) : null, metaStatus: "ok", metaCheckedAt: now };
    } catch (e) {
      ctx.log.debug({ project: p.address, err: String(e) }, "collection.json fetch failed");
      set = { metaStatus: "error", metaAttempts: p.metaAttempts + 1, metaCheckedAt: now };
    }
    await db.update(t.projects).set(set).where(eq(t.projects.address, p.address));
    done++;
  }
  return done;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/**
 * Read trait seeds for tokens that have none yet and derive traits / rarity / image. Returns tokens processed.
 * Projects whose collection.json is still pending are skipped (their trait table is unknown) unless the fetch has
 * definitively failed, in which case the per-token JSON / default table is used.
 */
export async function syncTokenTraits(ctx: AppContext, limit = SEED_BATCH, opts: { recheckPending?: boolean } = { recheckPending: true }): Promise<number> {
  const { db, t } = ctx.database;
  const fetchJson = fetchOverride ?? makeFetchJson(ctx.cfg.METADATA_FETCH_TIMEOUT_MS);
  const projects = new Map((await db.select().from(t.projects)).map((p) => [p.address, p] as const));
  // never-read tokens first (newest first: that is what the UI lists), then a re-check of VRF-pending ones
  const fresh = await db
    .select({ project: t.nftTokens.project, tokenId: t.nftTokens.tokenId })
    .from(t.nftTokens)
    .where(isNull(t.nftTokens.seed))
    .orderBy(desc(t.nftTokens.tokenId))
    .limit(limit * 4);
  const pendingVrf = opts.recheckPending
    ? await db.select({ project: t.nftTokens.project, tokenId: t.nftTokens.tokenId }).from(t.nftTokens).where(eq(t.nftTokens.seed, "0")).limit(limit)
    : [];
  const isReady = (r: { project: string }) => {
    const p = projects.get(r.project);
    return !!p && (p.metaStatus === "ok" || (p.metaStatus === "error" && p.metaAttempts >= Math.min(3, MAX_META_ATTEMPTS)));
  };
  const ready = [...fresh.filter(isReady).slice(0, limit), ...pendingVrf.filter(isReady)];
  let updated = 0;
  if (!ready.length) return 0;
  await pool(ready, SEED_CONCURRENCY, async (r) => {
    const p = projects.get(r.project)!;
    let seed: bigint;
    try {
      seed = (await ctx.pc.readContract({ address: p.address as `0x${string}`, abi: BondingNFTAbi, functionName: "traitSeed", args: [BigInt(r.tokenId)] })) as bigint;
    } catch (e) {
      ctx.log.debug({ project: p.address, tokenId: r.tokenId, err: String(e) }, "traitSeed read failed");
      return;
    }
    if (seed === 0n) {
      await db.update(t.nftTokens).set({ seed: "0" }).where(and(eq(t.nftTokens.project, p.address), eq(t.nftTokens.tokenId, r.tokenId)));
      updated++; // processed (VRF pending: re-checked on the next tick)
      return;
    }
    let traits: { trait_type: string; value: string; image?: string; p?: number }[];
    let image: string | null = p.image ?? null;
    const spec = p.traits ? (JSON.parse(p.traits) as TraitSpec[]) : null;
    if (spec) {
      traits = deriveTraits(seed, spec);
    } else {
      // non-scheme collection: try the per-token JSON (tokenURI = baseURI + tokenId)
      traits = [];
      try {
        const url = gatewayUrl(`${p.baseUri}${r.tokenId}`, ctx.cfg.IPFS_GATEWAY);
        const j = url ? ((await fetchJson(url)) as any) : null;
        if (typeof j?.image === "string") image = gatewayUrl(j.image, ctx.cfg.IPFS_GATEWAY) ?? image;
        if (Array.isArray(j?.attributes)) {
          traits = j.attributes
            .filter((a: any) => a && typeof a.trait_type === "string" && (typeof a.value === "string" || typeof a.value === "number"))
            .map((a: any) => ({ trait_type: a.trait_type, value: String(a.value) }));
        }
      } catch {
        /* no per-token file */
      }
      if (!traits.some((x) => x.trait_type.toLowerCase() === "rarity" && RARITY_WORDS[x.value.toLowerCase()])) traits = deriveTraits(seed, DEFAULT_TRAITS);
    }
    const layer = traits.find((x) => x.image)?.image;
    if (layer) image = gatewayUrl(layer, ctx.cfg.IPFS_GATEWAY) ?? image;
    const rarity = rarityFromTraits(traits);
    await db
      .update(t.nftTokens)
      .set({ seed: seed.toString(), traits: JSON.stringify(traits.map(({ trait_type, value }) => ({ trait_type, value }))), rarity, image })
      .where(and(eq(t.nftTokens.project, p.address), eq(t.nftTokens.tokenId, r.tokenId)));
    updated++;
  });
  return updated;
}

const MAX_BATCHES_PER_TICK = 10;

export async function metadataTick(ctx: AppContext) {
  const collections = await syncCollections(ctx);
  let tokens = await syncTokenTraits(ctx, SEED_BATCH, { recheckPending: true });
  // drain the backlog (e.g. a 10,000-NFT sell-out) in up to 10 batches per tick
  for (let i = 1; i < MAX_BATCHES_PER_TICK; i++) {
    const n = await syncTokenTraits(ctx, SEED_BATCH, { recheckPending: false });
    if (n === 0) break;
    tokens += n;
  }
  return { collections, tokens };
}
