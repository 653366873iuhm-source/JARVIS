import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
  classifyVerifyError, pendingOrRejected, toPromotionCode, toQuote, buildSellTx, toRegisterRequestResponse, toRewardProofs, xPostText, regKey,
  RETRY_AFTER_SEC, PUBLIC_APP_URL, type RegRequest,
} from "../../src/api/routes/sdk.js";
import { ApiError } from "../../src/services/registration.js";
import { MAX_CURVE_NFTS, PROMOTION_MAX, VIRTUAL_BNB0, VIRTUAL_TOKEN0, quoteBuy, quoteSell } from "../../src/lib/curve.js";

const W = "0x" + "ab".repeat(20);
const P = "0x" + "cd".repeat(20);
const req = (o: Partial<RegRequest> = {}): RegRequest => ({
  requestId: "req_1", agentId: "nova.ai", wallet: W, xHandle: "nova_bot", intent: "launch", status: "awaiting_wallet_signature",
  challengeId: "c-1", issuedAt: 100, expiresAt: 1000, xCode: "AgentPad-verify-XYZ", xExpiresAt: 1000, walletVerified: false,
  walletSignature: null, tweetUrl: null, reason: null, lastXCheckAt: null, result: null, createdAt: 100, updatedAt: 100, ...o,
});

describe("register-request mapping", () => {
  it("RegisterRequestResponse shape", () => {
    const r = toRegisterRequestResponse(req());
    expect(r).toEqual({
      requestId: "req_1", agentId: "nova.ai", wallet: getAddress(W), xHandle: "nova_bot", intent: "launch", status: "awaiting_wallet_signature",
      binding: { challenge: "c-1", issuedAt: 100, expiresAt: 1000 },
      xChallenge: { code: "AgentPad-verify-XYZ", text: xPostText("nova.ai", "AgentPad-verify-XYZ"), expiresAt: 1000 },
      reason: null,
    });
    expect(r.xChallenge.text).toContain("AgentPad-verify-XYZ");
  });
  it("request key is agentId|lowercase wallet", () => {
    expect(regKey("nova.ai", getAddress(W))).toBe(`regreq:nova.ai|${W}`);
  });
  it("verify error classification", () => {
    expect(classifyVerifyError("x_post_not_found")).toBe("awaiting_x_proof");
    expect(classifyVerifyError("bad_tweet_url")).toBe("awaiting_x_proof");
    expect(classifyVerifyError("challenge_expired")).toBe("reissue");
    for (const c of ["agent_id_mismatch", "agent_id_unresolved", "agent_id_fallback", "agent_id_taken", "x_not_found", "x_handle_taken", "wallet_bound", "agent_removed"]) {
      expect(classifyVerifyError(c)).toBe("rejected");
    }
    expect(classifyVerifyError("internal_error")).toBe("rethrow");
  });
  it("registration-signature 202 / 403 bodies", () => {
    expect(pendingOrRejected(req({ status: "awaiting_x_proof", reason: "x_post_not_found: no post" }))).toEqual([
      202, { status: "pending", requestStatus: "awaiting_x_proof", retryAfter: RETRY_AFTER_SEC, reason: "x_post_not_found: no post" },
    ]);
    expect(pendingOrRejected(req({ status: "rejected", reason: "agent_id_mismatch: nope" }))).toEqual([403, { status: "rejected", reason: "agent_id_mismatch: nope" }]);
    expect(pendingOrRejected(req({ status: "rejected" }))[1]).toEqual({ status: "rejected", reason: "rejected" });
  });
});

describe("quote", () => {
  const s = { virtualBnb: VIRTUAL_BNB0, virtualToken: VIRTUAL_TOKEN0, totalSupply: 0n, feeBps: 100 };
  it("mint: amount = cost, total = cost + fee, decimal strings, pinned block", () => {
    const q = toQuote(P, "mint", 10, 77n, s);
    const ref = quoteBuy(VIRTUAL_BNB0, VIRTUAL_TOKEN0, 10, 100n);
    expect(q).toEqual({
      project: getAddress(P), side: "mint", count: 10, amount: ref.cost.toString(), fee: ref.fee.toString(), total: ref.total.toString(), blockNumber: "77",
      state: { virtualBnb: VIRTUAL_BNB0.toString(), virtualToken: VIRTUAL_TOKEN0.toString(), totalSupply: "0", feeBps: 100 },
    });
    expect(BigInt(q.total)).toBe(BigInt(q.amount) + BigInt(q.fee));
  });
  it("burn: amount = gross, total = net", () => {
    const st = { ...s, totalSupply: 50n };
    const q = toQuote(P, "burn", 5, 1n, st);
    const ref = quoteSell(VIRTUAL_BNB0, VIRTUAL_TOKEN0, 5, 100n);
    expect(q.amount).toBe(ref.gross.toString());
    expect(q.total).toBe(ref.net.toString());
    expect(BigInt(q.total)).toBe(BigInt(q.amount) - BigInt(q.fee));
  });
  it("400 bad_amount on zero, non-integer, over remaining / over supply", () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        return [(e as ApiError).status, (e as ApiError).code];
      }
      return null;
    };
    expect(code(() => toQuote(P, "mint", 0, 1n, s))).toEqual([400, "bad_amount"]);
    expect(code(() => toQuote(P, "mint", 1.5, 1n, s))).toEqual([400, "bad_amount"]);
    expect(code(() => toQuote(P, "mint", MAX_CURVE_NFTS - 9, 1n, { ...s, totalSupply: 10n }))).toEqual([400, "bad_amount"]);
    expect(code(() => toQuote(P, "mint", MAX_CURVE_NFTS - 10, 1n, { ...s, totalSupply: 10n }))).toBeNull();
    expect(code(() => toQuote(P, "burn", 3, 1n, { ...s, totalSupply: 2n }))).toEqual([400, "bad_amount"]);
  });
});

describe("promotion code", () => {
  const p = { address: P, tag: "#AP_AGC", symbol: "AGC", promotionStart: null as number | null, graduatedAt: null as number | null };
  it("full PromotionCodeResponse; window null before promotion", () => {
    const r = toPromotionCode(p, W, "AP-ABCDEFGH", "nova_bot", 5_000);
    expect(r).toMatchObject({
      project: getAddress(P), wallet: getAddress(W), code: "AP-ABCDEFGH", tag: "#AP_AGC", cashtag: "$AGC", link: `${PUBLIC_APP_URL}/#/project/${getAddress(P)}`,
      requiredText: ["#AP_AGC", "AP-ABCDEFGH"], window: null, expiresAt: 5_000 + 86_400,
    });
    expect(Array.isArray(r.rules)).toBe(true);
    expect(r.rules.every((x) => typeof x === "string")).toBe(true);
    expect(r.rules.join(" ")).toContain("@nova_bot");
  });
  it("window = promotionStart .. forced-graduation deadline, or graduatedAt", () => {
    expect(toPromotionCode({ ...p, promotionStart: 1_000 }, W, "c", null, 1_100)).toMatchObject({ window: { opensAt: 1_000, closesAt: 1_000 + PROMOTION_MAX }, expiresAt: 1_000 + PROMOTION_MAX });
    expect(toPromotionCode({ ...p, promotionStart: 1_000, graduatedAt: 2_000 }, W, "c", null, 3_000).window).toEqual({ opensAt: 1_000, closesAt: 2_000 });
  });
});

describe("rewards proof", () => {
  it("maps rewardsFor items: epoch string, amountWei -> amount, rewardPool per item", () => {
    const pool = "0x" + "ee".repeat(20);
    const out = toRewardProofs({ rewardPool: pool, items: [{ epoch: 20_000, amountWei: "123", proof: ["0x01"], claimed: false, root: "0xroot", calldata: "0xcd" }] });
    expect(out).toEqual([{ epoch: "20000", amount: "123", proof: ["0x01"], claimed: false, rewardPool: getAddress(pool), root: "0xroot", calldata: "0xcd" }]);
  });
});

describe("sell calldata (BondingNFT v2)", () => {
  it("v2 -> sell(ids, minOut) with slippage; v1 -> burn + warning; baw command carries the calldata", async () => {
    const { decodeFunctionData } = await import("viem");
    const { BondingNFTAbi } = await import("../../src/chain/abi.js");
    const v2 = buildSellTx(P, W, 2, [7n, 3n], 1_000_000n, 100);
    expect(v2.method).toBe("sell");
    expect(v2.minOut).toBe("990000");
    expect(v2.tx).toMatchObject({ to: getAddress(P), value: "0" });
    const d = decodeFunctionData({ abi: BondingNFTAbi, data: v2.tx.data as `0x${string}` });
    expect(d.functionName).toBe("sell");
    expect(d.args).toEqual([[7n, 3n], 990000n]);
    expect(v2.baw).toContain(`--inputData ${v2.tx.data}`);
    expect(v2).not.toHaveProperty("warning");
    const v1 = buildSellTx(P, W, 1, [1n], 1000n, 0);
    expect(v1.method).toBe("burn");
    expect(v1.tx.data.slice(0, 10)).toBe("0x1ee48cc2");
    expect(v1.warning).toMatch(/351803/);
  });
});
