/** Repeat submissions (多次提交): same wallet + X handle + .ai is idempotent (200, existing claim), a pending/rejected
 *  claim is re-verified with the new link, double submits never 409/429 the same person; agent flow + agent.md routes. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { openDatabase, type Database } from "../../src/db/index.js";
import { loadConfig } from "../../src/config.js";
import { buildServer } from "../../src/api/server.js";
import type { AppContext } from "../../src/context.js";
import { MockAgentIdResolver } from "../../src/providers/agentid/index.js";
import { MockXProvider } from "../../src/providers/x/mock.js";
import { agentMarkdown, agentPrompt } from "../../src/api/routes/agentflow.js";
import { agentCard, llmsTxt } from "../../src/api/routes/discovery.js";
import { bawContractCall } from "../../src/services/credential.js";
import { bawCheckin } from "../../src/services/mining.js";

const PINNED = "2115430735167607129";
const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
let database: Database;
let app: FastifyInstance;
let dbFile: string;
let seq = 0;
const resolver = new MockAgentIdResolver();
const x = new MockXProvider();
let xDown = false;
const realGetPost = x.getPost.bind(x);
x.getPost = async (id: string) => {
  if (xDown) throw new Error("fxtwitter HTTP 503");
  return realGetPost(id);
};
const actor = (handle: string) => {
  const n = ++seq;
  const wallet = A(0xc000 + n);
  const agentName = `idem${n}x.ai`;
  resolver.set(agentName, wallet as any);
  x.addUser({ username: handle });
  return { handle, wallet, agentName };
};
const claim = async (body: Record<string, string>, ip = "10.7.7.7") => {
  const r = await app.inject({ method: "POST", url: "/v1/airdrop/claim", payload: body, headers: { "x-forwarded-for": ip } });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};
const stats = async () => JSON.parse((await app.inject({ method: "GET", url: "/v1/airdrop/stats" })).body).claimed;

beforeAll(async () => {
  dbFile = path.join(os.tmpdir(), `agentpad-airdrop-idem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  database = await openDatabase(`file:${dbFile}`);
  x.addUser({ username: "ChyAI_Official" });
  x.addPost({ id: PINNED, authorUsername: "ChyAI_Official", text: "pinned" });
  const ctx = {
    cfg: loadConfig({ NODE_ENV: "test", ADMIN_TOKEN: "t", AIRDROP_PINNED_TWEET_ID: PINNED, AIRDROP_AUTO_APPROVE: "true" }),
    database, resolver, x, bus: new EventEmitter(), log: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as AppContext;
  app = await buildServer(ctx);
});
afterAll(async () => {
  await app?.close();
  await database?.close();
  for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true });
});

describe("repeat airdrop submissions", () => {
  it("approved claim submitted again (any case / @ form) -> 200 existing, same id, next=mint, count unchanged", async () => {
    const a = actor("RepeatUser");
    const p = x.addPost({ authorUsername: "RepeatUser", text: "in", quoteOfId: PINNED });
    const body = { xHandle: "RepeatUser", wallet: a.wallet, agentName: a.agentName, repostUrl: x.url(p) };
    const first = await claim(body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: "approved", existing: false, next: "mint" });
    const n = await stats();
    for (const b of [body, { ...body, xHandle: "@repeatuser", wallet: a.wallet.toUpperCase().replace("0X", "0x"), agentName: a.agentName.toUpperCase() }]) {
      const again = await claim(b);
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.body).toMatchObject({ id: first.body.id, status: "approved", existing: true, next: "mint" });
    }
    expect(await stats()).toBe(n);
  });
  it("many repeats from one IP never hit the rate limit (idempotent repeats are refunded)", async () => {
    const a = actor("SpamClick");
    const p = x.addPost({ authorUsername: "SpamClick", text: "in", replyToId: PINNED });
    const body = { xHandle: "SpamClick", wallet: a.wallet, agentName: a.agentName, repostUrl: x.url(p) };
    const codes: number[] = [];
    for (let i = 0; i < 15; i++) codes.push((await claim(body, "10.66.66.66")).status);
    expect(codes[0]).toBe(201);
    expect(codes.slice(1).every((c) => c === 200)).toBe(true);
  });
  it("concurrent double submit -> one 201 + one 200 with the same id", async () => {
    const a = actor("DoubleTap");
    const p = x.addPost({ authorUsername: "DoubleTap", text: "in", quoteOfId: PINNED });
    const body = { xHandle: "DoubleTap", wallet: a.wallet, agentName: a.agentName, repostUrl: x.url(p) };
    const [r1, r2] = await Promise.all([claim(body, "10.1.1.1"), claim(body, "10.1.1.2")]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    expect(r1.body.id).toBe(r2.body.id);
  });
  it("pending claim (X down) re-submitted when X is back -> approved, existing", async () => {
    const a = actor("LaterUser");
    const p = x.addPost({ authorUsername: "LaterUser", text: "in", quoteOfId: PINNED });
    const body = { xHandle: "LaterUser", wallet: a.wallet, agentName: a.agentName, repostUrl: x.url(p) };
    xDown = true;
    const first = await claim(body);
    xDown = false;
    expect(first.body).toMatchObject({ status: "pending_verification", next: "wait" });
    const again = await claim(body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, status: "approved", existing: true, next: "mint" });
  });
  it("pending claim re-submitted with a link that does not reference the pinned post -> 422, claim unchanged", async () => {
    const a = actor("WrongLink");
    const good = x.addPost({ authorUsername: "WrongLink", text: "in", quoteOfId: PINNED });
    const bad = x.addPost({ authorUsername: "WrongLink", text: "unrelated" });
    xDown = true;
    await claim({ xHandle: "WrongLink", wallet: a.wallet, agentName: a.agentName, repostUrl: x.url(good) });
    xDown = false;
    const r = await claim({ xHandle: "WrongLink", wallet: a.wallet, agentName: a.agentName, repostUrl: x.url(bad) });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("repost_not_referencing_pinned");
    const st = JSON.parse((await app.inject({ method: "GET", url: `/v1/airdrop/status?wallet=${a.wallet}` })).body);
    expect(st.status).toBe("pending_verification");
  });
  it("same wallet with a different X handle -> 409 wallet_already_claimed with the claim status", async () => {
    const a = actor("OwnerOne");
    const p = x.addPost({ authorUsername: "OwnerOne", text: "in", quoteOfId: PINNED });
    await claim({ xHandle: "OwnerOne", wallet: a.wallet, agentName: a.agentName, repostUrl: x.url(p) });
    x.addUser({ username: "OtherHandle" });
    const q = x.addPost({ authorUsername: "OtherHandle", text: "in", quoteOfId: PINNED });
    const r = await claim({ xHandle: "OtherHandle", wallet: a.wallet, agentName: a.agentName, repostUrl: x.url(q) });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "wallet_already_claimed", details: { status: "approved" } });
  });
});

describe("agent discovery: /llms.txt + /.well-known/agent.json", () => {
  it("serves llms.txt as text/plain with agent.md, airdrop link, API base and disclaimers", async () => {
    const r = await app.inject({ method: "GET", url: "/llms.txt", headers: { host: "api.example.com" } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/plain");
    expect(r.body.startsWith("# ChyAI")).toBe(true);
    expect(r.body).toContain("https://api.example.com/agent.md");
    expect(r.body).toContain("https://api.example.com/v1/agent/flow?wallet=");
    expect(r.body).toContain("https://chyai.onrender.com/#/airdrop");
    expect(r.body).toContain("independent, not affiliated with Binance");
    expect(r.body).toContain("not audited");
    expect(r.body).not.toMatch(/guaranteed|100x/i);
  });
  it("serves the agent card (both well-known names) with skills and endpoints", async () => {
    for (const url of ["/.well-known/agent.json", "/.well-known/agent-card.json"]) {
      const r = await app.inject({ method: "GET", url, headers: { host: "api.example.com" } });
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toContain("application/json");
      const c = JSON.parse(r.body);
      expect(c.name).toBe("ChyAI");
      expect(c.documentationUrl).toBe("https://api.example.com/agent.md");
      expect(c.url).toBe("https://api.example.com/v1");
      expect(c.skills.map((s: any) => s.id)).toEqual(["claim-airdrop", "mint-credential", "mine", "check-in", "launch"]);
      expect(c.endpoints.agentFlow.url).toContain("/v1/agent/flow?wallet=");
      expect(c.disclaimer).toContain("not affiliated with Binance");
    }
  });
  it("defaults point at the public hosts (used for the static site copies)", () => {
    expect(llmsTxt()).toContain("https://agentpad-api.onrender.com/agent.md");
    expect(agentCard().instructions.llmsTxt).toBe("https://chyai.onrender.com/llms.txt");
  });
});

describe("agent one-command flow", () => {
  it("serves /agent.md (and /v1/agent.md) as markdown with the exact baw flags", async () => {
    for (const url of ["/agent.md", "/v1/agent.md"]) {
      const r = await app.inject({ method: "GET", url, headers: { host: "api.example.com" } });
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toContain("text/markdown");
      expect(r.body).toContain("https://api.example.com/v1/airdrop/claim");
      expect(r.body).toContain("--inputData");
      expect(r.body).toContain("--from <WALLET>");
      expect(r.body).toContain("Approved ≠ credential");
    }
    expect(agentMarkdown("https://h", 56)).not.toMatch(/--data /);
    expect(agentPrompt("https://h")).toContain("https://h/agent.md");
  });
  it("/v1/agent/flow: unknown wallet -> x_post / apply todo; approved wallet -> next mint_credential", async () => {
    const fresh = JSON.parse((await app.inject({ method: "GET", url: `/v1/agent/flow?wallet=${A(0xdead1)}` })).body);
    expect(fresh.next).toBe("x_post");
    expect(fresh.steps.map((s: any) => s.id)).toEqual(["x_post", "apply", "mint_credential", "mining", "daily_checkin"]);
    const a = actor("FlowUser");
    const p = x.addPost({ authorUsername: "FlowUser", text: "in", quoteOfId: PINNED });
    await claim({ xHandle: "FlowUser", wallet: a.wallet, agentName: a.agentName, repostUrl: x.url(p) });
    const f = JSON.parse((await app.inject({ method: "GET", url: `/v1/agent/flow?wallet=${a.wallet}` })).body);
    expect(f.steps.find((s: any) => s.id === "apply").state).toBe("done");
    expect(f.next).toBe("mint_credential"); // no credential contract configured in this test → blocked, still the next step
    expect(f.steps.find((s: any) => s.id === "mining")).toMatchObject({ state: "waiting", detail: "未 mint 凭证 → 不挖矿" });
    expect(f.agentName).toBe(a.agentName);
  });
  it("baw command builders use the official flags", () => {
    const w = "0x866396d4aee9467b67194431bdbDdE8E8044d8AE";
    expect(bawContractCall(56, w, "0x171C8cc26FcE4E34e21A883FCfcc85e835C11768", "0xabcd")).toBe(
      `baw contract-call preview --binanceChainId 56 --from ${w} --to 0x171C8cc26FcE4E34e21A883FCfcc85e835C11768 --value 0 --inputData 0xabcd --json`,
    );
    const c = bawCheckin(w, "2026-10-29", 56);
    const msg = JSON.parse(c.message);
    expect(msg.method).toBe("eth_signTypedData_v4");
    expect(typeof msg.params[1]).toBe("string"); // typed data as a JSON string, per the baw skill
    expect(JSON.parse(msg.params[1]).message.day).toBe("2026-10-29");
    expect(c.preview.startsWith("baw sign-message preview --binanceChainId 56 --signType EIP712 --message '")).toBe(true);
  });
});
