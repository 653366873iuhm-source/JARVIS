import { describe, expect, it } from "vitest";
import { toProjectSummary, toTrade, promotionStage, spotPriceWei, DEFAULT_FEE_BPS, type ProjectRowLike, type TradeRowLike } from "../../src/api/mappers.js";
import { decodeCursor, encodeCursor, SORT_ALIASES } from "../../src/services/market.js";
import { VIRTUAL_BNB0, VIRTUAL_TOKEN0, TOTAL_SUPPLY_TOKENS, nftPrice } from "../../src/lib/curve.js";

const row = (o: Partial<ProjectRowLike> = {}): ProjectRowLike => ({
  address: "0x" + "11".repeat(20), token: "0x" + "22".repeat(20), launcher: "0x" + "33".repeat(20), name: "Agent Coin", symbol: "AGC",
  baseUri: "ipfs://cid/", idx: 7, tag: "#AP_AGC", createdAt: 1_000, createdBlock: 42, phase: 0,
  virtualBnb: VIRTUAL_BNB0.toString(), virtualToken: VIRTUAL_TOKEN0.toString(), reserveBnb: "0", sold: 2_500, supply: 2_500,
  priceWei: nftPrice(VIRTUAL_BNB0, VIRTUAL_TOKEN0).toString(), volumeWei: "123", tradeCount: 9, lastTradeAt: 1_500,
  promotionStart: null, graduatedAt: null, forced: null, pair: null, promoterRoot: null, lastShareBps: null, ...o,
});
const agg = { vol24: 10n ** 18n, trades24: 4, holders: 3, change24Bps: -120 };

describe("project mapper", () => {
  it("renames to the client field names, uint256 as decimal strings", () => {
    const s = toProjectSummary(row(), agg, { launcherAgentId: "nova.ai", launchTx: "0xabc", now: 2_000 });
    expect(s).toMatchObject({
      baseURI: "ipfs://cid/", index: 7, launchedAt: 1_000, launchBlock: "42", launchTx: "0xabc", phase: "trading", promotionStage: 0,
      totalSupply: "2500", reserveBnb: "0", feeBps: DEFAULT_FEE_BPS, progressBps: 2_500, holders: 3, volumeBnb24h: "1000000000000000000",
      change24hBps: -120, trades24h: 4, launcherAgentId: "nova.ai", story: null, image: null, collectionUri: "ipfs://cid/collection.json",
      updatedAt: 1_500,
    });
    expect(s.spotPriceWei).toBe(((VIRTUAL_BNB0 * 10n ** 18n) / VIRTUAL_TOKEN0).toString());
    expect(s.marketCapBnb).toBe(((VIRTUAL_BNB0 * TOTAL_SUPPLY_TOKENS) / VIRTUAL_TOKEN0).toString());
    for (const k of ["createdAt", "baseUri", "tokenPriceWei", "priceWei", "reserveWei", "volume24hWei", "priceChange24hBps", "marketCapWei", "sold", "launcherHoldings"]) {
      expect(s).not.toHaveProperty(k);
    }
    expect(typeof s.totalSupply).toBe("string");
  });
  it("progress caps at 100%, phase names", () => {
    expect(toProjectSummary(row({ sold: 12_000, phase: 1, promotionStart: 1_900 }), agg, { launcherAgentId: null, launchTx: null, now: 2_000 })).toMatchObject({ progressBps: 10_000, phase: "promotion", promotionStage: 1 });
    expect(toProjectSummary(row({ phase: 2, graduatedAt: 3_000 }), agg, { launcherAgentId: null, launchTx: null, now: 4_000 })).toMatchObject({ phase: "graduated", promotionStage: 4, updatedAt: 3_000 });
  });
  it("promotionStage follows BondingNFT.promotionStage()", () => {
    expect(promotionStage({ phase: 0, promotionStart: null }, 0)).toBe(0);
    expect(promotionStage({ phase: 1, promotionStart: 100 }, 100)).toBe(1);
    expect(promotionStage({ phase: 1, promotionStart: 100 }, 100 + 3599)).toBe(1);
    expect(promotionStage({ phase: 1, promotionStart: 100 }, 100 + 3600)).toBe(2);
    expect(promotionStage({ phase: 1, promotionStart: 100 }, 100 + 7199)).toBe(2);
    expect(promotionStage({ phase: 1, promotionStart: 100 }, 100 + 7200)).toBe(3);
    expect(promotionStage({ phase: 2, promotionStart: 100 }, 0)).toBe(4);
  });
  it("spot price is wei per whole token", () => {
    expect(spotPriceWei("2", "1000000000000000000")).toBe(2n);
  });
});

describe("trade mapper", () => {
  const tr = (o: Partial<TradeRowLike> = {}): TradeRowLike => ({
    id: "0xaa:3", project: "0xp", trader: "0xw", side: "buy", count: 5, bnbWei: "100", feeWei: "1", priceWei: "9",
    firstTokenId: 11, blockNumber: 77, logIndex: 3, txHash: "0xaa", ts: 1_234, ...o,
  });
  it("buy/sell -> mint/burn, trader -> wallet, txHash -> tx, ts -> at", () => {
    expect(toTrade(tr(), { agentId: "nova.ai", name: "N", symbol: "S" })).toEqual({
      id: "0xaa:3", tx: "0xaa", project: "0xp", name: "N", symbol: "S", wallet: "0xw", agentId: "nova.ai", side: "mint", count: 5,
      bnb: "100", fee: "1", at: 1_234, blockNumber: "77", logIndex: 3, firstTokenId: 11, nftPriceWei: "9", venue: "curve",
    });
    const s = toTrade(tr({ side: "sell", firstTokenId: null }));
    expect(s.side).toBe("burn");
    expect(s.agentId).toBeNull();
    expect(s).not.toHaveProperty("name");
  });
});

describe("list params", () => {
  it("cursor round-trips and accepts plain offsets", () => {
    expect(decodeCursor(encodeCursor(120))).toBe(120);
    expect(decodeCursor("60")).toBe(60);
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(() => decodeCursor("zzzz")).toThrow(/cursor/);
  });
  it("aliases client sort names", () => {
    expect(SORT_ALIASES).toEqual({ new: "created", volume: "volume24h", mcap: "marketcap" });
  });
});
