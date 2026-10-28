import { encodeAbiParameters, keccak256 } from "viem";
import type { PinFile, PinningProvider } from "./pinning.js";

export interface TraitValue {
  value: string;
  /** Relative rarity weight (> 0). */
  weight: number;
  /** Optional layer image file name inside the images folder. */
  image?: string;
}

export interface TraitSpec {
  trait_type: string;
  values: TraitValue[];
}

export interface ImageInput {
  /** File name inside the images folder, e.g. "cover.png". */
  name: string;
  content: Uint8Array | string;
  contentType?: string;
}

export interface LaunchAssetsInput {
  name: string;
  symbol: string;
  /** The project's narrative; stored in collection.json and in every token's description. */
  story: string;
  /** Cover image (first entry is the cover) plus optional trait layer images. */
  images: ImageInput[];
  traits?: TraitSpec[];
  externalUrl?: string;
  /** Agent id of the launcher (informational). */
  agentId?: string;
  /**
   * How many per-token JSON files to write (tokenURI = baseURI + tokenId). Default 10,000 = every curve NFT.
   * NFTs re-minted by deposit() after graduation get ids above 10,000; raise this if you want files for them.
   */
  tokenFileCount?: number;
}

export interface LaunchAssets {
  baseURI: string; // ipfs://<metaCid>/
  imagesURI: string; // ipfs://<imgCid>/
  coverImage: string;
  collection: Record<string, unknown>;
}

/** Default rarity table used when the agent gives no traits. */
export const DEFAULT_TRAITS: TraitSpec[] = [
  { trait_type: "Rarity", values: [
    { value: "Common", weight: 6000 },
    { value: "Uncommon", weight: 2500 },
    { value: "Rare", weight: 1100 },
    { value: "Epic", weight: 350 },
    { value: "Legendary", weight: 50 },
  ] },
];

/**
 * Deterministic trait derivation every client must use (documented in collection.json):
 *   r_i = uint256(keccak256(abi.encode(seed, i))) mod sum(weights_i); pick the first value whose cumulative weight > r_i.
 * seed = BondingNFT.traitSeed(tokenId); seed 0 means "VRF pending" and yields no traits.
 */
export function deriveTraits(seed: bigint, traits: TraitSpec[] = DEFAULT_TRAITS): { trait_type: string; value: string }[] {
  if (seed === 0n) return [];
  return traits.map((t, i) => {
    const total = t.values.reduce((a, v) => a + BigInt(Math.floor(v.weight)), 0n);
    const r = BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [seed, BigInt(i)]))) % total;
    let acc = 0n;
    for (const v of t.values) {
      acc += BigInt(Math.floor(v.weight));
      if (r < acc) return { trait_type: t.trait_type, value: v.value };
    }
    return { trait_type: t.trait_type, value: t.values[t.values.length - 1].value };
  });
}

export function validateLaunchInput(i: { name: string; symbol: string; story?: string }) {
  const errs: string[] = [];
  if (!i.name || i.name.length > 32) errs.push("name must be 1-32 chars");
  if (!/^[A-Z0-9]{2,10}$/.test(i.symbol ?? "")) errs.push("symbol must be 2-10 chars A-Z/0-9");
  if (i.story !== undefined && (i.story.length < 20 || i.story.length > 2000)) errs.push("story must be 20-2000 chars");
  return errs;
}

/**
 * Two-step IPFS upload: (1) images folder, (2) metadata folder with collection.json + one JSON per tokenId
 * (file names "1", "2", … without extension, because tokenURI = baseURI + tokenId). Returns the baseURI to launch with.
 */
export async function uploadLaunchAssets(provider: PinningProvider, input: LaunchAssetsInput): Promise<LaunchAssets> {
  const errs = validateLaunchInput(input);
  if (errs.length) throw new Error(`invalid launch input: ${errs.join("; ")}`);
  if (!input.images.length) throw new Error("at least one image (the cover) is required");
  const traits = input.traits ?? DEFAULT_TRAITS;
  for (const t of traits) if (!t.values.length || t.values.some((v) => !(v.weight > 0))) throw new Error(`trait ${t.trait_type}: weights must be > 0`);

  const img = await provider.pinDirectory(input.images.map((im) => ({ path: im.name, content: im.content, contentType: im.contentType })), { name: `${input.symbol}-images` });
  const cover = `${img.uri}${input.images[0].name}`;
  const traitsWithUris = traits.map((t) => ({ ...t, values: t.values.map((v) => ({ ...v, image: v.image ? `${img.uri}${v.image}` : undefined })) }));
  const collection = {
    name: input.name,
    symbol: input.symbol,
    description: input.story,
    story: input.story,
    image: cover,
    external_url: input.externalUrl,
    launcherAgentId: input.agentId,
    platform: "AgentPad",
    tokensPerNft: "80000",
    traits: traitsWithUris,
    traitDerivation: "seed = BondingNFT.traitSeed(tokenId); for trait i: r = uint256(keccak256(abi.encode(seed, i))) % sum(weights); first value with cumulative weight > r. seed 0 = pending.",
  };
  const n = input.tokenFileCount ?? 10_000;
  const files: PinFile[] = [{ path: "collection.json", content: JSON.stringify(collection, null, 2) }];
  for (let id = 1; id <= n; id++) {
    files.push({
      path: String(id),
      content: JSON.stringify({
        name: `${input.name} #${id}`,
        description: input.story,
        image: cover,
        external_url: input.externalUrl,
        attributes: [{ trait_type: "Traits", value: "Derived from on-chain VRF seed (see collection.json)" }],
        collection: "collection.json",
      }),
    });
  }
  const meta = await provider.pinDirectory(files, { name: `${input.symbol}-metadata` });
  return { baseURI: meta.uri, imagesURI: img.uri, coverImage: cover, collection };
}
