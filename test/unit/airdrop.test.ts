/** 发射台推特空投 (X airdrop): claim / dedupe / validation / stats / admin export + status, via SQLite + app.inject. */
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
import { normalizeXHandle } from "../../src/services/airdrop.js";

const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const TOKEN = "test-admin-token";
let database: Database;
let app: FastifyInstance;
let dbFile: string;
let ipSeq = 0;
// each request gets its own client IP so the per-IP limiter (5 / 10 min) never interferes
const claim = async (body: unknown) => {
  const r = await app.inject({ method: "POST", url: "/v1/airdrop/claim", payload: body as any, headers: { "x-forwarded-for": `10.0.0.${++ipSeq}` } });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};
const get = async (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });

beforeAll(async () => {
  dbFile = path.join(os.tmpdir(), `agentpad-airdrop-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  database = await openDatabase(`file:${dbFile}`);
  const ctx = {
    cfg: loadConfig({ NODE_ENV: "test", PLATFORM_ADDRESSES: A(0xff), ADMIN_TOKEN: TOKEN }),
    database,
    bus: new EventEmitter(),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as AppContext;
  app = await buildServer(ctx);
});

afterAll(async () => {
  await app?.close();
  await database?.close();
  for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true });
});

describe("normalizeXHandle", () => {
  it("strips @ / url forms and lowercases", () => {
    for (const v of ["Alice_01", "@Alice_01", "x.com/Alice_01", "https://twitter.com/Alice_01?s=20", "https://www.x.com/ALICE_01/"]) expect(normalizeXHandle(v)).toBe("alice_01");
  });
});

describe("airdrop routes", () => {
  let firstId = "";
  it("valid claim -> 201 pending_verification, amount 1000", async () => {
    const r = await claim({ xHandle: "@Alice_01", wallet: A(0xa1).toUpperCase().replace("0X", "0x") });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ xHandle: "alice_01", wallet: A(0xa1), amount: 1000, status: "pending_verification", claimed: 1 });
    expect(typeof r.body.id).toBe("string");
    firstId = r.body.id;
  });
  it("duplicate handle in any form -> 409 handle_already_claimed", async () => {
    let n = 0x200;
    for (const h of ["alice_01", "ALICE_01", "@alice_01", "https://x.com/Alice_01", "twitter.com/alice_01?s=20"]) {
      const r = await claim({ xHandle: h, wallet: A(++n) });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("handle_already_claimed");
    }
  });
  it("duplicate wallet (any case) -> 409 wallet_already_claimed", async () => {
    const r = await claim({ xHandle: "bob_02", wallet: A(0xa1) });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("wallet_already_claimed");
    const r2 = await claim({ xHandle: "bob_03", wallet: A(0xa1).replace(/a/g, "A") });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe("wallet_already_claimed");
  });
  it("bad handle / wallet / body -> 400", async () => {
    for (const h of ["", "@", "has space", "way_too_long_handle_x", "bad-dash", "x.com/"]) {
      const r = await claim({ xHandle: h, wallet: A(0x301) });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_x_handle");
    }
    for (const w of ["", "0x123", "not-a-wallet", "0x" + "g".repeat(40), "0x" + "0".repeat(40)]) {
      const r = await claim({ xHandle: "carol_04", wallet: w });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_wallet");
    }
    for (const b of [{}, { xHandle: "carol_04" }, { wallet: A(0x302) }, { xHandle: 1, wallet: A(0x303) }]) {
      const r = await claim(b);
      expect(r.status).toBe(400);
    }
  });
  it("stats counts only accepted claims", async () => {
    expect((await claim({ xHandle: "dave_05", wallet: A(0xa2) })).status).toBe(201);
    const r = await get("/v1/airdrop/stats");
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ claimed: 2, amountPerClaim: 1000 });
  });
  it("per-IP rate limit -> 429 after 5 attempts", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({ method: "POST", url: "/v1/airdrop/claim", payload: {}, headers: { "x-forwarded-for": "10.9.9.9" } });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(codes[5]).toBe(429);
  });
  it("admin export requires token; CSV default, JSON without ipHash", async () => {
    expect((await get("/v1/airdrop/claims")).statusCode).toBe(401);
    expect((await get("/v1/airdrop/claims", { authorization: "Bearer wrong" })).statusCode).toBe(401);
    const csv = await get("/v1/airdrop/claims", { authorization: `Bearer ${TOKEN}` });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.body.trim().split("\n");
    expect(lines[0]).toBe("id,x_handle,x_url,wallet,amount,status,created_at_utc");
    expect(lines.length).toBe(3);
    expect(csv.body).toContain(`alice_01,https://x.com/alice_01,${A(0xa1)},1000,pending_verification`);
    const js = await get("/v1/airdrop/claims?format=json", { authorization: `Bearer ${TOKEN}` });
    expect(js.statusCode).toBe(200);
    const rows = JSON.parse(js.body);
    expect(rows.length).toBe(2);
    expect(rows.map((r: any) => r.xHandle).sort()).toEqual(["alice_01", "dave_05"]);
    for (const r of rows) expect(r).not.toHaveProperty("ipHash");
  });
  it("admin status update: auth, validation, 404, approve persists", async () => {
    const post = (id: string, body: unknown, auth = true) =>
      app.inject({ method: "POST", url: `/v1/airdrop/claims/${id}/status`, payload: body as any, headers: auth ? { authorization: `Bearer ${TOKEN}` } : {} });
    expect((await post(firstId, { status: "approved" }, false)).statusCode).toBe(401);
    expect((await post(firstId, { status: "paid" })).statusCode).toBe(400);
    expect((await post("nope", { status: "approved" })).statusCode).toBe(404);
    const ok = await post(firstId, { status: "approved" });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ id: firstId, status: "approved" });
    const rows = JSON.parse((await get("/v1/airdrop/claims?format=json", { authorization: `Bearer ${TOKEN}` })).body);
    expect(rows.find((r: any) => r.id === firstId).status).toBe("approved");
    expect((await post(firstId, { status: "rejected" })).statusCode).toBe(200);
  });
});
