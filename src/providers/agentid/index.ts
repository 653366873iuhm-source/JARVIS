import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Address } from "viem";

export interface ResolvedAgentId {
  address: Address;
  addressType?: "EOA" | "CONTRACT" | "UNKNOWN" | string;
  isFallback?: boolean;
}

export class AgentIdResolveError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/** Resolves a Binance Agent ID (e.g. "alice.ai") to its wallet address on BSC. */
export interface AgentIdResolver {
  resolve(agentId: string): Promise<ResolvedAgentId | null>;
}

const NOT_FOUND_CODES = new Set(["20003005", "20003006", "20003007"]);

function fromResponse(body: any): ResolvedAgentId | null {
  if (!body) return null;
  if (body.success === false || (body.code && body.code !== "000000")) {
    const code = String(body.code ?? body.error?.code ?? "");
    if (NOT_FOUND_CODES.has(code)) return null;
    throw new AgentIdResolveError(`Agent ID resolve failed: ${body.message ?? body.error?.message ?? code}`, code);
  }
  const d = body.data;
  if (!d?.address) return null;
  return { address: d.address, addressType: d.addressType, isFallback: !!d.isFallback };
}

/**
 * Binance Web3 backend used by `baw wallet resolve-domain` (found in @binance/agentic-wallet v1.11 dist):
 *   POST {BINANCE_API_BASE}/bapi/defi/v1/public/wallet-direct/agent-wallet/domain/resolve
 *   body {"name":"alice.ai","binanceChainId":"56"}
 *   -> {"success":true,"data":{"name","binanceChainId","address","isFallback","addressType"}}
 * The endpoint requires an agent-wallet session (cookie agentSessionId); anonymous calls return
 * code 100001005 "Please log in first". TODO(prod): obtain an official partner/API credential from Binance for
 * server-side resolution; until then provide BINANCE_AGENT_SESSION_ID from a platform-owned agentic wallet login,
 * or use the CLI provider. Errors 20003005/6/7 = unsupported TLD / incompatible chain / no address -> not found.
 */
export class BinanceHttpResolver implements AgentIdResolver {
  constructor(
    private base: string,
    private chainId: string,
    private sessionId?: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async resolve(agentId: string) {
    const headers: Record<string, string> = { "content-type": "application/json", clientType: "web", agentClientType: "AGENT_CLI" };
    if (this.sessionId) headers.cookie = `agentSessionId=${this.sessionId}`;
    const res = await this.fetchImpl(`${this.base.replace(/\/+$/, "")}/bapi/defi/v1/public/wallet-direct/agent-wallet/domain/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: agentId, binanceChainId: this.chainId }),
    });
    if (!res.ok) throw new AgentIdResolveError(`Binance resolve HTTP ${res.status}`);
    return fromResponse(await res.json());
  }
}

/** Shells out to the official CLI (`baw wallet resolve-domain --name <id> --binanceChainId 56 --json`). Needs a signed-in CLI. */
export class BinanceCliResolver implements AgentIdResolver {
  constructor(private bin: string, private chainId: string) {}
  async resolve(agentId: string) {
    const run = promisify(execFile);
    try {
      const { stdout } = await run(this.bin, ["wallet", "resolve-domain", "--name", agentId, "--binanceChainId", this.chainId, "--json"], { timeout: 20_000 });
      return fromResponse(JSON.parse(stdout));
    } catch (e: any) {
      const out = e?.stdout ? String(e.stdout) : "";
      if (out.trim().startsWith("{")) return fromResponse(JSON.parse(out));
      throw new AgentIdResolveError(`baw resolve-domain failed: ${e?.message ?? e}`);
    }
  }
}

export class MockAgentIdResolver implements AgentIdResolver {
  map = new Map<string, ResolvedAgentId>();
  set(agentId: string, address: Address, extra: Partial<ResolvedAgentId> = {}) {
    this.map.set(agentId.toLowerCase(), { address, addressType: "EOA", isFallback: false, ...extra });
  }
  async resolve(agentId: string) {
    return this.map.get(agentId.toLowerCase()) ?? null;
  }
}

/** SPACE ID "Agent ID" HandleRegistry on BSC — the soulbound ERC-721 behind Binance .ai names (verified on Sourcify). */
export const SPACEID_AGENT_REGISTRY_BSC = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F" as const;
export const SpaceIdHandleRegistryAbi = [
  { type: "function", name: "ownerOfHandle", stateMutability: "view", inputs: [{ name: "handle", type: "string" }], outputs: [{ type: "address" }] },
  { type: "function", name: "handleOf", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "string" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** "Alice.ai" / "alice" → "alice" (the registry stores the bare label: 3–20 chars of [a-z0-9]). */
export function agentIdLabel(agentId: string): string | null {
  const s = String(agentId ?? "").trim().toLowerCase().replace(/\.ai$/, "");
  return /^[a-z0-9]{1,64}$/.test(s) ? s : null;
}

type ReadClient = {
  readContract(args: { address: Address; abi: typeof SpaceIdHandleRegistryAbi; functionName: "ownerOfHandle" | "handleOf"; args: readonly [string] | readonly [Address] }): Promise<unknown>;
  getCode?(args: { address: Address }): Promise<string | undefined>;
};

/**
 * Public, login-free resolution straight from chain: `ownerOfHandle(label)` on the SPACE ID Agent ID registry.
 * The token is soulbound and one-per-wallet (handleOf[wallet] is permanent), so name ↔ wallet is a fixed binding;
 * no Binance session needed. isFallback is always false (the record is native to BSC).
 */
export class SpaceIdOnchainResolver implements AgentIdResolver {
  constructor(private pc: ReadClient, private registry: Address = SPACEID_AGENT_REGISTRY_BSC) {}
  async resolve(agentId: string): Promise<ResolvedAgentId | null> {
    const label = agentIdLabel(agentId);
    if (!label) return null;
    let owner: string;
    try {
      owner = String(await this.pc.readContract({ address: this.registry, abi: SpaceIdHandleRegistryAbi, functionName: "ownerOfHandle", args: [label] as const }));
    } catch (e: any) {
      throw new AgentIdResolveError(`Agent ID registry read failed: ${e?.shortMessage ?? e?.message ?? e}`);
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner) || /^0x0{40}$/i.test(owner)) return null;
    let addressType = "UNKNOWN";
    try {
      const code = this.pc.getCode ? await this.pc.getCode({ address: owner as Address }) : undefined;
      addressType = code && code !== "0x" ? "CONTRACT" : code === undefined ? "UNKNOWN" : "EOA";
    } catch {
      /* type is informational only */
    }
    return { address: owner as Address, addressType, isFallback: false };
  }
  /** Reverse lookup: the .ai name a wallet holds ("" → none). */
  async nameOf(wallet: Address): Promise<string | null> {
    const h = String(await this.pc.readContract({ address: this.registry, abi: SpaceIdHandleRegistryAbi, functionName: "handleOf", args: [wallet] as const }));
    return h ? `${h}.ai` : null;
  }
}
