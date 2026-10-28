/** Airdrop invites: bind on apply (ref = inviter .ai / wallet), no self-invite, inviter must hold a credential,
 *  per-inviter cap, qualification (minted + X ≥ 30d + 7 check-in days) → +5% mining speed each (cap +50%),
 *  "my invites" + leaderboard routes, hide list, agent prompt carries ref; share links use /#/project/. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";

const active = new Set<string>();
vi.mock("../../src/services/credential.js", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    readCredential: async (_ctx: unknown, wallet: string) => {
      const on = active.has(wallet.toLowerCase());
      return { configured: true, address: "0x171C8cc26FcE4E34e21A883FCfcc85e835C11768", active: on, credit: on ? 1000 : 0, tokenId: on ? 1 : 0, used: on };
    },
  };
});

import { openDatabase, type Database } from "../../src/db/index.js";
import { loadConfig } from "../../src/config.js";
import { buildServer } from "../../src/api/server.js";
import type { AppContext } from "../../src/context.js";
import { MockAgentIdResolver } from "../../src/providers/agentid/index.js";
import { MockXProvider } from "../../src/providers/x/mock.js";
import { agentMarkdown, agentPrompt } from "../../src/api/routes/agentflow.js";
import { inviteBoostOf, normalizeRef } from "../../src/services/invites.js";
import { computeRate } from "../../src/services/mining.js";
import { projectLink } from "../../src/api/routes/sdk.js";
import { isHiddenActivity, isHiddenProject, isHiddenWallet } from "../../src/services/hidden.js";

const PINNED = "2115430735167607129";
const HIDDEN = "0x49e6fb3812fdfd67edfe17259f03ccbe59f39bce";
const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
let database: Database;
let app: FastifyInstance;
let ctx: AppContext;
let dbFile: string;
let seq = 0;
const resolver = new MockAgentIdResolver();
const x = new MockXProvider();
const now = () => Math.floor(Date.now() / 1000);

const person = (opts: { wallet?: string; xAgeDays?: number } = {}) => {
  const n = ++seq;
  const wallet = (opts.wallet ?? A(0xd000 + n)).toLowerCase();
  const handle = `inv${n}user`;
  const agentName = `inv${n}name.ai`;
  resolver.set(agentName, wallet as any);
  x.addUser({ username: handle, createdAt: now() - (opts.xAgeDays ?? 400) * 86400 });
  const post = x.addPost({ authorUsername: handle, text: "in", quoteOfId: PINNED });
  return { wallet, handle, agentName, body: { xHandle: handle, wallet, agentName, repostUrl: x.url(post) } };
};
const claim = async (body: Record<string, string>) => {
  const r = await app.inject({ method: "POST", url: "/v1/airdrop/claim", payload: body, headers: { "x-forwarded-for": `10.9.${seq}.1` } });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};
const get = async (url: string) => {
  const r = await app.inject({ method: "GET", url });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};
/** Simulate: credential minted (mining account opened) + `days` distinct check-in days. */
async function mintAndCheckin(wallet: string, days: number) {
  active.add(wallet);
  await get(`/v1/mining/${wallet}`); // opens the mining account (credential active)
  const { db, t } = ctx.database;
  for (let i = 0; i < days; i++)
    await db.insert(t.miningCheckins).values({ id: `${wallet}-${i}`, wallet, day: `2026-10-${String(i + 1).padStart(2, "0")}`, pointsE8: 0, createdAt: now() - i * 86400 });
}

beforeAll(async () => {
  dbFile = path.join(os.tmpdir(), `agentpad-invites-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  database = await openDatabase(`file:${dbFile}`);
  x.addUser({ username: "ChyAI_Official" });
  x.addPost({ id: PINNED, authorUsername: "ChyAI_Official", text: "pinned" });
  ctx = {
    cfg: loadConfig({
      NODE_ENV: "test", ADMIN_TOKEN: "t", AIRDROP_PINNED_TWEET_ID: PINNED, AIRDROP_AUTO_APPROVE: "true", INVITE_MAX_PER_INVITER: "3",
      PUBLIC_APP_URL: "https://chyai.example", MINING_ACTIVATE_SWEEP_MS: "0", EARLYBIRD_SLOTS: "0", MINING_STATS_MIN_PARTICIPANTS: "0",
    }),
    database, resolver, x, bus: new EventEmitter(), log: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as AppContext;
  app = await buildServer(ctx);
});
afterAll(async () => {
  await app?.close();
  await database?.close();
  for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true });
});

describe("airdrop invites", () => {
  it("normalizes refs; boost is +5% per qualified invitee capped at +50%", () => {
    expect(normalizeRef("Alice.AI")).toBe("alice.ai");
    expect(normalizeRef("@bob")).toBe("bob.ai");
    expect(normalizeRef("0x49E6fb3812fdfD67eDfE17259f03CcbE59f39BCE")).toBe(HIDDEN);
    expect(normalizeRef("x")).toBeNull();
    expect(normalizeRef("")).toBeNull();
    expect(inviteBoostOf(ctx.cfg, 0)).toBe(0);
    expect(inviteBoostOf(ctx.cfg, 3)).toBeCloseTo(0.15);
    expect(inviteBoostOf(ctx.cfg, 25)).toBe(0.5);
    const act = { launches: 0, volumeWei: "0", volumeBnb: 0, windowDays: 7 };
    expect(computeRate(ctx.cfg, 1000, act, 2).multiplier).toBeCloseTo(1.1);
    expect(computeRate(ctx.cfg, 1000, act, 99).inviteBoost).toBe(0.5);
  });

  it("binds on apply when the inviter holds a credential; rejects self-invite and credential-less inviters", async () => {
    const inviter = person();
    expect((await claim(inviter.body)).status).toBe(201);
    // inviter has no credential yet → no binding, but the claim still goes through
    const early = person();
    const r0 = await claim({ ...early.body, ref: inviter.agentName });
    expect(r0.status).toBe(201);
    expect(r0.body.invite).toMatchObject({ bound: false, reason: "inviter_no_credential" });
    await mintAndCheckin(inviter.wallet, 0);
    // eligible inviter: link uses hash routing + the .ai name
    const mine = await get(`/v1/airdrop/invites/${inviter.wallet}`);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ eligible: true, ref: inviter.agentName, link: `https://chyai.example/#/airdrop?ref=${inviter.agentName}`, invited: 0, boost: 0 });
    // self-invite (own wallet as ref)
    const self = person();
    const rs = await claim({ ...self.body, ref: self.wallet });
    expect(rs.body.invite).toMatchObject({ bound: false, reason: "self_invite" });
    // unknown inviter
    const lost = person();
    expect((await claim({ ...lost.body, ref: "nobody123.ai" })).body.invite).toMatchObject({ bound: false, reason: "inviter_not_found" });
    // good invite (by .ai, any case) → bound; repeat submission keeps the same binding
    const a = person();
    const ra = await claim({ ...a.body, ref: inviter.agentName.toUpperCase() });
    expect(ra.body.invite).toMatchObject({ bound: true, existing: false, ref: inviter.agentName });
    const again = await claim({ ...a.body, ref: inviter.agentName });
    expect(again.status).toBe(200);
    expect(again.body.invite).toMatchObject({ bound: true, existing: true });
    // a wallet-ref works too
    const b = person();
    expect((await claim({ ...b.body, ref: inviter.wallet })).body.invite).toMatchObject({ bound: true });
    // a claim without ref has invite:null
    const plain = person();
    expect((await claim(plain.body)).body.invite).toBeNull();
    const list = await get(`/v1/airdrop/invites/${inviter.wallet}`);
    expect(list.body.invited).toBe(2);
    expect(list.body.qualified).toBe(0);
    expect(list.body.invitees.every((i: any) => i.qualified === false)).toBe(true);
    expect((await get(`/v1/airdrop/invites/${a.wallet}`)).body.invitedBy.toLowerCase()).toBe(inviter.wallet);
  });

  it("qualifies invitees only after mint + 7 check-in days + X ≥ 30 days; boosts the inviter's mining; caps invitees", async () => {
    const inviter = person();
    await claim(inviter.body);
    await mintAndCheckin(inviter.wallet, 0);
    const good = person();
    const young = person({ xAgeDays: 5 });
    const lazy = person();
    for (const p of [good, young, lazy]) expect((await claim({ ...p.body, ref: inviter.agentName })).body.invite.bound).toBe(true);
    // cap = 3 (test config)
    const over = person();
    expect((await claim({ ...over.body, ref: inviter.agentName })).body.invite).toMatchObject({ bound: false, reason: "invite_cap_reached" });
    await mintAndCheckin(good.wallet, 7);
    await mintAndCheckin(young.wallet, 7); // X account too young
    await mintAndCheckin(lazy.wallet, 6); // only 6 check-in days
    const mine = await get(`/v1/airdrop/invites/${inviter.wallet}`);
    expect(mine.body).toMatchObject({ invited: 3, qualified: 1 });
    expect(mine.body.boost).toBeCloseTo(0.05);
    const byWallet = Object.fromEntries(mine.body.invitees.map((i: any) => [i.wallet.toLowerCase(), i]));
    expect(byWallet[good.wallet]).toMatchObject({ minted: true, checkinDays: 7, xAgeOk: true, qualified: true });
    expect(byWallet[young.wallet]).toMatchObject({ xAgeOk: false, qualified: false });
    expect(byWallet[lazy.wallet]).toMatchObject({ checkinDays: 6, qualified: false });
    const m = await get(`/v1/mining/${inviter.wallet}`);
    expect(m.body.boosts).toMatchObject({ invited: 3, qualifiedInvites: 1 });
    expect(m.body.boosts.inviteBoost).toBeCloseTo(0.05);
    expect(m.body.multiplier).toBeCloseTo(1.05);
    expect(m.body.ratePerDay).toBeCloseTo(10.5);
    // leaderboard: this inviter (1 qualified) ranks first
    const lb = await get(`/v1/airdrop/invites/leaderboard`);
    expect(lb.status).toBe(200);
    expect(lb.body.items[0]).toMatchObject({ rank: 1, wallet: expect.any(String), agentId: inviter.agentName, qualified: 1, invited: 3 });
  });

  it("hide list (config) drops test wallets from the invite and mining leaderboards and live activity", async () => {
    const hidden = person({ wallet: HIDDEN });
    await claim(hidden.body);
    await mintAndCheckin(HIDDEN, 1);
    const inv = person();
    expect((await claim({ ...inv.body, ref: hidden.agentName })).body.invite.bound).toBe(true);
    const lb = await get(`/v1/airdrop/invites/leaderboard`);
    expect(lb.body.items.some((r: any) => r.wallet.toLowerCase() === HIDDEN)).toBe(false);
    const mlb = await get(`/v1/mining/leaderboard`);
    expect(mlb.body.items.length).toBeGreaterThan(0);
    expect(mlb.body.items.some((r: any) => r.wallet.toLowerCase() === HIDDEN)).toBe(false);
    const act = await get(`/v1/mining/activity`);
    expect(act.body.items.some((r: any) => r.wallet === "0x49…CE")).toBe(false);
    // the wallet's own mining page still works
    expect((await get(`/v1/mining/${HIDDEN}`)).body.mining).toBe(true);
    expect(isHiddenWallet(ctx.cfg, HIDDEN.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isHiddenProject(ctx.cfg, "0xe69af8599eDa309621Bf6BffE64F241Df9786d28")).toBe(true);
    expect(isHiddenProject(ctx.cfg, "0xBb41b9789CF42bd2752c172170D2EFaE857F53eb")).toBe(true);
    expect(isHiddenActivity(ctx.cfg, A(1), A(2))).toBe(false);
    expect(loadConfig({ NODE_ENV: "test", HIDE_WALLETS: A(7) }).HIDE_WALLETS).toEqual([A(7)]);
  });

  it("agent prompt and agent.md carry the invite ref; share links use hash routes", async () => {
    expect(agentPrompt("https://h", "Alice.ai")).toContain(`"ref":"alice.ai"`);
    expect(agentPrompt("https://h")).not.toContain("ref");
    expect(agentPrompt("https://h", "!!")).not.toContain("邀请人");
    expect(agentMarkdown("https://h", 56)).toContain(`"ref":"<inviter>.ai"`);
    expect(agentMarkdown("https://h", 56)).toContain("/airdrop/invites/");
    const p = await get(`/v1/agent/prompt?ref=bob.ai`);
    expect(p.body.prompt).toContain("bob.ai");
    expect(projectLink("https://site/", "0xAbC")).toBe("https://site/#/project/0xAbC");
    expect(projectLink("https://site", "0xAbC", "path")).toBe("https://site/project/0xAbC");
  });
});
