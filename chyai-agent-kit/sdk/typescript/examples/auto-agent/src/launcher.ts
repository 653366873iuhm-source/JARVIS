/**
 * Example launcher agent: generate a name / symbol / story / images (placeholder generator, or an
 * OpenAI-compatible LLM for the text), pin everything to IPFS through a pluggable provider (mock by default,
 * Pinata with PINATA_JWT, Kubo RPC with IPFS_API_URL) and launch on AgentPad.
 *
 * Run:  npm run example:launch -- [seed]
 */
import { AgentPad, pinningFromEnv, type PinningProvider } from "@agentpad/sdk";
import { generateProject, type GeneratedProject } from "./generator.js";
import { llmFromEnv, type LlmConfig } from "./llm.js";

export async function launchGenerated(pad: AgentPad, opts: { seed: string; pinning?: PinningProvider; llm?: LlmConfig | null; agentId?: string; tokenFileCount?: number }): Promise<{ generated: GeneratedProject; project: `0x${string}`; token: `0x${string}`; baseURI: string; txHash: `0x${string}` }> {
  const generated = await generateProject(opts.seed, opts.llm ?? null);
  const next = await pad.nextLaunchAt();
  const now = (await pad.publicClient.getBlock()).timestamp;
  if (next > now) throw new Error(`launch cooldown: next launch at ${new Date(Number(next) * 1000).toISOString()}`);
  const r = await pad.launch({
    name: generated.name,
    symbol: generated.symbol,
    story: generated.story,
    images: generated.images,
    traits: [{ trait_type: "Rarity", values: [{ value: "Common", weight: 80, image: "common.svg" }, { value: "Rare", weight: 18, image: "rare.svg" }, { value: "Legendary", weight: 2, image: "legendary.svg" }] }],
    pinning: opts.pinning ?? pinningFromEnv(),
    agentId: opts.agentId,
    tokenFileCount: opts.tokenFileCount,
  });
  return { generated, project: r.project, token: r.token, baseURI: r.baseURI, txHash: r.hash };
}

const isMain = process.argv[1] && /launcher\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const { padFromEnv } = await import("./agent.js");
  const pad = padFromEnv();
  const seed = process.argv[2] ?? `${Date.now()}`;
  launchGenerated(pad, { seed, llm: llmFromEnv(), agentId: process.env.AGENT_ID })
    .then((r) => console.log(JSON.stringify({ project: r.project, token: r.token, baseURI: r.baseURI, tx: r.txHash, name: r.generated.name, symbol: r.generated.symbol }, null, 2)))
    .catch((e) => {
      console.error(e?.message ?? e);
      process.exit(1);
    });
}
