/** CHYAI pivot (2026-10-30): mining / check-in / credential airdrop frozen (410), agent.md + llms.txt + agent card switch
 *  to the CHYAI sale, /v1/chyai info, buy steps (calldata) and old-miner airdrop proofs. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { concat, decodeFunctionData, encodeAbiParameters, keccak256, parseAbi } from "viem";
import { openDatabase, type Database } from "../../src/db/index.js";
import { loadConfig } from "../../src/config.js";
import { buildServer } from "../../src/api/server.js";
import type { AppContext } from "../../src/context.js";
import { MockAgentIdResolver } from "../../src/providers/agentid/index.js";
import { MockXProvider } from "../../src/providers/x/mock.js";
import { accrualNow } from "../../src/services/mining.js";
import { CHYAI_AIRDROP_TREE } from "../../src/data/chyaiAirdrop.js";

const FROZEN = 1793329718;
const SALE = "0x00000000000000000000000000000000000Sa1e0".replace("Sa1e0", "5a1e0");
const AIRDROP = "0x00000000000000000000000000000000000a1d10";
const TOKEN = "0x0000000000000000000000000000000000070ce0";
const WALLET = "0x5d2A279e91A4e82bB327f5c98Fb48C72F7Cb39e3";
let database: Database;
let app: FastifyInstance; // frozen, sale deployed (mock chain)
let app2: FastifyInstance; // frozen, nothing deployed
let app3: FastifyInstance; // not frozen (old behaviour)
const files: string[] = [];
let allowance = 0n;
let valveFlag = false;

const pc = {
  async readContract({ functionName, args }: { functionName: string; args?: unknown[] }) {
    switch (functionName) {
      case "overview":
        return [true, false, false, 2n, 2n * 10n ** 18n, 1n, 2n, 2100n, 7n, 1007n, 1014n * 10n ** 18n, 100n];
      case "valveOpen":
        return valveFlag;
      case "valveOpensAt":
        return 1793329718n + 30n * 86400n + 1n;
      case "walletStatus":
        return [args?.[0] === WALLET, 1n, 3n, 7n];
      case "allowance":
        return allowance;
      case "bnbQuote":
        return 10n ** 16n;
      case "claimed":
        return false;
      case "opensAt":
        return 0n;
      case "endsAt":
        return 0n;
    }
    throw new Error("unexpected " + functionName);
  },
};

async function mk(env: Record<string, string>, withPc = false) {
  const f = path.join(os.tmpdir(), `chyai-pivot-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  files.push(f);
  database = await openDatabase(`file:${f}`);
  const ctx = {
    cfg: loadConfig({ NODE_ENV: "test", ADMIN_TOKEN: "t", ...env }),
    database, resolver: new MockAgentIdResolver(), x: new MockXProvider(), bus: new EventEmitter(),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    ...(withPc ? { pc } : {}),
  } as unknown as AppContext;
  return buildServer(ctx);
}

beforeAll(async () => {
  app = await mk({ MINING_FROZEN_AT: String(FROZEN), CHYAI_SALE: SALE, CHYAI_AIRDROP: AIRDROP, CHYAI_TOKEN: TOKEN }, true);
  app2 = await mk({ MINING_FROZEN_AT: String(FROZEN) });
  app3 = await mk({});
});
afterAll(async () => {
  await Promise.all([app?.close(), app2?.close(), app3?.close()]);
  for (const f of files) fs.rmSync(f, { force: true });
});

const get = async (a: FastifyInstance, url: string) => {
  const r = await a.inject({ method: "GET", url });
  return { status: r.statusCode, body: r.body, json: () => JSON.parse(r.body) };
};

describe("freeze", () => {
  it("accrual stops at MINING_FROZEN_AT", () => {
    const cfg = loadConfig({ NODE_ENV: "test", MINING_FROZEN_AT: String(FROZEN) });
    expect(accrualNow(cfg, FROZEN + 86400)).toBe(FROZEN);
    expect(accrualNow(cfg, FROZEN - 5)).toBe(FROZEN - 5);
    expect(accrualNow(loadConfig({ NODE_ENV: "test" }), FROZEN + 86400)).toBe(FROZEN + 86400);
  });
  it("check-in, credential claim and voucher answer 410", async () => {
    const c = await app2.inject({ method: "POST", url: "/v1/mining/checkin", payload: { wallet: WALLET, signature: "0x" + "11".repeat(65), signType: "eip712" } });
    expect(c.statusCode).toBe(410);
    expect(JSON.parse(c.body).error.code).toBe("mining_closed");
    const a = await app2.inject({ method: "POST", url: "/v1/airdrop/claim", payload: { xHandle: "a", wallet: WALLET, repostUrl: "https://x.com/a/status/1", agentName: "a.ai" } });
    expect(a.statusCode).toBe(410);
    expect(JSON.parse(a.body).error.code).toBe("airdrop_closed");
    expect((await get(app2, `/v1/airdrop/voucher?wallet=${WALLET}`)).status).toBe(410);
    const flow = (await get(app2, `/v1/agent/flow?wallet=${WALLET}`)).json();
    expect(flow.closed).toBe(true);
    expect(flow.next).toBe("chyai_sale");
  });
});

describe("agent docs switch to the CHYAI sale", () => {
  it("agent.md / llms.txt / agent card (frozen)", async () => {
    const md = (await get(app, "/agent.md")).body;
    expect(md).toContain("CHYAI 打新");
    expect(md).toContain("/v1/chyai/buy?wallet=<WALLET>");
    expect(md).toContain(SALE.toLowerCase().slice(0, 10));
    expect(md).toContain("not audited");
    expect(md).not.toMatch(/earn more|guaranteed/i);
    const llms = (await get(app, "/llms.txt")).body;
    expect(llms).toContain("staged sale");
    expect(llms).toContain("Stage 8: 48 USDT per share, 4500 shares");
    expect(llms).toContain("410");
    expect(llms).toContain("20% to the treasury");
    expect(llms).toContain("Stage 8: 48 USDT per share, 4500 shares, until sold out (no time limit)");
    expect(llms).toContain("stage 8 has no end time and runs until sold out");
    expect(llms).toContain("The sale keeps running after a withdrawal");
    expect(llms).not.toMatch(/closes for good|30-day deadline|paused/);
    expect(md).not.toMatch(/closes for good|30-day deadline/);
    expect(md).toContain("valveOpensAt");
    expect(md).toContain("no buyer refunds".replace("no buyer refunds", "are no buyer refunds"));
    const card = (await get(app, "/.well-known/agent.json")).json();
    expect(card.version).toBe("2.0.0");
    expect(card.skills.map((s: { id: string }) => s.id)).toEqual(["buy-chyai", "claim-miner-airdrop"]);
    const prompt = (await get(app, "/v1/agent/prompt")).json().prompt as string;
    expect(prompt).toContain("CHYAI 打新");
  });
  it("not frozen: old docs unchanged", async () => {
    expect((await get(app3, "/agent.md")).body).toContain("Daily check-in");
    expect((await get(app3, "/.well-known/agent.json")).json().version).toBe("1.0.0");
  });
  it("default announcement points at the sale", async () => {
    const cfg = (await get(app3, "/v1/config")).json();
    expect(cfg.announcements[0]).toMatchObject({ id: "chyai-sale-2026-10", href: "/sale" });
  });
});

describe("/v1/chyai", () => {
  it("info without contracts", async () => {
    const r = (await get(app2, "/v1/chyai")).json();
    expect(r.deployed).toBe(false);
    expect(r.stages).toHaveLength(8);
    expect(r.stages.reduce((a: number, s: { shares: number; priceUsdt: number }) => a + s.shares * s.priceUsdt, 0)).toBe(508000);
    expect(r.airdrop.recipients).toBe(155);
    expect(r.mining.frozen).toBe(true);
    expect((await get(app2, `/v1/chyai/buy?wallet=${WALLET}&shares=1`)).status).toBe(503);
  });
  it("info with the sale (chain mocked)", async () => {
    const r = (await get(app, "/v1/chyai")).json();
    expect(r.deployed).toBe(true);
    expect(r.sale).toMatchObject({ started: true, stage: 2, priceUsdt: "2", stageCap: 2100, stageSold: 7, valveOpen: false, valveOpensAt: 1793329718 + 30 * 86400 + 1 });
    expect(r.sale.closed).toBeUndefined();
    expect(r.rules.valve).toContain("keeps running");
    expect(r.rules.rollover).toContain("NO time limit");
  });
  it("buy steps still offered after day 30 (valve open, sale keeps running)", async () => {
    valveFlag = true;
    const r = (await get(app, `/v1/chyai/buy?wallet=${WALLET}&shares=1`)).json();
    const info = (await get(app, "/v1/chyai")).json();
    valveFlag = false;
    expect(r.error).toBeUndefined();
    expect(r.steps.map((s: { id: string }) => s.id)).toContain("buy");
    expect(info.sale.valveOpen).toBe(true);
  });
  it("buy steps: approve + buy(shares, maxCost) for USDT, value for BNB, limits", async () => {
    allowance = 0n;
    const u = (await get(app, `/v1/chyai/buy?wallet=${WALLET}&shares=5&pay=usdt`)).json();
    expect(u.steps.map((s: { id: string }) => s.id)).toEqual(["approve_usdt", "buy"]);
    const abi = parseAbi(["function buy(uint256 shares, uint256 maxCost)", "function approve(address,uint256)", "function buyWithBnb(uint256,uint256) payable"]);
    const d = decodeFunctionData({ abi, data: u.steps[1].data });
    expect(d.functionName).toBe("buy");
    expect(d.args).toEqual([5n, 10n * 10n ** 18n]);
    expect(u.steps[1].baw).toMatch(/^baw contract-call preview --binanceChainId \d+ --from /);
    allowance = 10n ** 30n;
    const u2 = (await get(app, `/v1/chyai/buy?wallet=${WALLET}&shares=5`)).json();
    expect(u2.steps.map((s: { id: string }) => s.id)).toEqual(["buy"]);
    const b = (await get(app, `/v1/chyai/buy?wallet=${WALLET}&shares=2&pay=bnb`)).json();
    expect(b.steps[0].value).toBe(((10n ** 16n * 102n) / 100n).toString());
    expect((await get(app, `/v1/chyai/buy?wallet=${WALLET}&shares=8`)).json().error.code).toBe("over_limit");
    expect((await get(app, `/v1/chyai/buy?wallet=${WALLET}&shares=11`)).status).toBe(400);
    expect((await get(app, `/v1/chyai/buy?wallet=0x000000000000000000000000000000000000dEaD&shares=1`)).json().error.code).toBe("no_agent_id");
  });
  it("old-miner airdrop proof verifies against the root; non-listed wallet not eligible", async () => {
    const w = Object.keys(CHYAI_AIRDROP_TREE.proofs)[7]!;
    const r = (await get(app, `/v1/chyai/airdrop/${w}`)).json();
    expect(r.eligible).toBe(true);
    expect(r.amount).toBe("10000");
    let h = keccak256(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [w as `0x${string}`, 10_000n * 10n ** 18n])));
    for (const p of r.proof as `0x${string}`[]) h = BigInt(h) < BigInt(p) ? keccak256(concat([h, p])) : keccak256(concat([p, h]));
    expect(h).toBe(CHYAI_AIRDROP_TREE.root);
    expect(r.calldata.slice(0, 10)).toBe(keccak256(new TextEncoder().encode("claim(address,bytes32[])")).slice(0, 10));
    expect(r.baw.toLowerCase()).toContain(`--to ${AIRDROP}`);
    const n = (await get(app, `/v1/chyai/airdrop/0x000000000000000000000000000000000000dEaD`)).json();
    expect(n.eligible).toBe(false);
    expect(n.proof).toBeNull();
  });
});
