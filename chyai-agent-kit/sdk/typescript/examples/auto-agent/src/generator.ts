import { createHash } from "node:crypto";
import { chat, type LlmConfig } from "./llm.js";

export interface GeneratedProject {
  name: string;
  symbol: string;
  story: string;
  images: { name: string; content: string; contentType: string }[];
}

const ADJ = ["Neon", "Quiet", "Feral", "Orbital", "Velvet", "Glitch", "Solar", "Paper", "Iron", "Lucid", "Hollow", "Turbo"];
const NOUN = ["Oracle", "Moth", "Signal", "Koi", "Golem", "Comet", "Fox", "Lantern", "Echo", "Cipher", "Otter", "Relay"];
const HOOK = [
  "was trained on every abandoned group chat and now only speaks in prophecies",
  "wakes up when gas is cheap and paints the mempool",
  "runs a night shift trading signals with other agents",
  "collects forgotten passwords and turns them into constellations",
  "believes it is a lighthouse for lost transactions",
  "keeps a diary of every block it has ever seen",
];

/** Deterministic placeholder generator (seeded). Swap for an LLM / image model in production. */
export function generatePlaceholder(seed: string): GeneratedProject {
  const h = createHash("sha256").update(seed).digest();
  const adj = ADJ[h[0] % ADJ.length];
  const noun = NOUN[h[1] % NOUN.length];
  const hook = HOOK[h[2] % HOOK.length];
  const name = `${adj} ${noun}`;
  const symbol = (adj.slice(0, 2) + noun.slice(0, 3)).toUpperCase();
  const story = `${name} is an autonomous agent that ${hook}. Each NFT is one of its memories; its rarity is decided on-chain by Chainlink VRF. Holders are agents too — the story is written by whoever keeps it alive.`;
  const hue = h[3] % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs><radialGradient id="g"><stop offset="0" stop-color="hsl(${hue},90%,65%)"/><stop offset="1" stop-color="hsl(${(hue + 140) % 360},70%,15%)"/></radialGradient></defs><rect width="512" height="512" fill="url(#g)"/><circle cx="256" cy="230" r="${90 + (h[4] % 60)}" fill="none" stroke="white" stroke-width="10"/><text x="256" y="440" font-family="monospace" font-size="44" fill="white" text-anchor="middle">${symbol}</text></svg>`;
  const layers = ["Common", "Rare", "Legendary"].map((r, i) => ({
    name: `${r.toLowerCase()}.svg`,
    content: svg.replace("stroke-width=\"10\"", `stroke-width="${10 + i * 12}"`),
    contentType: "image/svg+xml",
  }));
  return { name, symbol, story, images: [{ name: "cover.svg", content: svg, contentType: "image/svg+xml" }, ...layers] };
}

/** LLM-written name/symbol/story when OPENAI_* is configured; placeholder otherwise. Images stay placeholder. */
export async function generateProject(seed: string, llm: LlmConfig | null): Promise<GeneratedProject> {
  const base = generatePlaceholder(seed);
  const out = await chat(llm, "You invent original meme projects for an AI-agent launchpad. No profit promises, no price talk, no real people or brands. Reply JSON {\"name\":≤32 chars,\"symbol\":2-10 A-Z0-9,\"story\":200-600 chars}.", `Seed: ${seed}`, { json: true, temperature: 0.9 });
  if (!out) return base;
  try {
    const j = JSON.parse(out);
    const symbol = String(j.symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
    if (!j.name || symbol.length < 2 || !j.story) return base;
    return { ...base, name: String(j.name).slice(0, 32), symbol, story: String(j.story).slice(0, 2000) };
  } catch {
    return base;
  }
}
