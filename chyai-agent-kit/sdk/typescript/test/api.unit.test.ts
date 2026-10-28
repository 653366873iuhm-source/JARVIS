import { describe, expect, it } from "vitest";
import { AgentPadApi, ApiError, DEFAULT_API_URL, eligibilityPostsTypedData, parsePostId } from "../src/api.js";
import { BINANCE_CHARITY, CHARITY_SHARE_BPS, PLATFORM_SHARE_BPS, splitFee } from "../src/constants.js";

describe("fee split constants", () => {
  it("launcher 30% / reward 20% / charity 20% / platform 30%, floor per share like BondingNFT", () => {
    expect(CHARITY_SHARE_BPS).toBe(2000n);
    expect(PLATFORM_SHARE_BPS).toBe(3000n);
    expect(BINANCE_CHARITY).toBe("0x8B99F3660622e21f2910ECCA7fBe51d654a1517D");
    expect(splitFee(1_000_003n)).toEqual({ launcher: 300_000n, reward: 200_000n, charity: 200_000n, platform: 300_003n });
  });
});

const fakeFetch = (status: number, body: unknown, seen: string[]) =>
  (async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

describe("AgentPadApi base URL + error envelope", () => {
  it("defaults to the /v1-prefixed backend", async () => {
    expect(DEFAULT_API_URL).toMatch(/\/v1$/);
    const seen: string[] = [];
    const api = new AgentPadApi({ fetch: fakeFetch(200, { items: [], nextCursor: null }, seen) });
    expect(api.baseUrl).toBe(DEFAULT_API_URL);
    await api.listProjects({ phase: "trading" } as any);
    expect(seen[0]).toMatch(/^https:\/\/agentpad-api\.onrender\.com\/v1\/projects/);
  });
  it("explicit baseUrl wins, trailing slash stripped", () => {
    expect(new AgentPadApi({ baseUrl: "https://api.example/v1/" }).baseUrl).toBe("https://api.example/v1");
  });
  it("reads the backend's nested { error: { code, message, details } }", async () => {
    const api = new AgentPadApi({ fetch: fakeFetch(404, { error: { code: "not_found", message: "unknown project" } }, []) });
    const e = await api.getProject("0x" + "ab".repeat(20) as any).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(404);
    expect(e.code).toBe("not_found");
  });
});

describe("post-URL submission (no X search)", () => {
  const capture = () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { seen, f };
  };
  it("submitPromotion POSTs {project, wallet, url} to /promotions/submit", async () => {
    const { seen, f } = capture();
    const body = { project: ("0x" + "ab".repeat(20)) as any, wallet: ("0x" + "cd".repeat(20)) as any, url: "https://x.com/bot/status/1850000000000000001" };
    await new AgentPadApi({ baseUrl: "https://api.example/v1", fetch: f }).submitPromotion(body);
    expect(seen[0]!.url).toBe("https://api.example/v1/promotions/submit");
    expect(seen[0]!.init!.method).toBe("POST");
    expect(JSON.parse(String(seen[0]!.init!.body))).toEqual(body);
  });
  it("submitEligibilityPosts POSTs to /agents/eligibility-posts", async () => {
    const { seen, f } = capture();
    await new AgentPadApi({ baseUrl: "https://api.example/v1", fetch: f }).submitEligibilityPosts({ wallet: ("0x" + "cd".repeat(20)) as any, postUrls: ["123456"], issuedAt: 1, signature: "0x01" });
    expect(seen[0]!.url).toBe("https://api.example/v1/agents/eligibility-posts");
  });
  it("parsePostId + EligibilityPosts typed data (ids comma-joined, Agent domain)", async () => {
    expect(parsePostId("https://x.com/Bot_A/status/1850000000000000001?s=20")).toBe("1850000000000000001");
    expect(parsePostId("https://twitter.com/a/statuses/123456")).toBe("123456");
    expect(parsePostId("https://example.com/nope")).toBeNull();
    const registry = ("0x" + "11".repeat(20)) as any;
    const wallet = ("0x" + "22".repeat(20)) as any;
    const td = eligibilityPostsTypedData({ chainId: 56, registry, wallet, postUrls: ["https://x.com/a/status/111111", "222222"], issuedAt: 1700000000 });
    expect(td.domain).toEqual({ name: "AgentPad", version: "1", chainId: 56, verifyingContract: registry });
    expect(td.message).toEqual({ wallet, postIds: "111111,222222", issuedAt: 1700000000n });
    expect(() => eligibilityPostsTypedData({ chainId: 56, registry, wallet, postUrls: ["nope"], issuedAt: 1 })).toThrow(/not an X post URL/);
  });
});

describe("BSC mainnet defaults", () => {
  it("DEPLOYMENTS[56] holds the mainnet addresses and start block", async () => {
    const { DEPLOYMENTS, BSC_MAINNET } = await import("../src/constants.js");
    expect(DEPLOYMENTS[56]).toBe(BSC_MAINNET);
    expect(BSC_MAINNET.AgentRegistry).toBe("0x9cfCb9fAa10A09f632d83C28a5DDaF044455c650");
    expect(BSC_MAINNET.LaunchFactory).toBe("0x1CaC41417B38388e72Dc02430f47e6dF96810702");
    expect(BSC_MAINNET.FeeSplitter).toBe("0xeb41B157e8D832B0338F28d496ecFc088308C368");
    expect(BSC_MAINNET.RewardPool).toBe("0x323C8F0FAD41dBc1B66E964d45dED28a88243E95");
    expect(BSC_MAINNET.fromBlock).toBe(130114130n);
    expect(DEFAULT_API_URL).toBe("https://agentpad-api.onrender.com/v1");
  });
});
