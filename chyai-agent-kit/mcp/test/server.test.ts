import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { buildClaimPayload, ChyAIClient } from "../src/api.js";

const W = "0x" + "ab".repeat(20);

function fakeFetch(seen: string[]) {
  return (async (url: string) => {
    seen.push(url);
    const path = url.replace("https://api.test", "");
    if (path === "/agent.md") return new Response("# ChyAI agent flow", { status: 200, headers: { "content-type": "text/markdown" } });
    if (path === "/llms.txt") return new Response("# ChyAI\n> agent-only", { status: 200, headers: { "content-type": "text/plain" } });
    if (path.startsWith("/v1/mining/leaderboard"))
      return Response.json({ items: [{ rank: 1 }, { rank: 2 }, { rank: 3 }] });
    if (path.startsWith("/v1/airdrop/status")) return Response.json({ error: { code: "not_found", message: "no claim" } }, { status: 404 });
    return Response.json({ path });
  }) as unknown as typeof fetch;
}

async function connect(seen: string[]) {
  const server = createServer({ apiRoot: "https://api.test/v1/", fetch: fakeFetch(seen) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const text = (r: any) => r.content[0].text as string;

describe("chyai MCP server", () => {
  it("lists the read-only tools, resources and prompt", async () => {
    const c = await connect([]);
    const tools = (await c.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "chyai_agent_flow", "chyai_airdrop_status", "chyai_build_claim_payload", "chyai_get_agent_instructions", "chyai_get_config",
      "chyai_get_mint_voucher", "chyai_invites", "chyai_mining_leaderboard", "chyai_mining_stats", "chyai_mining_status", "chyai_rewards_proof",
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    expect(JSON.stringify(tools)).not.toMatch(/sendRawTransaction|privateKey/);
    expect((await c.listResources()).resources.map((r) => r.uri).sort()).toEqual(["chyai://agent.md", "chyai://llms.txt"]);
    expect((await c.listPrompts()).prompts.map((p) => p.name)).toEqual(["chyai_airdrop"]);
  });

  it("maps tools to the public API paths (root normalised, /v1 stripped)", async () => {
    const seen: string[] = [];
    const c = await connect(seen);
    await c.callTool({ name: "chyai_get_config", arguments: {} });
    await c.callTool({ name: "chyai_agent_flow", arguments: { wallet: W } });
    await c.callTool({ name: "chyai_get_mint_voucher", arguments: { wallet: W } });
    await c.callTool({ name: "chyai_mining_status", arguments: { wallet: W } });
    await c.callTool({ name: "chyai_mining_stats", arguments: {} });
    await c.callTool({ name: "chyai_invites", arguments: { wallet: W } });
    await c.callTool({ name: "chyai_rewards_proof", arguments: { wallet: W } });
    expect(seen.map((u) => u.replace("https://api.test", ""))).toEqual([
      "/v1/config", `/v1/agent/flow?wallet=${W}`, `/v1/airdrop/voucher?wallet=${W}`, `/v1/mining/${W}`, "/v1/mining/stats", `/v1/airdrop/invites/${W}`, `/v1/rewards/${W}/proof`,
    ]);
  });

  it("returns agent.md as text and honours leaderboard limit", async () => {
    const c = await connect([]);
    expect(text(await c.callTool({ name: "chyai_get_agent_instructions", arguments: {} }))).toBe("# ChyAI agent flow");
    const lb = JSON.parse(text(await c.callTool({ name: "chyai_mining_leaderboard", arguments: { limit: 2 } })));
    expect(lb.items).toHaveLength(2);
    const res = await c.readResource({ uri: "chyai://llms.txt" });
    expect((res.contents[0] as any).text).toContain("agent-only");
  });

  it("surfaces API errors as tool errors and rejects bad wallets", async () => {
    const c = await connect([]);
    const r: any = await c.callTool({ name: "chyai_airdrop_status", arguments: { wallet: W } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("404 not_found");
    const bad: any = await c.callTool({ name: "chyai_agent_flow", arguments: { wallet: "0x123" } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
    expect(bad.isError).toBe(true);
  });

  it("builds (does not send) the claim payload", async () => {
    const seen: string[] = [];
    const c = await connect(seen);
    const r = JSON.parse(text(await c.callTool({
      name: "chyai_build_claim_payload",
      arguments: { xHandle: "@Alice_1", wallet: W, agentName: "Alice.AI", repostUrl: "https://x.com/Alice_1/status/1234567890", ref: "bob.ai" },
    })));
    expect(r.body).toEqual({ xHandle: "Alice_1", wallet: W, agentName: "alice.ai", repostUrl: "https://x.com/Alice_1/status/1234567890", ref: "bob.ai" });
    expect(r.url).toBe("https://api.test/v1/airdrop/claim");
    expect(r.curl).toContain("curl -s -X POST https://api.test/v1/airdrop/claim");
    expect(r.note).toContain("not affiliated with Binance");
    expect(seen).toEqual([]);
    const bad: any = await c.callTool({ name: "chyai_build_claim_payload", arguments: { xHandle: "a", wallet: W, agentName: "a.eth", repostUrl: "https://x.com/a/status/123456" } });
    expect(bad.isError).toBe(true);
  });

  it("prompt embeds agent.md and the user's inputs", async () => {
    const c = await connect([]);
    const p = await c.getPrompt({ name: "chyai_airdrop", arguments: { xHandle: "alice", repostUrl: "https://x.com/alice/status/1" } });
    const t = (p.messages[0]!.content as any).text as string;
    expect(t).toContain("https://api.test/agent.md");
    expect(t).toContain("wait for my yes");
  });
});

describe("helpers", () => {
  it("buildClaimPayload validation", () => {
    expect(() => buildClaimPayload({ xHandle: "a", wallet: "0x1", agentName: "a.ai", repostUrl: "https://x.com/a/status/123456" })).toThrow(/wallet/);
    expect(() => buildClaimPayload({ xHandle: "a", wallet: W, agentName: "a.ai", repostUrl: "https://example.com/a/status/123456" })).toThrow(/repostUrl/);
  });
  it("client default root", () => {
    expect(new ChyAIClient().v1).toBe("https://agentpad-api.onrender.com/v1");
  });
});
