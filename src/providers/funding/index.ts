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
  /** wallet -> its first funding source, or null when the wallet has never been funded. A wallet whose lookup FAILED
   *  (API error / rate limit / plan restriction) is left OUT of the map, so the sybil scan retries it next run instead
   *  of recording "no funder". */
  firstInboundMany(wallets: string[]): Promise<Map<string, FundingSource | null>>;
  readonly name?: string;
}

export class FundingLookupError extends Error {}

/**
 * Etherscan v2 multichain API (BscScan is served by chainid=56): earliest of
 *   module=account&action=txlist         (normal txs, value>0, to=wallet)
 *   module=account&action=txlistinternal (internal txs — smart-contract wallets such as Binance agentic wallets
 *                                         are often funded via contract calls)
 */
export class EtherscanFundingProvider implements FundingSourceProvider {
  readonly name = "etherscan";
  constructor(private apiUrl: string, private apiKey: string, private chainId: number, private fetchImpl: typeof fetch = fetch) {}
  private async first(action: "txlist" | "txlistinternal", wallet: string): Promise<FundingSource | null> {
    const qs = new URLSearchParams({
      chainid: String(this.chainId), module: "account", action, address: wallet, startblock: "0", endblock: "999999999",
      page: "1", offset: "50", sort: "asc", apikey: this.apiKey,
    });
    const res = await this.fetchImpl(`${this.apiUrl}?${qs}`);
    const body: any = await res.json();
    // status "0" + "No transactions found" is a real empty answer; any other "0" (bad key, rate limit, "Free API access is
    // not supported for this chain" — BSC needs a paid Etherscan plan since 2025) is a failed lookup.
    if (body.status !== "1" || !Array.isArray(body.result)) {
      if (/no transactions found/i.test(String(body.message ?? "")) || (Array.isArray(body.result) && body.result.length === 0)) return null;
      throw new FundingLookupError(`etherscan ${action}: ${body.message ?? "error"} ${typeof body.result === "string" ? body.result : ""}`.trim());
    }
    const t = body.result.find((r: any) => lc(r.to ?? "") === lc(wallet) && BigInt(r.value ?? "0") > 0n && r.isError !== "1");
    return t ? { from: lc(t.from), txHash: t.hash, blockNumber: Number(t.blockNumber), value: String(t.value) } : null;
  }
  async firstInboundMany(wallets: string[]) {
    const out = new Map<string, FundingSource | null>();
    for (const w of wallets) {
      try {
        const [a, b] = await Promise.all([this.first("txlist", w), this.first("txlistinternal", w)]);
        const best = [a, b].filter((x): x is FundingSource => !!x).sort((x, y) => x.blockNumber - y.blockNumber)[0] ?? null;
        out.set(lc(w), best);
      } catch {
        /* failed lookup: leave unchecked (retried next scan) */
      }
      await new Promise((r) => setTimeout(r, 250)); // free tier: 5 req/s
    }
    return out;
  }
}

type RpcCall = (method: string, params: unknown[]) => Promise<any>;

/** JSON-RPC over plain fetch with fallback across several URLs (comma-separated). */
export function jsonRpc(urls: string[], fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): RpcCall {
  let id = 0;
  return async (method, params) => {
    let last: unknown = null;
    for (const url of urls) {
      try {
        const res = await fetchImpl(url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs),
        });
        const body: any = await res.json();
        if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
        return body.result;
      } catch (e) {
        last = e;
      }
    }
    throw new FundingLookupError(String((last as any)?.message ?? last));
  };
}

/**
 * Keyless BSC funding lookup over a public ARCHIVE RPC (default: Blast public endpoint, which serves historical state).
 * Binary-searches the first block where the wallet had a balance or a nonce (monotonic until its first outgoing tx),
 * then reads that block: the top-level tx paying the wallet gives the funder. When the wallet was funded by an internal
 * transfer (contract wallets), the tx in that block whose receipt logs mention the wallet is used (its sender = funder,
 * marked best-effort). ~30 RPC calls per wallet.
 */
export class ArchiveRpcFundingProvider implements FundingSourceProvider {
  readonly name = "rpc-archive";
  private rpc: RpcCall;
  constructor(urls: string[], private fromBlock = 0, fetchImpl: typeof fetch = fetch) {
    this.rpc = jsonRpc(urls, fetchImpl);
  }
  private async touched(w: string, n: number): Promise<boolean> {
    const tag = "0x" + n.toString(16);
    const [bal, nonce] = await Promise.all([this.rpc("eth_getBalance", [w, tag]), this.rpc("eth_getTransactionCount", [w, tag])]);
    return BigInt(bal) > 0n || BigInt(nonce) > 0n;
  }
  async lookup(wallet: string): Promise<FundingSource | null> {
    const w = lc(wallet);
    const head = Number(BigInt(await this.rpc("eth_blockNumber", [])));
    if (!(await this.touched(w, head))) return null; // never funded
    let lo = Math.max(0, this.fromBlock); // invariant: not touched at lo-1 (or lo = 0); touched at hi
    let hi = head;
    if (lo > 0 && (await this.touched(w, lo))) lo = 0; // funded before the hint: search all history
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await this.touched(w, mid)) hi = mid;
      else lo = mid + 1;
    }
    const block: any = await this.rpc("eth_getBlockByNumber", ["0x" + hi.toString(16), true]);
    const txs: any[] = block?.transactions ?? [];
    const direct = txs.find((tx) => lc(tx.to ?? "") === w && BigInt(tx.value ?? "0") > 0n);
    if (direct) return { from: lc(direct.from), txHash: direct.hash, blockNumber: hi, value: BigInt(direct.value).toString() };
    const own = txs.find((tx) => lc(tx.from ?? "") === w);
    // internal transfer: find the tx whose logs mention the wallet (topic or data)
    const needle = w.slice(2);
    for (const tx of txs) {
      if (own && tx.hash === own.hash) continue;
      const rc: any = await this.rpc("eth_getTransactionReceipt", [tx.hash]).catch(() => null);
      if (rc?.logs?.some((l: any) => (l.topics ?? []).some((t: string) => lc(t).endsWith(needle)) || lc(l.data ?? "").includes(needle))) {
        return { from: lc(tx.from), txHash: tx.hash, blockNumber: hi, value: "0" };
      }
    }
    return { from: own ? w : "", txHash: own?.hash ?? "", blockNumber: hi, value: "0" }; // funder unknown (from "" never links)
  }
  async firstInboundMany(wallets: string[]) {
    const out = new Map<string, FundingSource | null>();
    for (const w of wallets) {
      try {
        out.set(lc(w), await this.lookup(w));
      } catch {
        /* failed lookup: retried next scan */
      }
    }
    return out;
  }
}

/** Local/dev: scans blocks over RPC (top-level txs only). Bounded by maxBlocks; never use on mainnet. */
export class RpcScanFundingProvider implements FundingSourceProvider {
  readonly name = "rpc-scan";
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
  readonly name = "mock";
  map = new Map<string, FundingSource | null>();
  async firstInboundMany(wallets: string[]) {
    return new Map(wallets.map((w) => [lc(w), this.map.get(lc(w)) ?? null] as const));
  }
}
export type { Address };
