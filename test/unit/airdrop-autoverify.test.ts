/** Airdrop auto-approval: submitted post must quote / reply to the pinned post (FxTwitter via mock), sweep retry, admin test-approve. */
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
import { airdropVerifySweep } from "../../src/services/airdrop.js";

const PINNED = "2115430735167607129";
const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const TOKEN = "test-admin-token";
let database: Database;
let app: FastifyInstance;
let ctx: AppContext;
let dbFile: string;
let ip = 0;
let seq = 0;
const resolver = new MockAgentIdResolver();
const x = new MockXProvider();
let xDown = false;
const realGetPost = x.getPost.bind(x);
x.getPost = async (id: string) => {
  if (xDown) throw new Error("fxtwitter HTTP 503 (after 4 attempts)");
  return realGetPost(id);
};

/** new user + wallet + .ai; returns body builder */
const actor = (handle: string) => {
  const n = ++seq;
  const wallet = A(0xb000 + n);
  const agentName = `bot${n}x.ai`;
  resolver.set(agentName, wallet as any);
  x.addUser({ username: handle });
  return { handle, wallet, agentName };
};
const claim = async (body: Record<string, string>) => {
  const r = await app.inject({ method: "POST", url: "/v1/airdrop/claim", payload: body, headers: { "x-forwarded-for": `10.9.0.${++ip}` } });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};
const status = async (wallet: string) => JSON.parse((await app.inject({ method: "GET", url: `/v1/airdrop/status?wallet=${wallet}` })).body);

beforeAll(async () => {
  dbFile = path.join(os.tmpdir(), `agentpad-airdrop-auto-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  database = await openDatabase(`file:${dbFile}`);
  x.addUser({ username: "ChyAI_Official" });
  x.addPost({ id: PINNED, authorUsername: "ChyAI_Official", text: "pinned" });
  ctx = {
    cfg: loadConfig({ NODE_ENV: "test", ADMIN_TOKEN: TOKEN, AIRDROP_PINNED_TWEET_ID: PINNED, AIRDROP_AUTO_APPROVE: "true" }),
    database, resolver, x, bus: new EventEmitter(), log: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as AppContext;
  app = await buildServer(ctx);
});
afterAll(async () => {
  await app?.close();
  await database?.close();
  for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true });
});

describe("airdrop auto-approval", () => {
  it("quote of the pinned post -> approved immediately", async () => {
    const a = actor("QuoteUser");
    const p = x.addPost({ authorUsername: "QuoteUser", text: "joining ChyAI", quoteOfId: PINNED });
    const r = await claim({ xHandle: "@QuoteUser", wallet: a.wallet, agentName: a.agentName, repostUrl: x.url(p) });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "approved", reason: "auto_quote" });
    expect((await status(a.wallet)).status).toBe("approved");
  });
  it("reply to the pinned post -> approved", async () => {
    const a = actor("ReplyUser");
    const p = x.addPost({ authorUsername: "ReplyUser", text: "gm", replyToId: PINNED });
    const r = await claim({ xHandle: "replyuser", wallet: a.wallet, agentName: a.agentName, repostUrl: `https://x.com/i/status/${p.id}` });
    expect(r.body).toMatchObject({ status: "approved", reason: "auto_reply" });
  });
  it("post not referencing the pinned post -> 422 Chinese error, nothing stored", async () => {
    const a = actor("OtherUser");
    const p = x.addPost({ authorUsername: "OtherUser", text: "random", quoteOfId: "999" });
    const r = await claim({ xHandle: "OtherUser", wallet: a.wallet, agentName: a.agentName, repostUrl: x.url(p) });
    expect(r.status).toBe(422);
    expect(r.body.error?.code ?? r.body.code).toBe("repost_not_referencing_pinned");
    expect(JSON.stringify(r.body)).toMatch(/置顶帖/);
    expect((await status(a.wallet)).claimed).toBe(false);
  });
  it("plain retweet / pinned post itself / wrong author -> 422", async () => {
    const a = actor("RtUser");
    const rt = x.addPost({ authorUsername: "RtUser", text: "", isRepost: true });
    expect((await claim({ xHandle: "RtUser", wallet: a.wallet, agentName: a.agentName, repostUrl: x.url(rt) })).status).toBe(422);
    expect((await claim({ xHandle: "RtUser", wallet: a.wallet, agentName: a.agentName, repostUrl: `https://x.com/i/status/${PINNED}` })).status).toBe(422);
    const b = actor("Thief");
    const theirs = x.addPost({ authorUsername: "QuoteUser", text: "q", quoteOfId: PINNED });
    const r = await claim({ xHandle: "Thief", wallet: b.wallet, agentName: b.agentName, repostUrl: `https://x.com/i/status/${theirs.id}` });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toMatch(/QuoteUser/);
  });
  it("FxTwitter down -> pending x_unavailable; sweep approves once it is back", async () => {
    const a = actor("LateUser");
    const p = x.addPost({ authorUsername: "LateUser", text: "q", quoteOfId: PINNED });
    xDown = true;
    const r = await claim({ xHandle: "LateUser", wallet: a.wallet, agentName: a.agentName, repostUrl: x.url(p) });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "pending_verification", reason: "x_unavailable" });
    expect(r.body.message).toMatch(/10 分钟/);
    let s = await airdropVerifySweep(ctx);
    expect(s.stillPending).toBeGreaterThanOrEqual(1);
    xDown = false;
    s = await airdropVerifySweep(ctx);
    expect(s.approved).toBe(1);
    expect((await status(a.wallet))).toMatchObject({ status: "approved", reason: "auto_quote" });
  });
  it("post not visible yet -> pending post_not_found; sweep rejects if it turns out unrelated", async () => {
    const a = actor("GhostUser");
    const r = await claim({ xHandle: "GhostUser", wallet: a.wallet, agentName: a.agentName, repostUrl: "https://x.com/GhostUser/status/1888000000000000001" });
    expect(r.body).toMatchObject({ status: "pending_verification", reason: "post_not_found" });
    x.addPost({ id: "1888000000000000001", authorUsername: "GhostUser", text: "unrelated" });
    const s = await airdropVerifySweep(ctx);
    expect(s.rejected).toBe(1);
    expect((await status(a.wallet))).toMatchObject({ status: "rejected", reason: "not_referencing_pinned" });
  });
});

describe("admin test-approve", () => {
  const post = (payload: unknown, auth = true) =>
    app.inject({ method: "POST", url: "/v1/admin/airdrop/test-approve", payload: payload as any, headers: auth ? { authorization: `Bearer ${TOKEN}` } : {} });
  it("requires admin token", async () => {
    expect((await post({ xHandle: "t1", wallet: A(1), aiName: "x.ai" }, false)).statusCode).toBe(401);
  });
  it("still checks .ai on-chain; creates approved claim without X post", async () => {
    const wallet = A(0xc0ffee);
    resolver.set("testerbot.ai", wallet as any);
    expect((await post({ xHandle: "tester", wallet, aiName: "nobody123.ai" })).statusCode).toBe(422);
    expect((await post({ xHandle: "tester", wallet: A(0xdead), aiName: "testerbot.ai" })).statusCode).toBe(422);
    const r = await post({ xHandle: "@Tester", wallet, aiName: "testerbot" });
    expect(r.statusCode).toBe(201);
    expect(JSON.parse(r.body)).toMatchObject({ status: "approved", reason: "admin_test", xHandle: "tester", agentId: "testerbot.ai" });
    expect((await status(wallet))).toMatchObject({ status: "approved", reason: "admin_test" });
    expect((await post({ xHandle: "tester2", wallet, aiName: "testerbot.ai" })).statusCode).toBe(409);
  });
});
