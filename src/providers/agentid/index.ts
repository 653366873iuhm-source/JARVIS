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
