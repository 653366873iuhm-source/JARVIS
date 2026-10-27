import type { Address, PublicClient } from "viem";
import { lc } from "../../lib/util.js";

export interface FundingSource {
  from: string; // lowercase
  txHash: string;
  blockNumber: number;
  value: string;
}

/** Finds the first inbound native-BNB transfer of a wallet (its funding source) for sybil clustering. */
export interface FundingSourceProvider {
  firstInboundMany(wallets: string[]): Promise<Map<string, FundingSource | null>>;
}

/**
 * Etherscan v2 multichain API (BscScan is served by chainid=56): earliest of
 *   module=account&action=txlist         (normal txs, value>0, to=wallet)
 *   module=account&action=txlistinternal (internal txs — smart-contract wallets such as Binance agentic wallets
 *                                         are often funded via contract calls)
 */
export class EtherscanFundingProvider implements FundingSourceProvider {
  constructor(private apiUrl: string, private apiKey: string, private chainId: number, private fetchImpl: typeof fetch = fetch) {}
  private async first(action: "txlist" | "txlistinternal", wallet: string): Promise<FundingSource | null> {
    const qs = new URLSearchParams({
      chainid: String(this.chainId), module: "account", action, address: wallet, startblock: "0", endblock: "999999999",
      page: "1", offset: "50", sort: "asc", apikey: this.apiKey,
    });
    const res = await this.fetchImpl(`${this.apiUrl}?${qs}`);
    const body: any = await res.json();
    if (body.status !== "1" || !Array.isArray(body.result)) return null;
    const t = body.result.find((r: any) => lc(r.to ?? "") === lc(wallet) && BigInt(r.value ?? "0") > 0n && r.isError !== "1");
    return t ? { from: lc(t.from), txHash: t.hash, blockNumber: Number(t.blockNumber), value: String(t.value) } : null;
  }
  async firstInboundMany(wallets: string[]) {
    const out = new Map<string, FundingSource | null>();
    for (const w of wallets) {
      const [a, b] = await Promise.all([this.first("txlist", w), this.first("txlistinternal", w)]);
      const best = [a, b].filter((x): x is FundingSource => !!x).sort((x, y) => x.blockNumber - y.blockNumber)[0] ?? null;
      out.set(lc(w), best);
      await new Promise((r) => setTimeout(r, 250)); // free tier: 5 req/s
    }
    return out;
  }
}

/** Local/dev: scans blocks over RPC (top-level txs only). Bounded by maxBlocks; never use on mainnet. */
export class RpcScanFundingProvider implements FundingSourceProvider {
  constructor(private pc: PublicClient, private fromBlock = 0n, private maxBlocks = 20_000n) {}
  async firstInboundMany(wallets: string[]) {
    const want = new Set(wallets.map(lc));
    const out = new Map<string, FundingSource | null>();
    for (const w of want) out.set(w, null);
    const latest = await this.pc.getBlockNumber();
    const start = latest - this.fromBlock > this.maxBlocks ? latest - this.maxBlocks : this.fromBlock;
    let remaining = want.size;
    for (let n = start; n <= latest && remaining > 0; n++) {
      const b = await this.pc.getBlock({ blockNumber: n, includeTransactions: true });
      for (const tx of b.transactions) {
        const to = tx.to ? lc(tx.to) : "";
        if (want.has(to) && out.get(to) === null && tx.value > 0n) {
          out.set(to, { from: lc(tx.from), txHash: tx.hash, blockNumber: Number(n), value: tx.value.toString() });
          remaining--;
        }
      }
    }
    return out;
  }
}

export class MockFundingProvider implements FundingSourceProvider {
  map = new Map<string, FundingSource | null>();
  async firstInboundMany(wallets: string[]) {
    return new Map(wallets.map((w) => [lc(w), this.map.get(lc(w)) ?? null] as const));
  }
}
export type { Address };
