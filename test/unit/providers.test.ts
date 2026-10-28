import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FxTwitterProvider, mapFxTweet } from "../../src/providers/x/fxtwitter.js";
import { XRateLimitError } from "../../src/providers/x/types.js";
import { BinanceCliResolver, BinanceHttpResolver, AgentIdResolveError } from "../../src/providers/agentid/index.js";
import { ArchiveRpcFundingProvider, EtherscanFundingProvider } from "../../src/providers/funding/index.js";

function fakeFetch(routes: (url: string, init?: RequestInit) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = routes(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}

// Response shapes captured from live api.fxtwitter.com (2026-10-27): GET /jack and GET /status/20.
const FX_USER = {
  code: 200, message: "OK",
  user: { screen_name: "Bot_A", url: "https://x.com/Bot_A", id: "42", followers: 9000, following: 3, likes: 10, media_count: 1, tweets: 3100, name: "Bot A", joined: "Tue Jun 02 20:12:29 +0000 2009", protected: false },
};
const fxTweet = (o: Record<string, unknown> = {}) => ({
  code: 200, message: "OK",
  tweet: {
    url: "https://x.com/Bot_A/status/1850000000000000001", id: "1850000000000000001", text: "#AP_X AP-1 hi",
    author: { screen_name: "Bot_A", id: "42", followers: 9000 },
    replies: 2, retweets: 3, likes: 5, bookmarks: 0, quotes: 1, created_at: "Mon Oct 26 08:00:00 +0000 2026", created_timestamp: 1792915200,
    views: 1234, replying_to: null, replying_to_status: null, reposted_by: null, ...o,
  },
});
const HTML_404 = "<!DOCTYPE html><html><head><meta property=\"og:description\" content=\"Sorry, that post doesn't exist :(\"/></head></html>";

function fxFetch(handler: (url: string) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const r = handler(url);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const fast = { minIntervalMs: 0, backoffBaseMs: 1, sleep: async () => undefined };

describe("FxTwitter provider", () => {
  it("maps user + tweet fields (joined, followers, likes/retweets/replies, quote/reply/repost flags)", async () => {
    const { f, calls } = fxFetch((url) => (url.endsWith("/bot_a") ? { body: FX_USER } : { body: fxTweet({ quote: { id: "777" } }) }));
    const x = new FxTwitterProvider({ ...fast, baseUrl: "https://fx.test/", fetchImpl: f });
    const u = await x.getUserByUsername("@bot_a");
    expect(u).toEqual({ id: "42", username: "Bot_A", name: "Bot A", createdAt: Date.parse("2009-06-02T20:12:29Z") / 1000, followers: 9000, following: 3, tweetCount: 3100, protected: false });
    const p = await x.getPost("1850000000000000001");
    expect(p).toMatchObject({
      id: "1850000000000000001", authorId: "42", authorUsername: "Bot_A", authorFollowers: 9000, text: "#AP_X AP-1 hi", createdAt: 1792915200,
      likes: 5, reposts: 3, replies: 2, quotes: 1, impressions: 1234, isRepost: false, quoteOfId: "777", replyToId: undefined,
    });
    expect(calls).toEqual(["https://fx.test/bot_a", "https://fx.test/status/1850000000000000001"]);
    expect(mapFxTweet({ ...fxTweet().tweet, reposted_by: { screen_name: "z" }, replying_to_status: "55", created_timestamp: undefined }))
      .toMatchObject({ isRepost: true, replyToId: "55", createdAt: Date.parse("2026-10-26T08:00:00Z") / 1000 });
  });
  it("maps missing users (JSON 404) and missing posts (HTML 200) to null; rejects junk ids without a request", async () => {
    const { f, calls } = fxFetch((url) => (url.includes("/status/") ? { body: HTML_404 } : { status: 404, body: { code: 404, message: "User not found" } }));
    const x = new FxTwitterProvider({ ...fast, fetchImpl: f });
    expect(await x.getUserByUsername("nobody_here")).toBeNull();
    expect(await x.getPost("123")).toBeNull();
    expect(await x.getPost("abc")).toBeNull();
    expect(await x.getUserByUsername("bad handle!")).toBeNull();
    expect(calls).toHaveLength(2);
  });
  it("caches responses for the TTL", async () => {
    let t = 1_000_000;
    const { f, calls } = fxFetch(() => ({ body: FX_USER }));
    const x = new FxTwitterProvider({ ...fast, fetchImpl: f, cacheTtlSec: 60, now: () => t });
    await x.getUserByUsername("bot_a");
    await x.getUserByUsername("bot_a");
    expect(calls).toHaveLength(1);
    t += 61_000;
    await x.getUserByUsername("bot_a");
    expect(calls).toHaveLength(2);
  });
  it("retries 429/5xx/network errors with exponential backoff (honours Retry-After), then gives up", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      if (n === 2) return new Response("{}", { status: 503 });
      if (n === 3) return new Response("{}", { status: 429, headers: { "retry-after": "7" } });
      return new Response(JSON.stringify(FX_USER), { status: 200 });
    }) as unknown as typeof fetch;
    const x = new FxTwitterProvider({ minIntervalMs: 0, backoffBaseMs: 100, maxRetries: 3, fetchImpl: f, sleep: async (ms) => void sleeps.push(ms) });
    expect((await x.getUserByUsername("bot_a"))?.id).toBe("42");
    expect(sleeps).toEqual([100, 200, 7000]);

    const always429 = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
    const y = new FxTwitterProvider({ minIntervalMs: 0, backoffBaseMs: 1, maxRetries: 2, fetchImpl: always429, sleep: async () => undefined });
    await expect(y.getUserByUsername("bot_a")).rejects.toBeInstanceOf(XRateLimitError);
    expect(y.requests).toBe(3);
  });
  it("spaces request starts by minIntervalMs (~1 req/s) even when called concurrently", async () => {
    let t = 0;
    const starts: number[] = [];
    const f = (async (url: string) => {
      starts.push(t);
      return new Response(JSON.stringify(fxTweet({ id: url.split("/").pop() })), { status: 200 });
    }) as unknown as typeof fetch;
    const x = new FxTwitterProvider({ minIntervalMs: 1000, cacheTtlSec: 0, fetchImpl: f, now: () => t, sleep: async (ms) => void (t += ms) });
    const res = await Promise.all(["1", "2", "3"].map((id) => x.getPost(id)));
    expect(res.map((p) => p?.id)).toEqual(["1", "2", "3"]);
    expect(starts).toEqual([0, 1000, 2000]);
    expect((await x.getPosts(["1", "1", "2"])).map((p) => p.id)).toEqual(["1", "2"]);
  });
});

describe("Binance Agent ID resolver", () => {
  it("HTTP: resolves, maps not-found codes to null, surfaces login errors", async () => {
    const { f, calls } = fakeFetch((_u, init) => {
      const name = JSON.parse(String(init!.body)).name;
      if (name === "alice.ai") return { body: { success: true, code: "000000", data: { name, binanceChainId: "56", address: "0x00000000000000000000000000000000000000aa", isFallback: false, addressType: "CONTRACT" } } };
      if (name === "none.ai") return { body: { success: false, code: "20003007", message: "No address bound" } };
      return { body: { success: false, code: "100001005", message: "Please log in first." } };
    });
    const r = new BinanceHttpResolver("https://www.binance.com", "56", "sess", f);
    expect(await r.resolve("alice.ai")).toEqual({ address: "0x00000000000000000000000000000000000000aa", addressType: "CONTRACT", isFallback: false });
    expect(calls[0]!.url).toBe("https://www.binance.com/bapi/defi/v1/public/wallet-direct/agent-wallet/domain/resolve");
    expect((calls[0]!.init!.headers as any).cookie).toBe("agentSessionId=sess");
    expect(await r.resolve("none.ai")).toBeNull();
    await expect(r.resolve("x.ai")).rejects.toBeInstanceOf(AgentIdResolveError);
  });
  it("CLI: parses `baw wallet resolve-domain --json` output", async () => {
    const bin = path.join(os.tmpdir(), `fake-baw-${Date.now()}.sh`);
    fs.writeFileSync(bin, `#!/bin/sh\necho '{"success":true,"data":{"name":"'$4'","binanceChainId":"56","address":"0x00000000000000000000000000000000000000bb","isFallback":true,"addressType":"EOA"}}'\n`);
    fs.chmodSync(bin, 0o755);
    const r = await new BinanceCliResolver(bin, "56").resolve("bob.ai");
    expect(r).toEqual({ address: "0x00000000000000000000000000000000000000bb", addressType: "EOA", isFallback: true });
    fs.rmSync(bin);
  });
});

describe("Etherscan funding provider", () => {
  it("picks the earliest inbound value transfer across normal and internal txs", async () => {
    const w = "0x00000000000000000000000000000000000000cc";
    const { f } = fakeFetch((url) => {
      if (url.includes("action=txlistinternal")) return { body: { status: "1", result: [{ from: "0xF1", to: w, value: "5", blockNumber: "90", hash: "0xi" }] } };
      return { body: { status: "1", result: [{ from: w, to: "0x1", value: "1", blockNumber: "10", hash: "0xo" }, { from: "0xF2", to: w, value: "7", blockNumber: "100", hash: "0xn" }] } };
    });
    const m = await new EtherscanFundingProvider("https://api.etherscan.io/v2/api", "k", 56, f).firstInboundMany([w]);
    expect(m.get(w)).toEqual({ from: "0xf1", txHash: "0xi", blockNumber: 90, value: "5" });
  });
});

describe("funding lookup failures are not recorded as 'no funder'", () => {
  it("Etherscan plan/key errors leave the wallet out of the map; 'No transactions found' is a real null", async () => {
    const w = "0x00000000000000000000000000000000000000cd";
    const bad = fakeFetch(() => ({ body: { status: "0", message: "NOTOK", result: "Free API access is not supported for this chain." } })).f;
    expect((await new EtherscanFundingProvider("https://x/api", "k", 56, bad).firstInboundMany([w])).has(w)).toBe(false);
    const empty = fakeFetch(() => ({ body: { status: "0", message: "No transactions found", result: [] } })).f;
    const m = await new EtherscanFundingProvider("https://x/api", "k", 56, empty).firstInboundMany([w]);
    expect(m.has(w)).toBe(true);
    expect(m.get(w)).toBeNull();
  });
});

describe("archive RPC funding provider (keyless)", () => {
  const w = "0x00000000000000000000000000000000000000ce";
  const FUND = 777; // first block with balance
  const rpcFetch = (opts: { direct: boolean; fail?: boolean }) =>
    (async (_url: any, init: any) => {
      const { method, params, id } = JSON.parse(init.body);
      const r = (result: unknown) => ({ json: async () => ({ jsonrpc: "2.0", id, result }) }) as any;
      if (opts.fail) return { json: async () => ({ jsonrpc: "2.0", id, error: { message: "missing trie node" } }) } as any;
      const n = (t: string) => Number(BigInt(t));
      if (method === "eth_blockNumber") return r("0x" + (5000).toString(16));
      if (method === "eth_getBalance") return r(n(params[1]) >= FUND ? "0x10" : "0x0");
      if (method === "eth_getTransactionCount") return r(n(params[1]) >= 900 ? "0x1" : "0x0");
      if (method === "eth_getBlockByNumber") {
        expect(n(params[0])).toBe(FUND);
        return r({ transactions: opts.direct
          ? [{ hash: "0xa", from: "0x00000000000000000000000000000000000000f1", to: w, value: "0x10" }]
          : [{ hash: "0xb", from: "0x00000000000000000000000000000000000000f2", to: "0x00000000000000000000000000000000000000c0", value: "0x0" }] });
      }
      if (method === "eth_getTransactionReceipt") return r({ logs: [{ topics: ["0xdd", "0x000000000000000000000000" + w.slice(2)], data: "0x" }] });
      throw new Error(method);
    }) as unknown as typeof fetch;
  it("binary-searches the first funded block and reads the paying tx", async () => {
    const m = await new ArchiveRpcFundingProvider(["https://rpc"], 0, rpcFetch({ direct: true })).firstInboundMany([w]);
    expect(m.get(w)).toEqual({ from: "0x00000000000000000000000000000000000000f1", txHash: "0xa", blockNumber: FUND, value: "16" });
  });
  it("internal transfer: the tx whose logs name the wallet gives the funder", async () => {
    const m = await new ArchiveRpcFundingProvider(["https://rpc"], 0, rpcFetch({ direct: false })).firstInboundMany([w]);
    expect(m.get(w)?.from).toBe("0x00000000000000000000000000000000000000f2");
  });
  it("RPC errors (non-archive node) leave the wallet unchecked", async () => {
    const m = await new ArchiveRpcFundingProvider(["https://rpc"], 0, rpcFetch({ direct: true, fail: true })).firstInboundMany([w]);
    expect(m.has(w)).toBe(false);
  });
});
