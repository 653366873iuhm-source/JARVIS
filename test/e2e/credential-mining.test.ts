/**
 * ChyAI airdrop credential v2 + 挖矿积分, end to end on a local Hardhat node with the REAL AgentRegistry and
 * ChyAICredential contracts: claim (.ai name must resolve to the wallet) -> admin approve -> voucher
 * (registration + mint calldata, nothing broadcast by the backend) -> the user's wallet sends both -> mining accrues,
 * boosts from indexed activity, signed daily check-in, leaderboard, stats.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createWalletClient, http, toHex, type Account, type Address, type Hex, type PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type { FastifyInstance } from "fastify";
import { startHardhatNode, increaseTime } from "../helpers/hardhat.js";
import { artifact, deployAll, type Deployment } from "../../scripts/lib/deploy.js";
import { loadConfig } from "../../src/config.js";
import { createContext, type AppContext } from "../../src/context.js";
import { buildServer } from "../../src/api/server.js";
import { MockXProvider } from "../../src/providers/x/mock.js";
import { MockAgentIdResolver } from "../../src/providers/agentid/index.js";
import { makeChain, makePublicClient } from "../../src/chain/client.js";
import { AgentRegistryAbi, ChyAICredentialAbi } from "../../src/chain/abi.js";
import { clearCredentialCache } from "../../src/services/credential.js";
import { agentIdHash, handleHash } from "../../src/lib/util.js";

const MNEMONIC = "test test test test test test test test test test test junk";
const acct = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const pk = (i: number) => toHex(acct(i).getHdKey().privateKey!) as Hex;
const quiet = { info() {}, warn() {}, debug() {}, error(o: unknown, m?: string) { console.error("[ctx error]", m, o); } };
const ADMIN = { authorization: "Bearer test-admin" };

let node: { url: string; stop: () => Promise<void> };
let dep: Deployment;
let pc: PublicClient;
let ctx: AppContext;
let app: FastifyInstance;
let resolver: MockAgentIdResolver;
let credential: Address;
let dbFile: string;
const deployer = acct(0);
const platformSigner = acct(1);
const U = acct(10); // holder
const V = acct(11); // second user (not approved)
const W = acct(12); // third user, never claims

let ipSeq = 0;
const inject = async (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { "x-forwarded-for": `10.9.0.${++ipSeq}`, ...headers } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
async function send(a: Account, to: Address, data: Hex) {
  const w = createWalletClient({ account: a, chain: makeChain({ CHAIN_ID: 31337, RPC_URL: node.url }), transport: http(node.url) });
  const hash = await w.sendTransaction({ account: a, chain: w.chain, to, data, value: 0n });
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`tx reverted ${hash}`);
  return rc;
}

beforeAll(async () => {
  node = await startHardhatNode(19545 + Math.floor(Math.random() * 500));
  const chainCfg = { CHAIN_ID: 31337, RPC_URL: node.url };
  pc = makePublicClient(chainCfg);
  dep = await deployAll({ pc, chain: makeChain(chainCfg), rpcUrl: node.url, deployer, platformSigner: platformSigner.address, treasury: acct(2).address });
  const art = artifact("ChyAICredential");
  const w = createWalletClient({ account: deployer, chain: makeChain(chainCfg), transport: http(node.url) });
  const h = await w.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [deployer.address, platformSigner.address, dep.contracts.AgentRegistry, ""], account: deployer, chain: w.chain });
  credential = (await pc.waitForTransactionReceipt({ hash: h })).contractAddress!;

  dbFile = path.join(os.tmpdir(), `chyai-cred-${Date.now()}.db`);
  const cfg = loadConfig({
    NODE_ENV: "test", DATABASE_URL: `file:${dbFile}`, RPC_URL: node.url, CHAIN_ID: "31337",
    REGISTRY_ADDRESS: dep.contracts.AgentRegistry, FACTORY_ADDRESS: dep.contracts.LaunchFactory, REWARD_POOL_ADDRESS: dep.contracts.RewardPool,
    FEE_SPLITTER_ADDRESS: dep.contracts.FeeSplitter, SIGNER_PRIVATE_KEY: pk(1), X_PROVIDER: "mock", AGENTID_PROVIDER: "mock",
    ADMIN_TOKEN: "test-admin", CREDENTIAL_ADDRESS: credential, MINING_CREDIT_CACHE_SEC: "0",
  });
  resolver = new MockAgentIdResolver();
  ctx = await createContext(cfg, { x: new MockXProvider(), resolver, log: quiet });
  app = await buildServer(ctx);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await ctx?.database.close();
  await node?.stop();
  for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true });
});

describe("airdrop v2 claim with .ai name", () => {
  it("rejects a .ai name that does not resolve, or resolves to another wallet", async () => {
    let r = await inject("POST", "/v1/airdrop/claim", { xHandle: "uuser", wallet: U.address, agentName: "nobody.ai", repostUrl: "https://x.com/uuser/status/1234567890" });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("agent_id_unresolved");
    resolver.set("other.ai", W.address);
    r = await inject("POST", "/v1/airdrop/claim", { xHandle: "uuser", wallet: U.address, agentName: "other", repostUrl: "https://x.com/uuser/status/1234567890" });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("agent_id_mismatch");
  });
  it("validates repost url and its author", async () => {
    resolver.set("ualpha.ai", U.address);
    let r = await inject("POST", "/v1/airdrop/claim", { xHandle: "uuser", wallet: U.address, agentName: "ualpha.ai", repostUrl: "not a url" });
    expect(r.body.error.code).toBe("invalid_repost_url");
    r = await inject("POST", "/v1/airdrop/claim", { xHandle: "uuser", wallet: U.address, agentName: "ualpha.ai", repostUrl: "https://x.com/someoneelse/status/1234567890" });
    expect(r.body.error.code).toBe("repost_wrong_author");
    r = await inject("POST", "/v1/airdrop/claim", { xHandle: "uuser", wallet: U.address, agentName: "UAlpha.ai", repostUrl: "x.com/uuser" });
    expect(r.status).toBe(400);
  });
  let claimId = "";
  it("valid claim -> pending; same .ai name again -> 409", async () => {
    const r = await inject("POST", "/v1/airdrop/claim", { xHandle: "@UUser", wallet: U.address, agentName: "UAlpha.ai", repostUrl: "https://twitter.com/UUser/status/1234567890?s=20" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ agentId: "ualpha.ai", repostUrl: "https://x.com/uuser/status/1234567890", status: "pending_verification" });
    claimId = r.body.id;
    resolver.set("ualpha.ai", V.address); // pretend: a different wallet now submits the same name
    const d = await inject("POST", "/v1/airdrop/claim", { xHandle: "vuser", wallet: V.address, agentName: "ualpha", repostUrl: "https://x.com/vuser/status/2234567890" });
    expect(d.status).toBe(409);
    expect(d.body.error.code).toBe("agent_id_already_claimed");
    resolver.set("ualpha.ai", U.address);
  });
  it("voucher before approval -> 403; status endpoint shows pending", async () => {
    const v = await inject("GET", `/v1/airdrop/voucher?wallet=${U.address}`);
    expect(v.status).toBe(403);
    expect(v.body.error.code).toBe("claim_not_approved");
    const s = await inject("GET", `/v1/airdrop/status?wallet=${U.address}`);
    expect(s.body).toMatchObject({ claimed: true, status: "pending_verification", agentId: "ualpha.ai" });
    expect(s.body.credential).toMatchObject({ configured: true, active: false });
  });
  it("mining before credential: zero rate, check-in refused", async () => {
    const m = await inject("GET", `/v1/mining/${U.address}`);
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ points: "0.00000000", ratePerDay: 0, ratePerSecond: "0.000000000000", mining: false, credential: { active: false } });
    const signature = await U.signMessage({ message: m.body.checkin.message });
    const c = await inject("POST", "/v1/mining/checkin", { wallet: U.address, signature, message: m.body.checkin.message });
    expect(c.status).toBe(403);
    expect(c.body.error.code).toBe("no_credential");
  });
  it("approve -> voucher has register + mint steps; user sends both; credential minted", async () => {
    const a = await inject("POST", `/v1/airdrop/claims/${claimId}/status`, { status: "approved" }, ADMIN);
    expect(a.status).toBe(200);
    const v = await inject("GET", `/v1/airdrop/voucher?wallet=${U.address}`);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.minted).toBe(false);
    expect(v.body.steps.map((s: any) => s.step)).toEqual(["register", "mint"]);
    expect(v.body.registration.canLaunch).toBe(false);
    expect(v.body.mint.agentId).toBe(agentIdHash("ualpha.ai"));
    expect(v.body.mint.xHandleHash).toBe(handleHash("uuser"));
    // minting before registering reverts (registry gate) — send in order
    for (const s of v.body.steps) await send(U, s.to, s.data);
    const [regId] = (await pc.readContract({ address: dep.contracts.AgentRegistry, abi: AgentRegistryAbi, functionName: "agents", args: [U.address] })) as any;
    expect(regId).toBe(agentIdHash("ualpha.ai"));
    expect(await pc.readContract({ address: credential, abi: ChyAICredentialAbi, functionName: "isActiveHolder", args: [U.address] } as any)).toBe(true);
    clearCredentialCache();
    const again = await inject("GET", `/v1/airdrop/voucher?wallet=${U.address}`);
    expect(again.body).toMatchObject({ minted: true, tokenId: 1 });
  });
});

describe("挖矿积分", () => {
  it("holder starts accruing 10 pts/day per 1000 credit", async () => {
    const m0 = await inject("GET", `/v1/mining/${U.address}`);
    expect(m0.body).toMatchObject({ ratePerDay: 10, basePerDay: 10, multiplier: 1, credential: { active: true, credit: 1000 } });
    await increaseTime(node.url, 0); // no-op mine
    // accrual is wall-clock based (server time): simulate one day by rewinding lastAccrualAt
    const { db, t } = ctx.database;
    await db.update(t.miningAccounts).set({ lastAccrualAt: m0.body.asOf - 86400 });
    const m1 = await inject("GET", `/v1/mining/${U.address}`);
    expect(m1.body.points).toMatch(/^\d+\.\d{8}$/);
    expect(Number(m1.body.points)).toBeGreaterThanOrEqual(10);
    expect(Number(m1.body.points)).toBeLessThan(10.01);
    expect(m1.body.mining).toBe(true);
    expect(Number(m1.body.ratePerSecond)).toBeCloseTo(10 / 86400, 10);
    // sub-milli precision: a tiny rate (0.0017/day) must still accrue across frequent reads
    const { fmtE8, ratePerSecondStr } = await import("../../src/services/mining.js");
    expect(fmtE8(1086658)).toBe("0.01086658");
    expect(ratePerSecondStr(170000)).toBe("0.000000019675");
  });
  it("boost from indexed launches and curve volume", async () => {
    const { db, t } = ctx.database;
    const now = Math.floor(Date.now() / 1000);
    await db.insert(t.trades).values({
      id: "0xabc:1", project: "0x" + "1".repeat(40), trader: U.address.toLowerCase(), side: "buy", count: 10, bnbWei: (3n * 10n ** 18n).toString(),
      feeWei: "0", priceWei: "1", firstTokenId: 1, blockNumber: 1, logIndex: 1, txHash: "0xabc", ts: now,
    });
    await db.insert(t.trades).values({
      id: "0xabd:1", project: "0x" + "1".repeat(40), trader: U.address.toLowerCase(), side: "sell", count: 1, bnbWei: (50n * 10n ** 18n).toString(),
      feeWei: "0", priceWei: "1", firstTokenId: 1, blockNumber: 1, logIndex: 2, txHash: "0xabd", ts: now - 30 * 86400, // outside the 7d window
    });
    const m = await inject("GET", `/v1/mining/${U.address}`);
    expect(m.body.boosts).toMatchObject({ launches: 0, volumeBnb: 3, volumeWindowDays: 7 });
    expect(m.body.multiplier).toBeCloseTo(1.3, 6);
    expect(m.body.ratePerDay).toBeCloseTo(13, 6);
  });
  it("signed daily check-in: wrong signer / wrong message rejected, once per UTC day", async () => {
    const m = await inject("GET", `/v1/mining/${U.address}`);
    const msg = m.body.checkin.message as string;
    expect(msg).toContain(U.address);
    const bad = await inject("POST", "/v1/mining/checkin", { wallet: U.address, signature: await V.signMessage({ message: msg }), message: msg });
    expect(bad.status).toBe(401);
    const old = msg.replace(/Date \(UTC\): .*/, "Date (UTC): 2020-01-01");
    const stale = await inject("POST", "/v1/mining/checkin", { wallet: U.address, signature: await U.signMessage({ message: old }), message: old });
    expect(stale.status).toBe(400);
    const before = Number(m.body.points);
    const ok = await inject("POST", "/v1/mining/checkin", { wallet: U.address, signature: await U.signMessage({ message: msg }), message: msg });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.added).toBe(5);
    expect(Number(ok.body.mining.points)).toBeGreaterThanOrEqual(before + 5);
    expect(ok.body.mining.checkin.checkedInToday).toBe(true);
    const twice = await inject("POST", "/v1/mining/checkin", { wallet: U.address, signature: await U.signMessage({ message: msg }), message: msg });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("already_checked_in");
    // EIP-712 path (baw): valid typed signature by U → passes verification (then 409 already checked in); wrong signer → 401
    const td = JSON.parse(m.body.checkin.typedData);
    const { EIP712Domain: _d, ...types } = td.types;
    const sig712 = await U.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
    const t712 = await inject("POST", "/v1/mining/checkin", { wallet: U.address, signType: "eip712", signature: sig712.slice(2, 130), signatureRecovery: sig712.slice(130) });
    expect(t712.status, JSON.stringify(t712.body)).toBe(409);
    const bad712 = await inject("POST", "/v1/mining/checkin", { wallet: U.address, signType: "eip712", signature: await V.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message }) });
    expect(bad712.status).toBe(401);
  });
  it("leaderboard + stats", async () => {
    const lb = await inject("GET", "/v1/mining/leaderboard");
    expect(lb.status).toBe(200);
    expect(lb.body.items[0]).toMatchObject({ rank: 1, wallet: U.address, credit: 1000 });
    const st = await inject("GET", "/v1/mining/stats");
    expect(st.body).toMatchObject({ participants: 1, activeMiners: 1, checkinsToday: 1, credentialConfigured: true });
    expect(st.body.rules.note).toContain("不承诺收益");
    const none = await inject("GET", `/v1/mining/${W.address}`);
    expect(none.body).toMatchObject({ points: "0.00000000", ratePerDay: 0, mining: false });
    expect(lb.body.items[0].points).toMatch(/^\d+\.\d{8}$/);
    const act = await inject("GET", "/v1/mining/activity");
    expect(act.status).toBe(200);
    expect(act.body.items.map((i: any) => i.kind).sort()).toEqual(["checkin", "mint"]);
    expect(act.body.items[0].wallet).toMatch(/^0x[0-9a-fA-F]{2}…[0-9a-fA-F]{2}$/);
    const res = await inject("GET", "/v1/airdrop/resolve?name=UAlpha.ai");
    expect(res.body).toMatchObject({ name: "ualpha.ai", wallet: U.address });
    const nores = await inject("GET", "/v1/airdrop/resolve?name=nobodyhere.ai");
    expect(nores.status).toBe(404);
    const exp = await inject("GET", "/v1/admin/backup/export", undefined, ADMIN);
    expect(exp.status).toBe(200);
    expect(exp.body.miningAccounts.length).toBe(1);
    expect(exp.body.airdropClaims.length).toBeGreaterThanOrEqual(1);
    const bad = await inject("GET", "/v1/mining/0x123");
    expect(bad.status).toBe(400);
  });
});
