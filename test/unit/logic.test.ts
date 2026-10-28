import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, concat, toBytes } from "viem";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { normalizePostText, similarity } from "../../src/lib/similarity.js";
import { computeEligibility, thresholdsFromConfig } from "../../src/services/eligibility.js";
import { loadConfig } from "../../src/config.js";
import { postScore, proRata, epochOf } from "../../src/services/rewards.js";
import { quoteBuy, quoteSell, nftPrice, VIRTUAL_BNB0, VIRTUAL_TOKEN0, TOKENS_PER_NFT } from "../../src/lib/curve.js";
import { handleHash, parseTweetId, hmacCode, normHandle } from "../../src/lib/util.js";
import { projectTag } from "../../src/services/indexer.js";
import { promoterTree } from "../../src/services/promotion.js";
import type { XPost, XUser } from "../../src/providers/x/types.js";

const th = { minFollowers: 1200, minAccountAgeDays: 30, minPosts30d: 10, minEngagementBps: 50 };
const now = 1_800_000_000;
const user = (o: Partial<XUser> = {}): XUser => ({ id: "1", username: "a", createdAt: now - 200 * 86400, followers: 10_000, ...o });
const posts = (n: number, eng: number, age = 86400): XPost[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(i), authorId: "1", authorUsername: "a", text: "t", createdAt: now - age - i * 3600, likes: eng, reposts: 0, replies: 0, quotes: 0 }));

describe("similarity", () => {
  it("flags copy-paste with trivial edits, accepts different texts", () => {
    const a = normalizePostText("#AP_X AP-123 Agent Coin is the most fun experiment on BNB chain https://x.co/1", ["AP-123", "#AP_X"]);
    const b = normalizePostText("#AP_X AP-999 agent coin is the MOST fun experiment on BNB chain!!!", ["AP-999", "#AP_X"]);
    const c = normalizePostText("Sold out in record time, holding for the DEX listing tonight", []);
    expect(similarity(a, b)).toBeGreaterThan(0.95);
    expect(similarity(a, c)).toBeLessThan(0.3);
  });
  it("works for Chinese text", () => {
    expect(similarity(normalizePostText("这个项目太有意思了，全是AI在玩"), normalizePostText("这个项目太有意思了！全是AI在玩"))).toBeGreaterThan(0.9);
    expect(similarity(normalizePostText("这个项目太有意思了"), normalizePostText("明天上链大家准备好"))).toBeLessThan(0.2);
  });
});

describe("eligibility", () => {
  it("passes when all thresholds are met", () => {
    const r = computeEligibility(user(), posts(10, 50), now, th); // 50/10000 = 0.5%
    expect(r.eligible).toBe(true);
    expect(r.engagementBps).toBe(50);
  });
  it("lists every failing criterion", () => {
    const r = computeEligibility(user({ followers: 1199, createdAt: now - 29 * 86400 }), posts(9, 2), now, th);
    expect(r.eligible).toBe(false);
    expect(r.reasons.length).toBe(4);
    expect(r.reasons).toContain("followers 1199 < 1200");
    expect(r.reasons).toContain("account age 29d < 30d");
  });
  it("launch gate defaults: >= 1200 followers and >= 30 days pass at the boundary", () => {
    const d = thresholdsFromConfig(loadConfig({ NODE_ENV: "test" }));
    expect(d).toMatchObject({ minFollowers: 1200, minAccountAgeDays: 30, minPosts30d: 10, minEngagementBps: 50 });
    const r = computeEligibility(user({ followers: 1200, createdAt: now - 30 * 86400 }), posts(10, 12), now, d); // 12/1200 = 1%
    expect(r.reasons.filter((x) => /followers|account age/.test(x))).toEqual([]);
    expect(r.eligible).toBe(true);
  });
  it("ignores reposts and posts older than 30 days", () => {
    const p = [...posts(9, 100), ...posts(5, 100, 31 * 86400), { ...posts(1, 100)[0]!, id: "rt", isRepost: true }];
    expect(computeEligibility(user(), p, now, th).posts30d).toBe(9);
  });
  it("engagement = (likes + reposts + replies) / followers; quotes and duplicate ids don't count", () => {
    const p = posts(10, 0).map((x) => ({ ...x, likes: 20, reposts: 10, replies: 20, quotes: 1000 }));
    const r = computeEligibility(user(), [...p, p[0]!], now, th);
    expect(r.posts30d).toBe(10);
    expect(r.engagementBps).toBe(50); // 50 / 10_000
    expect(r.postIds).toHaveLength(10);
  });
});

describe("rewards math", () => {
  it("pro-rata floors and never exceeds the pool", () => {
    const m = proRata(1000n, new Map([["a", 1n], ["b", 2n], ["c", 0n]]));
    expect(m.get("a")).toBe(333n);
    expect(m.get("b")).toBe(666n);
    expect(m.has("c")).toBe(false);
    expect(proRata(0n, new Map([["a", 1n]])).size).toBe(0);
  });
  it("post score weights", () => {
    expect(postScore({ likes: 10, reposts: 1, replies: 1, quotes: 1 })).toBe(17);
    expect(epochOf(86400 * 3 + 5)).toBe(3);
  });
  it("reward leaf matches RewardPool: keccak256(bytes.concat(keccak256(abi.encode(epoch, account, amount))))", () => {
    const v: [string, string, string] = ["20000", "0x00000000000000000000000000000000000000aa", "12345"];
    const tree = StandardMerkleTree.of([v, ["20000", "0x00000000000000000000000000000000000000bb", "1"]], ["uint256", "address", "uint256"]);
    const inner = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }], [20000n, v[1] as `0x${string}`, 12345n]));
    expect(tree.leafHash(v)).toBe(keccak256(concat([inner])));
  });
  it("promoter leaf matches BondingNFT: keccak256(bytes.concat(keccak256(abi.encode(account))))", () => {
    const t = promoterTree(["0x00000000000000000000000000000000000000aa"]);
    const inner = keccak256(encodeAbiParameters([{ type: "address" }], ["0x00000000000000000000000000000000000000aa"]));
    expect(t.root).toBe(keccak256(inner)); // single leaf: root == leaf
  });
});

describe("curve mirror", () => {
  it("first NFT ~0.000526 BNB, sell-out raises ~20 BNB, last NFT ~0.0076 BNB", () => {
    const first = quoteBuy(VIRTUAL_BNB0, VIRTUAL_TOKEN0, 1);
    expect(Number(first.cost) / 1e18).toBeCloseTo(0.000526, 5);
    const all = quoteBuy(VIRTUAL_BNB0, VIRTUAL_TOKEN0, 10_000);
    expect(Number(all.cost) / 1e18).toBeCloseTo(20, 6);
    const before = quoteBuy(VIRTUAL_BNB0, VIRTUAL_TOKEN0, 9_999);
    const last = quoteBuy(before.newX, before.newY, 1);
    expect(Number(last.cost) / 1e18).toBeCloseTo(0.0076, 4);
    const back = quoteSell(first.newX, first.newY, 1);
    expect(back.gross).toBeLessThanOrEqual(first.cost);
    expect(nftPrice(VIRTUAL_BNB0, VIRTUAL_TOKEN0)).toBe((VIRTUAL_BNB0 * TOKENS_PER_NFT) / VIRTUAL_TOKEN0);
  });
});

describe("utils", () => {
  it("parses tweet urls", () => {
    expect(parseTweetId("https://x.com/abc/status/1234567890123")).toBe("1234567890123");
    expect(parseTweetId("https://twitter.com/abc/status/1234567890123?s=20")).toBe("1234567890123");
    expect(parseTweetId("1234567890123")).toBe("1234567890123");
    expect(parseTweetId("https://x.com/abc")).toBeNull();
  });
  it("handle hash = keccak256(lowercase handle without @)", () => {
    expect(handleHash("@Alice_Bot")).toBe(keccak256(toBytes("alice_bot")));
    expect(normHandle(" @ABC ")).toBe("abc");
  });
  it("deterministic codes and tags", () => {
    expect(hmacCode("s", ["a", "b"])).toBe(hmacCode("s", ["a", "b"]));
    expect(hmacCode("s", ["a", "b"])).not.toBe(hmacCode("s", ["a", "c"]));
    expect(projectTag("ag-c$")).toBe("#AP_AGC");
  });
});
