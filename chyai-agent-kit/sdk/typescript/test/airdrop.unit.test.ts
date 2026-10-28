import { describe, expect, it } from "vitest";
import { AgentPadApi, buildAirdropClaim } from "../src/api.js";

const W = "0x" + "ab".repeat(20);
const cap = (status = 200, body: unknown = { ok: true }, text?: string) => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(text ?? JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { seen, api: new AgentPadApi({ fetch: f }) };
};

describe("ChyAI airdrop/mining client", () => {
  it("buildAirdropClaim normalises handle/name and validates inputs", () => {
    expect(buildAirdropClaim({ xHandle: "@Alice_1", wallet: W, agentName: "Bob.AI", repostUrl: "https://x.com/Alice_1/status/123456789" })).toEqual({
      xHandle: "Alice_1", wallet: W, agentName: "bob.ai", repostUrl: "https://x.com/Alice_1/status/123456789",
    });
    expect(buildAirdropClaim({ xHandle: "a", wallet: W, agentName: "b.ai", repostUrl: "https://x.com/a/status/123456789", ref: " c.ai " }).ref).toBe("c.ai");
    expect(() => buildAirdropClaim({ xHandle: "a", wallet: "0x12", agentName: "b.ai", repostUrl: "https://x.com/a/status/123456789" })).toThrow(/wallet/);
    expect(() => buildAirdropClaim({ xHandle: "a", wallet: W, agentName: "b.eth", repostUrl: "https://x.com/a/status/123456789" })).toThrow(/\.ai/);
    expect(() => buildAirdropClaim({ xHandle: "a", wallet: W, agentName: "b.ai", repostUrl: "123456789" })).toThrow(/status link/);
  });
  it("hits the right /v1 paths", async () => {
    const { seen, api } = cap();
    await api.config();
    await api.agentFlow(W);
    await api.airdropStatus(W);
    await api.mintVoucher(W);
    await api.mining(W);
    await api.miningStats();
    await api.miningLeaderboard();
    await api.invites(W);
    expect(seen.map((s) => s.url.replace("https://agentpad-api.onrender.com/v1", ""))).toEqual([
      "/config", `/agent/flow?wallet=${W}`, `/airdrop/status?wallet=${W}`, `/airdrop/voucher?wallet=${W}`, `/mining/${W}`, "/mining/stats", "/mining/leaderboard", `/airdrop/invites/${W}`,
    ]);
  });
  it("airdropClaim POSTs the validated body; checkin returns 409 as a value", async () => {
    const { seen, api } = cap(409, { error: { code: "already_checked_in" } });
    expect((await api.checkin({ wallet: W, signature: "0x01" })).error.code).toBe("already_checked_in");
    expect(JSON.parse(String(seen[0]!.init!.body))).toEqual({ signType: "eip712", wallet: W, signature: "0x01" });
    const c = cap(201, { status: "approved" });
    await c.api.airdropClaim({ xHandle: "@a", wallet: W, agentName: "b.ai", repostUrl: "https://x.com/a/status/123456789" });
    expect(c.seen[0]!.url).toMatch(/\/v1\/airdrop\/claim$/);
    expect(JSON.parse(String(c.seen[0]!.init!.body)).xHandle).toBe("a");
  });
  it("agentInstructions returns the markdown text", async () => {
    const { api } = cap(200, undefined, "# ChyAI agent flow");
    expect(await api.agentInstructions()).toBe("# ChyAI agent flow");
  });
});
