import { EventEmitter } from "node:events";
import type { Chain, PublicClient } from "viem";
import type { Config } from "./config.js";
import { openDatabase, type Database } from "./db/index.js";
import { makeChain, makePublicClient, resolveAddresses, type Addresses } from "./chain/client.js";
import type { PlatformSigner, Relayer } from "./signer/types.js";
import { createPlatformSigner, createRelayer } from "./signer/factory.js";
import type { XProvider } from "./providers/x/types.js";
import { FxTwitterProvider } from "./providers/x/fxtwitter.js";
import { MockXProvider } from "./providers/x/mock.js";
import { BinanceCliResolver, BinanceHttpResolver, MockAgentIdResolver, SpaceIdOnchainResolver, type AgentIdResolver } from "./providers/agentid/index.js";
import { ArchiveRpcFundingProvider, EtherscanFundingProvider, MockFundingProvider, RpcScanFundingProvider, type FundingSourceProvider } from "./providers/funding/index.js";

export interface Logger {
  info(o: unknown, msg?: string): void;
  warn(o: unknown, msg?: string): void;
  error(o: unknown, msg?: string): void;
  debug(o: unknown, msg?: string): void;
}

export const consoleLogger: Logger = {
  info: (o, m) => console.log("[info]", m ?? "", typeof o === "string" ? o : JSON.stringify(o)),
  warn: (o, m) => console.warn("[warn]", m ?? "", typeof o === "string" ? o : JSON.stringify(o)),
  error: (o, m) => console.error("[error]", m ?? "", o instanceof Error ? o.stack : JSON.stringify(o)),
  debug: () => undefined,
};

export interface AppContext {
  cfg: Config;
  database: Database;
  pc: PublicClient;
  chain: Chain;
  addresses: Addresses;
  signer: PlatformSigner;
  relayer: Relayer;
  x: XProvider;
  resolver: AgentIdResolver;
  funding: FundingSourceProvider;
  bus: EventEmitter; // "trade" | "project" | "graduated" ...
  log: Logger;
}

export interface ContextOverrides {
  x?: XProvider;
  resolver?: AgentIdResolver;
  funding?: FundingSourceProvider;
  signer?: PlatformSigner;
  relayer?: Relayer;
  log?: Logger;
  database?: Database;
}

export async function createContext(cfg: Config, o: ContextOverrides = {}): Promise<AppContext> {
  const chain = makeChain(cfg);
  const pc = makePublicClient(cfg);
  const addresses = resolveAddresses(cfg);
  const database = o.database ?? (await openDatabase(cfg.DATABASE_URL, cfg.DB_AUTO_MIGRATE));

  const signer = o.signer ?? (await createPlatformSigner(cfg, { pc, chain }));
  const relayer = o.relayer ?? (await createRelayer(cfg, signer, { pc, chain }));

  const x =
    o.x ??
    (cfg.X_PROVIDER === "fxtwitter"
      ? new FxTwitterProvider({
          baseUrl: cfg.FXTWITTER_BASE_URL, minIntervalMs: cfg.FXTWITTER_MIN_INTERVAL_MS, cacheTtlSec: cfg.FXTWITTER_CACHE_TTL_SEC, maxRetries: cfg.FXTWITTER_MAX_RETRIES,
        })
      : new MockXProvider());
  const resolver =
    o.resolver ??
    (cfg.AGENTID_PROVIDER === "spaceid"
      ? new SpaceIdOnchainResolver(pc as any, cfg.SPACEID_AGENT_REGISTRY as `0x${string}`)
      : cfg.AGENTID_PROVIDER === "binance-http"
      ? new BinanceHttpResolver(cfg.BINANCE_API_BASE, cfg.BINANCE_CHAIN_ID, cfg.BINANCE_AGENT_SESSION_ID)
      : cfg.AGENTID_PROVIDER === "binance-cli"
        ? new BinanceCliResolver(cfg.BAW_BIN, cfg.BINANCE_CHAIN_ID)
        : new MockAgentIdResolver());
  const funding =
    o.funding ??
    (cfg.FUNDING_PROVIDER === "etherscan"
      ? new EtherscanFundingProvider(cfg.ETHERSCAN_API_URL, cfg.ETHERSCAN_API_KEY ?? "", cfg.CHAIN_ID)
      : cfg.FUNDING_PROVIDER === "rpc-archive"
        ? new ArchiveRpcFundingProvider(cfg.FUNDING_RPC_URL.split(",").map((u) => u.trim()).filter(Boolean))
      : cfg.FUNDING_PROVIDER === "rpc-scan"
        ? new RpcScanFundingProvider(pc, BigInt(cfg.START_BLOCK))
        : new MockFundingProvider());

  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  return { cfg, database, pc, chain, addresses, signer, relayer, x, resolver, funding, bus, log: o.log ?? consoleLogger };
}
