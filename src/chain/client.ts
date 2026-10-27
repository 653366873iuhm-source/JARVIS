import fs from "node:fs";
import { createPublicClient, defineChain, fallback, http, type Address, type Chain, type PublicClient, type Transport } from "viem";
import type { Config } from "../config.js";

export interface Addresses {
  registry: Address;
  factory: Address;
  rewardPool: Address;
  feeSplitter?: Address;
}

/** RPC_URL may list several endpoints separated by commas; they are tried in order (viem fallback transport). */
export function rpcUrls(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function makeTransport(raw: string): Transport {
  const urls = rpcUrls(raw);
  if (urls.length <= 1) return http(urls[0] ?? raw, { retryCount: 3, timeout: 20_000 });
  return fallback(urls.map((u) => http(u, { retryCount: 1, timeout: 15_000 })), { rank: false, retryCount: 2 });
}

export function makeChain(cfg: Pick<Config, "CHAIN_ID" | "RPC_URL">): Chain {
  return defineChain({
    id: cfg.CHAIN_ID,
    name: cfg.CHAIN_ID === 56 ? "BNB Smart Chain" : cfg.CHAIN_ID === 97 ? "BSC Testnet" : `chain-${cfg.CHAIN_ID}`,
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: rpcUrls(cfg.RPC_URL) } },
  });
}

export function makePublicClient(cfg: Pick<Config, "CHAIN_ID" | "RPC_URL">): PublicClient {
  return createPublicClient({ chain: makeChain(cfg), cacheTime: 0, transport: makeTransport(cfg.RPC_URL) }) as PublicClient;
}

export function resolveAddresses(cfg: Config): Addresses {
  let dep: Record<string, string> = {};
  if (cfg.DEPLOYMENTS_FILE && fs.existsSync(cfg.DEPLOYMENTS_FILE)) {
    dep = JSON.parse(fs.readFileSync(cfg.DEPLOYMENTS_FILE, "utf8")).contracts ?? {};
  }
  const registry = (cfg.REGISTRY_ADDRESS ?? dep.AgentRegistry) as Address | undefined;
  const factory = (cfg.FACTORY_ADDRESS ?? dep.LaunchFactory) as Address | undefined;
  const rewardPool = (cfg.REWARD_POOL_ADDRESS ?? dep.RewardPool) as Address | undefined;
  const feeSplitter = (cfg.FEE_SPLITTER_ADDRESS ?? dep.FeeSplitter) as Address | undefined;
  if (!registry || !factory || !rewardPool) {
    throw new Error("Contract addresses missing: set REGISTRY_ADDRESS/FACTORY_ADDRESS/REWARD_POOL_ADDRESS or DEPLOYMENTS_FILE");
  }
  return { registry, factory, rewardPool, feeSplitter };
}

/** Latest block timestamp — all on-chain deadlines/expiries are derived from chain time, not wall clock. */
export async function chainNow(pc: PublicClient): Promise<number> {
  const b = await pc.getBlock({ blockTag: "latest" });
  return Number(b.timestamp);
}
