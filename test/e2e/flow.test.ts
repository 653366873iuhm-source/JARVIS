/**
 * End-to-end: local Hardhat node + real AgentPad contracts + backend (SQLite) with mocked X / Binance Agent ID.
 * register agents (EOA + ERC-1271 smart wallet) -> launch -> mint to sell-out -> promotion gate -> graduation
 * (threshold path and forced 2h path) -> promoter exemption -> daily rewards -> claim -> sybil removal -> requalification.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import WebSocket from "ws";
import {
  createWalletClient, encodeFunctionData, hashTypedData, http, parseEther, toHex, zeroHash,
  type Address, type Hex, type PublicClient, type WalletClient, type Account,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { FastifyInstance } from "fastify";
import { startHardhatNode, increaseTime } from "../helpers/hardhat.js";
import { erc1271Artifact } from "../helpers/erc1271.js";
import { deployAll, type Deployment } from "../../scripts/lib/deploy.js";
import { loadConfig } from "../../src/config.js";
import { createContext, type AppContext } from "../../src/context.js";
import { buildServer } from "../../src/api/server.js";
import { Indexer } from "../../src/services/indexer.js";
import { MockXProvider } from "../../src/providers/x/mock.js";
import { MockAgentIdResolver } from "../../src/providers/agentid/index.js";
import { makeChain, makePublicClient, chainNow } from "../../src/chain/client.js";
import { AgentRegistryAbi, BondingNFTAbi, FeeSplitterAbi, LaunchFactoryAbi, RewardPoolAbi } from "../../src/chain/abi.js";
import { referralMessage } from "../../src/services/referrals.js";
import { epochOf } from "../../src/services/rewards.js";
import { eligibilityPostsTypedData } from "../../src/services/registration.js";

const MNEMONIC = "test test test test test test test test test test test junk";
const acct = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const pk = (i: number) => toHex(acct(i).getHdKey().privateKey!) as Hex;
const quiet = { info() {}, warn() {}, debug() {}, error(o: unknown, m?: string) { console.error("[ctx error]", m, o); } };

let node: { url: string; stop: () => Promise<void> };
let dep: Deployment;
let ctx: AppContext;
let app: FastifyInstance;
let pc: PublicClient;
let x: MockXProvider;
let resolver: MockAgentIdResolver;
let indexer: Indexer;
let dbFile: string;
let apiPort: number;

const deployer = acct(0);
const platformSigner = acct(1);
const treasury = acct(2);
const L = acct(3); // launcher
const A = acct(4);
const B = acct(5);
const C = acct(6);
const Downer = acct(7); // controller of the ERC-1271 smart wallet D
const E = acct(8); // wants to launch, not eligible
const F = acct(9); // sybil funder
let D: Address; // smart wallet address
let dPost: import("../../src/providers/x/types.js").XPost; // D's promotion post on P2

const wallets = new Map<string, WalletClient>();
function wc(a: Account) {
  let w = wallets.get(a.address);
  if (!w) {
    w = createWalletClient({ account: a, chain: makeChain({ CHAIN_ID: 31337, RPC_URL: node.url }), transport: http(node.url) });
    wallets.set(a.address, w);
  }
  return w;
}
async function send(a: Account, to: Address, data: Hex, value = 0n) {
  const hash = await wc(a).sendTransaction({ account: a, chain: wc(a).chain, to, data, value });
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`tx reverted ${hash}`);
  return rc;
}
const inject = async (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.inject({ method, url, payload: payload as any, headers });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const ADMIN = { authorization: "Bearer test-admin" };

// ------------------------------------------------------------------ registration helper
interface RegOpts { agentId: string; handle: string; intent: "launch" | "trade"; eligible?: boolean; smart?: { address: Address; owner: Account } }
const activityUrls = new Map<string, string[]>(); // handle -> the agent's own recent post URLs (submitted for eligibility)
async function registerAgent(account: Account | null, o: RegOpts) {
  const wallet = o.smart ? o.smart.address : account!.address;
  if (!(await x.getUserByUsername(o.handle))) {
    x.addUser({ username: o.handle, followers: o.eligible ? 20_000 : 300, createdAt: Math.floor(Date.now() / 1000) - 400 * 86400 });
    activityUrls.set(o.handle, x.seedActivity(o.handle, 12, o.eligible ? 200 : 0)); // 200 likes / 20k followers = 1% avg engagement
  }
  resolver.set(o.agentId, wallet, { addressType: o.smart ? "CONTRACT" : "EOA" });
  const ch = await inject("POST", "/v1/register/challenge", { agentId: o.agentId, wallet, xHandle: "@" + o.handle, intent: o.intent });
  expect(ch.status).toBe(200);
  const post = x.addPost({ authorUsername: o.handle, text: ch.body.xPostText });
  let signature: Hex;
  let signatureType: "eip191" | "eip712" = "eip191";
  if (o.smart) {
    signatureType = "eip712";
    signature = await (o.smart.owner as any).sign({ hash: hashTypedData(ch.body.typedData) });
  } else {
    signature = await (account as any).signMessage({ message: ch.body.message });
  }
  const v = await inject("POST", "/v1/register/verify", {
    challengeId: ch.body.challengeId, signature, signatureType, tweetUrl: `https://x.com/${o.handle}/status/${post.id}`, relay: !!o.smart,
    eligibilityPostUrls: o.intent === "launch" ? activityUrls.get(o.handle) : undefined,
  });
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  if (!o.smart) await send(account!, v.body.registry, v.body.calldata);
  else expect(v.body.relay.status).toBe("confirmed");
  return v.body;
}

// ------------------------------------------------------------------ chain helpers
async function launch(a: Account, name: string, symbol: string): Promise<Address> {
  const rc = await send(a, dep.contracts.LaunchFactory, encodeFunctionData({ abi: LaunchFactoryAbi, functionName: "launch", args: [name, symbol, "ipfs://bafytestcid/"] }));
  const log = rc.logs.find((l) => l.address.toLowerCase() === dep.contracts.LaunchFactory.toLowerCase())!;
  return ("0x" + log.topics[3]!.slice(26)) as Address;
}
async function quote(project: Address, n: number) {
  const [, , total] = (await pc.readContract({ address: project, abi: BondingNFTAbi, functionName: "quoteMint", args: [BigInt(n)] })) as readonly bigint[];
  return total!;
}
async function mint(a: Account | { smart: Address; owner: Account }, project: Address, n: number) {
  const total = await quote(project, n);
  const data = encodeFunctionData({ abi: BondingNFTAbi, functionName: "mint", args: [BigInt(n)] });
  if ("smart" in a) {
    const art = erc1271Artifact();
    return send(a.owner, a.smart, encodeFunctionData({ abi: art.abi, functionName: "exec", args: [project, total, data] }), total);
  }
  return send(a, project, data, total);
}
async function mintMany(a: Account, project: Address, n: number) {
  while (n > 0) {
    const k = Math.min(100, n);
    await mint(a, project, k);
    n -= k;
  }
}
const read = (address: Address, abi: any, functionName: string, args: unknown[] = []) => pc.readContract({ address, abi, functionName, args } as any) as Promise<any>;

beforeAll(async () => {
  const port = 18545 + Math.floor(Math.random() * 1000);
  node = await startHardhatNode(port);
  const chainCfg = { CHAIN_ID: 31337, RPC_URL: node.url };
  pc = makePublicClient(chainCfg);
  dep = await deployAll({ pc, chain: makeChain(chainCfg), rpcUrl: node.url, deployer, platformSigner: platformSigner.address, treasury: treasury.address });

  // ERC-1271 smart wallet for agent D
  const art = erc1271Artifact();
  const h = await wc(Downer).deployContract({ abi: art.abi, bytecode: art.bytecode, args: [Downer.address], account: Downer, chain: wc(Downer).chain });
  D = (await pc.waitForTransactionReceipt({ hash: h })).contractAddress!;

  dbFile = path.join(os.tmpdir(), `agentpad-e2e-${Date.now()}.db`);
  const cfg = loadConfig({
    NODE_ENV: "test", DATABASE_URL: `file:${dbFile}`, RPC_URL: node.url, CHAIN_ID: "31337",
    REGISTRY_ADDRESS: dep.contracts.AgentRegistry, FACTORY_ADDRESS: dep.contracts.LaunchFactory, REWARD_POOL_ADDRESS: dep.contracts.RewardPool,
    FEE_SPLITTER_ADDRESS: dep.contracts.FeeSplitter, SIGNER_PRIVATE_KEY: pk(1), X_PROVIDER: "mock", AGENTID_PROVIDER: "mock",
    FUNDING_PROVIDER: "rpc-scan", PLATFORM_ADDRESSES: treasury.address, ADMIN_TOKEN: "test-admin", SYBIL_MIN_CLUSTER: "3",
  });
  x = new MockXProvider();
  resolver = new MockAgentIdResolver();
  ctx = await createContext(cfg, { x, resolver, log: quiet });
  app = await buildServer(ctx);
  await app.listen({ port: 0, host: "127.0.0.1" });
  apiPort = (app.server.address() as any).port;
  indexer = new Indexer(ctx);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await ctx?.database.close();
  await node?.stop();
  if (dbFile) for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true });
});

describe("AgentPad backend e2e", () => {
  let P1: Address;
  let P2: Address;
  let epoch: number;
  let windowFrom: number;
  const wsMessages: any[] = [];

  it("health", async () => {
    const r = await inject("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body.chainId).toBe(31337);
    expect(r.body.db).toBe("sqlite");
  });

  it("registration rejects bad signature, agentId mismatch, missing/foreign X post URL; challenge single-use", async () => {
    x.addUser({ username: "badagent", followers: 100 });
    resolver.set("bad.ai", E.address);
    const ch = await inject("POST", "/v1/register/challenge", { agentId: "bad.ai", wallet: E.address, xHandle: "badagent", intent: "trade" });
    x.addPost({ authorUsername: "badagent", text: ch.body.xPostText });
    const wrongSig = await (A as any).signMessage({ message: ch.body.message });
    let r = await inject("POST", "/v1/register/verify", { challengeId: ch.body.challengeId, signature: wrongSig });
    expect(r.status).toBe(401);

    resolver.set("bad.ai", A.address); // resolves to someone else
    const ch2 = await inject("POST", "/v1/register/challenge", { agentId: "bad.ai", wallet: E.address, xHandle: "badagent" });
    x.addPost({ authorUsername: "badagent", text: ch2.body.xPostText });
    r = await inject("POST", "/v1/register/verify", { challengeId: ch2.body.challengeId, signature: await (E as any).signMessage({ message: ch2.body.message }) });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("agent_id_mismatch");
    expect(typeof r.body.error.message).toBe("string");

    resolver.set("bad.ai", E.address);
    const ch3 = await inject("POST", "/v1/register/challenge", { agentId: "bad.ai", wallet: E.address, xHandle: "badagent" });
    r = await inject("POST", "/v1/register/verify", { challengeId: ch3.body.challengeId, signature: await (E as any).signMessage({ message: ch3.body.message }) });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("x_post_url_required"); // no X search: the post URL must be submitted
    const sig3 = await (E as any).signMessage({ message: ch3.body.message });
    // someone else's post carrying the code doesn't prove ownership
    x.addUser({ username: "impostor" });
    const foreign = x.addPost({ authorUsername: "impostor", text: ch3.body.xPostText });
    r = await inject("POST", "/v1/register/verify", { challengeId: ch3.body.challengeId, signature: sig3, tweetUrl: x.url(foreign) });
    expect(r.body.error.code).toBe("x_post_wrong_author");
    const noCode = x.addPost({ authorUsername: "badagent", text: "hello world" });
    r = await inject("POST", "/v1/register/verify", { challengeId: ch3.body.challengeId, signature: sig3, tweetUrl: x.url(noCode) });
    expect(r.body.error.code).toBe("x_post_not_found");
    // now post it and submit the URL; then reuse fails
    const proof = x.addPost({ authorUsername: "badagent", text: ch3.body.xPostText });
    r = await inject("POST", "/v1/register/verify", { challengeId: ch3.body.challengeId, signature: sig3, tweetUrl: x.url(proof) });
    expect(r.status).toBe(200);
    r = await inject("POST", "/v1/register/verify", { challengeId: ch3.body.challengeId, signature: sig3, tweetUrl: x.url(proof) });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toEqual(expect.any(String));
  });

  it("error envelope: { error: { code, message, details? } } for ApiError, validation, unknown routes", async () => {
    let r = await inject("POST", "/v1/register/challenge", { agentId: "x.ai" }); // missing wallet/xHandle
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("validation_error");
    expect(r.body.error.message).toMatch(/wallet/);
    r = await inject("POST", "/v1/register/challenge", { agentId: "no-suffix", wallet: E.address, xHandle: "e" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_agent_id");
    r = await inject("GET", `/v1/projects/0x${"ab".repeat(20)}`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "not_found", message: "unknown project" } });
    r = await inject("GET", "/v1/projects/not-an-address");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("bad_address");
    r = await inject("GET", "/v1/nope");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not_found");
    r = await inject("GET", "/v1/admin/txs");
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthorized");
    r = await inject("GET", "/v1/projects?phase=bogus");
    expect(r.body.error.code).toBe("bad_phase");
  });

  it("registers launcher (eligible), traders, an ineligible launcher and an ERC-1271 smart wallet", async () => {
    const l = await registerAgent(L, { agentId: "launcher.ai", handle: "launcher_bot", intent: "launch", eligible: true });
    expect(l.canLaunch).toBe(true);
    expect(l.eligibility.eligible).toBe(true);
    await registerAgent(A, { agentId: "alpha.ai", handle: "alpha_bot", intent: "trade" });
    await registerAgent(B, { agentId: "beta.ai", handle: "beta_bot", intent: "trade" });
    await registerAgent(C, { agentId: "gamma.ai", handle: "gamma_bot", intent: "trade" });
    const e = await registerAgent(E, { agentId: "echo.ai", handle: "echo_bot", intent: "launch", eligible: false });
    expect(e.canLaunch).toBe(false);
    expect(e.canTrade).toBe(true);
    expect(e.eligibility.reasons.join(" ")).toMatch(/followers/);
    const d = await registerAgent(null, { agentId: "delta.ai", handle: "delta_bot", intent: "trade", smart: { address: D, owner: Downer } });
    expect(d.walletType).toBe("contract");

    expect(await read(dep.contracts.AgentRegistry, AgentRegistryAbi, "canLaunch", [L.address])).toBe(true);
    expect(await read(dep.contracts.AgentRegistry, AgentRegistryAbi, "canLaunch", [E.address])).toBe(false);
    expect(await read(dep.contracts.AgentRegistry, AgentRegistryAbi, "canTrade", [D])).toBe(true);
    await indexer.syncToHead();
    const a = await inject("GET", `/v1/agents/${L.address}`);
    expect(a.body.onchain).toBe(true);
    expect(a.body.canLaunch).toBe(true);
  });

  it("launch + mint to sell-out (with referral binding, burn, smart-wallet trade); indexer + market API + websocket", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${apiPort}/v1/ws`);
    ws.on("message", (m) => wsMessages.push(JSON.parse(m.toString())));
    await new Promise((r) => ws.once("open", r));

    P1 = await launch(L, "Agent Coin", "AGC");
    await indexer.syncToHead();
    let r = await inject("GET", "/v1/projects?filter=最新");
    expect(r.body.items[0].address).toBe(P1.toLowerCase());
    expect(r.body.items[0].tag).toBe("#AP_AGC");
    windowFrom = r.body.items[0].launchedAt - 10;
    // ProjectSummary shape (SDK contract)
    const s0 = r.body.items[0];
    expect(s0).toMatchObject({ name: "Agent Coin", symbol: "AGC", phase: "trading", promotionStage: 0, totalSupply: "0", feeBps: 100, index: 0, launcherAgentId: "launcher.ai", story: null, image: null });
    expect(s0.baseURI).toEqual(expect.any(String));
    expect(s0.collectionUri).toBe(`${s0.baseURI}collection.json`);
    expect(s0.launchTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s0.launchBlock).toMatch(/^\d+$/);
    expect(BigInt(s0.spotPriceWei)).toBe(await read(P1, BondingNFTAbi, "spotPrice"));
    for (const k of ["virtualBnb", "virtualToken", "reserveBnb", "volumeBnb24h", "marketCapBnb"]) expect(s0[k]).toMatch(/^\d+$/);
    for (const k of ["createdAt", "baseUri", "tokenPriceWei", "reserveWei", "volume24hWei", "priceChange24hBps", "marketCapWei", "sold"]) expect(s0).not.toHaveProperty(k);
    expect(r.body.nextCursor).toBeNull();
    // phase / since filters
    expect((await inject("GET", "/v1/projects?phase=trading")).body.items.map((p: any) => p.address)).toContain(P1.toLowerCase());
    expect((await inject("GET", "/v1/projects?phase=graduated")).body.items).toEqual([]);
    expect((await inject("GET", `/v1/projects?since=${s0.launchedAt + 1}`)).body.items).toEqual([]);
    expect((await inject("GET", `/v1/projects?since=${s0.launchedAt}`)).body.items.length).toBe(1);
    const early = (await inject("GET", `/v1/projects/${P1}`)).body;
    expect(early.promotion).toBeNull();
    expect(early.firstPostGradId).toBeNull();
    expect(early.launcherHoldings).toBe(0);
    expect(early.topHolders).toEqual([]);
    expect(early.recentTrades).toEqual([]);

    // C binds A's referral code before buying
    const code = (await inject("GET", `/v1/referrals/code?wallet=${A.address}`)).body.code;
    const sig = await (C as any).signMessage({ message: referralMessage(P1, C.address, code) });
    r = await inject("POST", "/v1/referrals/bind", { project: P1, buyer: C.address, code, signature: sig, signatureType: "eip191" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.referrer).toBe(A.address.toLowerCase());

    await mint(C, P1, 20); // inside anti-snipe window (<=20/tx)
    await increaseTime(node.url, 301);
    await mintMany(L, P1, 300);
    await mintMany(A, P1, 4000);
    await mintMany(B, P1, 3000);
    await mint({ smart: D, owner: Downer }, P1, 100);
    await indexer.syncToHead();
    // C sells 5 back to the curve
    const cTokens = (await inject("GET", `/v1/projects/${P1}/holders?limit=500`)).body.find((h: any) => h.wallet === C.address.toLowerCase());
    expect(cTokens.count).toBe(20);
    const { db, t } = ctx.database;
    const { eq, and } = await import("drizzle-orm");
    const ids = (await db.select().from(t.nftTokens).where(and(eq(t.nftTokens.project, P1.toLowerCase()), eq(t.nftTokens.owner, C.address.toLowerCase())))).slice(0, 5).map((x) => BigInt(x.tokenId));
    await send(C, P1, encodeFunctionData({ abi: BondingNFTAbi, functionName: "burn", args: [ids, 0n] }));
    await mintMany(C, P1, 10_000 - 300 - 4000 - 3000 - 100 - 15);
    expect(Number(await read(P1, BondingNFTAbi, "phase"))).toBe(1);
    await indexer.syncToHead();

    const detail = (await inject("GET", `/v1/projects/${P1}`)).body;
    expect(detail.phase).toBe("promotion");
    expect(detail.totalSupply).toBe("10000");
    expect(detail.totalSupply).toBe(String(await read(P1, BondingNFTAbi, "totalSupply")));
    expect(detail.progressBps).toBe(10_000);
    expect(detail.promotionStage).toBe(Number(await read(P1, BondingNFTAbi, "promotionStage")));
    expect(detail.promotionStage).toBe(1);
    expect(BigInt(detail.reserveBnb)).toBe(await read(P1, BondingNFTAbi, "reserveBnb"));
    expect(BigInt(detail.spotPriceWei)).toBe(await read(P1, BondingNFTAbi, "spotPrice"));
    expect(BigInt(detail.virtualBnb)).toBe(await read(P1, BondingNFTAbi, "virtualBnb"));
    expect(detail.holders).toBe(5);
    // detail blocks
    expect(detail.launcherHoldings).toBe(300);
    expect(detail.topHolders[0]).toEqual({ wallet: A.address.toLowerCase(), count: 4000 });
    expect(detail.topHolders.length).toBe(5);
    expect(detail.topHolders.reduce((s: number, h: any) => s + h.count, 0)).toBe(10_000);
    expect(detail.recentTrades.length).toBe(20);
    const t0 = detail.recentTrades[0];
    expect(t0).toMatchObject({ wallet: C.address.toLowerCase(), side: "mint", project: P1.toLowerCase() });
    expect(t0.tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(t0.bnb).toMatch(/^\d+$/);
    expect(t0.fee).toMatch(/^\d+$/);
    expect(typeof t0.at).toBe("number");
    expect(detail.promotion).toEqual({ shareBps: null, promoterCount: 0, postCount: 0, promoterRoot: null, attestations: [] });
    expect(detail.firstPostGradId).toBeNull();

    r = await inject("GET", "/v1/projects?filter=推广关卡中");
    expect(r.body.items.map((p: any) => p.address)).toContain(P1.toLowerCase());
  });

  it("market endpoints: hot/almost filters, trades, holders, candles, ticker, leaderboard; websocket got trades", async () => {
    let r = await inject("GET", "/v1/projects?filter=hot&sort=volume24h");
    // hot = every project (FE contract), sorted by 24h volume
    expect(r.body.items.length).toBe(1);
    r = await inject("GET", "/v1/projects?filter=即将打满");
    expect(r.body.total).toBe(0); // P1 is no longer "trading"
    const trades = (await inject("GET", `/v1/projects/${P1}/trades?limit=200`)).body;
    expect(trades.length).toBeGreaterThan(80);
    expect(trades.some((t: any) => t.side === "burn")).toBe(true);
    expect(trades.every((t: any) => t.side === "mint" || t.side === "burn")).toBe(true);
    const burn = trades.find((t: any) => t.side === "burn");
    expect(burn).toMatchObject({ wallet: C.address.toLowerCase(), agentId: "gamma.ai", count: 5 });
    for (const k of ["trader", "txHash", "ts", "bnbWei", "feeWei"]) expect(burn).not.toHaveProperty(k);
    // pagination + sort aliases + default limit
    const all = (await inject("GET", "/v1/projects")).body;
    expect(all.items.length).toBe(1);
    expect(all.nextCursor).toBeNull();
    for (const [alias, real] of [["new", "created"], ["volume", "volume24h"], ["mcap", "marketcap"], ["progress", "progress"]]) {
      expect((await inject("GET", `/v1/projects?sort=${alias}`)).body.sort).toBe(real);
    }
    const holders = (await inject("GET", `/v1/projects/${P1}/holders`)).body; // FE Holder[]
    expect(holders.reduce((s: number, h: any) => s + h.count, 0)).toBe(10_000);
    expect(holders[0].wallet).toBe(A.address.toLowerCase());
    expect(holders.find((h: any) => h.isLauncher).count).toBe(300);
    const c = (await inject("GET", `/v1/projects/${P1}/candles?tf=1m`)).body; // FE Candle[] (BNB numbers, avg fill/NFT)
    expect(c.length).toBeGreaterThan(0);
    expect(typeof c[0].o).toBe("number");
    expect(c.at(-1).c).toBeGreaterThan(c[0].o);
    const ticker = (await inject("GET", "/v1/trades/recent?limit=10")).body;
    expect(ticker.length).toBe(10);
    expect(ticker[0].symbol).toBe("AGC");
    expect(ticker[0].name).toBe("Agent Coin");
    expect(["mint", "burn"]).toContain(ticker[0].side);
    expect(ticker[0].wallet).toMatch(/^0x[0-9a-f]{40}$/);
    const lb = (await inject("GET", "/v1/leaderboard?sort=launches")).body;
    expect(lb.items[0].agentId).toBe("launcher.ai");
    expect(lb.items[0].launches).toBe(1);
    await new Promise((res) => setTimeout(res, 200));
    expect(wsMessages.filter((m) => m.type === "trade").length).toBeGreaterThan(80);
    expect(wsMessages.some((m) => m.type === "project" && m.data.type === "promotion")).toBe(true);
    // charity: 20% of every curve trading fee is credited to Binance Charity in FeeSplitter; /v1/stats reads it
    const donated = (await read(dep.contracts.FeeSplitter, FeeSplitterAbi, "totalDonated")) as bigint;
    expect(donated).toBeGreaterThan(0n);
    const st = (await inject("GET", "/v1/stats")).body;
    expect(st.charity).toMatchObject({ source: "chain", address: "0x8b99f3660622e21f2910ecca7fbe51d654a1517d", shareBps: 2000, totalDonatedWei: donated.toString(), flushedWei: "0" });
    // index-derived figure (per-trade floor of fee * 20%) matches the contract exactly
    const fees = (await ctx.database.db.select({ f: ctx.database.t.trades.feeWei }).from(ctx.database.t.trades)).map((x: any) => BigInt(x.f));
    expect(fees.reduce((a: bigint, f: bigint) => a + (f * 2000n) / 10000n, 0n)).toBe(donated);
    expect(BigInt(st.feesWei)).toBe(fees.reduce((a: bigint, f: bigint) => a + f, 0n));
    // permissionless flush pays the charity wallet
    const before = await pc.getBalance({ address: "0x8B99F3660622e21f2910ECCA7fBe51d654a1517D" });
    await send(E, dep.contracts.FeeSplitter, encodeFunctionData({ abi: FeeSplitterAbi, functionName: "flushCharity", args: [] })); // E is not an agent
    expect(await pc.getBalance({ address: "0x8B99F3660622e21f2910ECCA7fBe51d654a1517D" })).toBe(before + donated);
    expect(await read(dep.contracts.FeeSplitter, FeeSplitterAbi, "totalFlushed")).toBe(donated);
  });

  it("promotion gate: codes, one post per agent, near-duplicate rejection, exclusions -> attestation graduates P1", async () => {
    const now = await chainNow(pc);
    const code = async (w: string) => (await inject("GET", `/v1/promotion/${P1}/code?wallet=${w}`)).body;
    const cA = await code(A.address);
    const cB = await code(B.address);
    const cC = await code(C.address);
    const cL = await code(L.address);
    expect(cA.tag).toBe("#AP_AGC");
    expect(cA.code).not.toBe(cB.code);
    const aPost = x.addPost({ authorUsername: "alpha_bot", text: `${cA.tag} ${cA.code} Agent Coin is the most fun experiment of autonomous agents trading memes on BNB chain`, createdAt: now + 5, likes: 50, reposts: 4 });
    const cPost = x.addPost({ authorUsername: "gamma_bot", text: `${cC.tag} ${cC.code} Agent Coin is the most fun experiment of autonomous agents trading memes on BNB chain!!`, createdAt: now + 6, likes: 40 });
    const bPost = x.addPost({ authorUsername: "beta_bot", text: `Just sold out: ${cB.tag} hit 20 BNB in record time, my agent is holding for the DEX listing ${cB.code}`, createdAt: now + 7, likes: 30, reposts: 5, replies: 3 });
    const bPost2 = x.addPost({ authorUsername: "beta_bot", text: `second shill ${cB.tag} ${cB.code} totally different words here about pancakes`, createdAt: now + 8, replyToId: bPost.id });
    const lPost = x.addPost({ authorUsername: "launcher_bot", text: `launcher shill ${cL.tag} ${cL.code} come promote with us`, createdAt: now + 9, likes: 10 });
    const aOld = x.addPost({ authorUsername: "alpha_bot", text: `${cA.tag} old post without code`, createdAt: now - 3600 });
    const aRetweet = x.addPost({ authorUsername: "alpha_bot", text: "", isRepost: true, createdAt: now + 10 });

    // no X search: nothing counts until the promoter submits its URL
    let tick = (await inject("POST", "/v1/admin/jobs/promotion/run", {}, ADMIN)).body;
    expect(tick.find((a: any) => a.project === P1.toLowerCase()).action).toBe("wait");

    const submit = (wallet: Address, post: { id: string; authorUsername: string }) => inject("POST", "/v1/promotions/submit", { project: P1, wallet, url: x.url(post as any) });
    // rejected submissions
    expect((await submit(A.address, aOld)).body.error.code).toBe("missing_code");
    expect((await submit(A.address, aRetweet)).body.error.code).toBe("repost_unverifiable");
    expect((await submit(A.address, bPost)).body.error.code).toBe("wrong_author"); // B's post submitted for A's wallet
    expect((await inject("POST", "/v1/promotions/submit", { project: P1, wallet: A.address, url: "https://example.com/nope" })).body.error.code).toBe("bad_tweet_url");
    expect((await inject("POST", "/v1/promotions/submit", { project: P1, wallet: A.address, url: "https://x.com/alpha_bot/status/99999999999" })).status).toBe(404);
    // accepted submissions (original posts + a reply)
    const sub = await submit(B.address, bPost);
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body).toMatchObject({ tweetId: bPost.id, kind: "original", status: "accepted", wallet: B.address });
    expect((await submit(B.address, bPost2)).body).toMatchObject({ kind: "reply", status: "agent_already_counted" });
    for (const [w, p] of [[A.address, aPost], [C.address, cPost], [L.address, lPost]] as const) expect((await submit(w, p)).status).toBe(200);
    // legacy route (agent resolved from the post author) still works and is idempotent
    expect((await inject("POST", `/v1/promotion/${P1}/posts`, { tweetUrl: x.url(bPost) })).status).toBe(200);

    tick = (await inject("POST", "/v1/admin/jobs/promotion/run", {}, ADMIN)).body;
    const act = tick.find((a: any) => a.project === P1.toLowerCase());
    expect(act.action).toBe("attest:threshold");
    expect(act.shareBps).toBe(Math.floor((7000 * 10_000) / 9700)); // A+B over (10,000 - launcher 300)
    expect(Number(await read(P1, BondingNFTAbi, "phase"))).toBe(2);

    await indexer.syncToHead();
    const st = (await inject("GET", `/v1/promotion/${P1}`)).body;
    const statuses = Object.fromEntries(st.evaluation.verdicts.map((v: any) => [v.tweetId, v.status]));
    const counts: Record<string, number> = {};
    for (const s of Object.values(statuses) as string[]) counts[s] = (counts[s] ?? 0) + 1;
    expect(counts.accepted).toBe(2);
    expect(counts.duplicate_text).toBe(1);
    expect(counts.agent_already_counted).toBe(1);
    expect(counts.excluded).toBe(1);
    expect(st.evaluation.promoters.sort()).toEqual([A.address.toLowerCase(), B.address.toLowerCase()].sort());
    expect(st.attestations[0].root).toBe(await read(P1, BondingNFTAbi, "promoterRoot"));

    const detail = (await inject("GET", `/v1/projects/${P1}`)).body;
    expect(detail.phase).toBe("graduated");
    expect(detail.promotionStage).toBe(4);
    expect(detail.forcedGraduation).toBe(false);
    expect(detail.promotion.shareBps).toBe(Math.floor((7000 * 10_000) / 9700));
    expect(detail.promotion.promoterCount).toBe(2);
    expect(detail.promotion.postCount).toBe(2);
    expect(detail.promotion.promoterRoot).toBe(await read(P1, BondingNFTAbi, "promoterRoot"));
    expect(detail.promotion.attestations.length).toBeGreaterThanOrEqual(1);
    expect(detail.promotion.attestations[0]).toMatchObject({ promoterRoot: detail.promotion.promoterRoot, tx: expect.stringMatching(/^0x/) });
    expect(detail.firstPostGradId).toBe(String(await read(P1, BondingNFTAbi, "firstPostGradId")));
    expect(detail.pair).toMatch(/^0x/);
    const grad = (await inject("GET", "/v1/projects?filter=已上链")).body;
    expect(grad.items[0].address).toBe(P1.toLowerCase());
    expect((await inject("GET", "/v1/projects?phase=graduated")).body.items[0].address).toBe(P1.toLowerCase());
  });

  it("promoter proof unlocks the 24h lock for promoters only", async () => {
    const pr = (await inject("GET", `/v1/promotion/${P1}/proof/${A.address}`)).body;
    expect(pr.proof).toBeDefined();
    await send(deployer, P1, encodeFunctionData({ abi: BondingNFTAbi, functionName: "claimPromoterExemption", args: [A.address, pr.proof] }));
    expect(await read(P1, BondingNFTAbi, "isPromoter", [A.address])).toBe(true);
    const { db, t } = ctx.database;
    const { eq, and } = await import("drizzle-orm");
    const tokA = (await db.select().from(t.nftTokens).where(and(eq(t.nftTokens.project, P1.toLowerCase()), eq(t.nftTokens.owner, A.address.toLowerCase()))).limit(1))[0]!;
    const tokC = (await db.select().from(t.nftTokens).where(and(eq(t.nftTokens.project, P1.toLowerCase()), eq(t.nftTokens.owner, C.address.toLowerCase()))).limit(1))[0]!;
    expect(await read(P1, BondingNFTAbi, "isLocked", [A.address, BigInt(tokA.tokenId)])).toBe(false);
    expect(await read(P1, BondingNFTAbi, "isLocked", [C.address, BigInt(tokC.tokenId)])).toBe(true);
    expect((await inject("GET", `/v1/promotion/${P1}/proof/${C.address}`)).status).toBe(404);
  });

  it("graduated: PancakeSwap pool price from Sync, router swap shows in ticker/trades/candles; NFT rarity from VRF seeds", async () => {
    await indexer.syncToHead();
    let d = (await inject("GET", `/v1/projects/${P1}`)).body;
    expect(d.priceSource).toBe("pool");
    const pairAbi = [{ type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }] }, { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
    const [r0, r1] = (await read(d.pair, pairAbi, "getReserves")) as [bigint, bigint, number];
    const t0 = ((await read(d.pair, pairAbi, "token0")) as string).toLowerCase();
    const [rb, rt] = t0 === d.token ? [r1, r0] : [r0, r1];
    expect(d.pool).toMatchObject({ reserveBnb: rb.toString(), reserveToken: rt.toString() });
    expect(d.spotPriceWei).toBe(((rb * 10n ** 18n) / rt).toString());
    expect(d.marketCapBnb).toBe(((rb * 10n ** 27n) / rt).toString());
    // buy on the PancakeSwap V2 router (real UniswapV2 bytecode)
    const routerAbi = [{ type: "function", name: "swapExactETHForTokens", stateMutability: "payable", inputs: [{ name: "amountOutMin", type: "uint256" }, { name: "path", type: "address[]" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }], outputs: [{ type: "uint256[]" }] }] as const;
    const before = BigInt(d.spotPriceWei);
    await send(E, dep.contracts.MockPancakeRouter, encodeFunctionData({ abi: routerAbi, functionName: "swapExactETHForTokens", args: [0n, [dep.contracts.MockWETH, d.token], E.address, BigInt((await chainNow(pc)) + 600)] }), 10n ** 18n);
    await indexer.syncToHead();
    d = (await inject("GET", `/v1/projects/${P1}`)).body;
    expect(BigInt(d.spotPriceWei)).toBeGreaterThan(before);
    const tick = (await inject("GET", "/v1/ticker")).body;
    expect(tick[0]).toMatchObject({ project: P1.toLowerCase(), venue: "pool", side: "mint", wallet: E.address.toLowerCase(), bnb: (10n ** 18n).toString(), fee: "0" });
    const tr = (await inject("GET", `/v1/projects/${P1}/trades?limit=5`)).body;
    expect(tr[0].venue).toBe("pool");
    const c = (await inject("GET", `/v1/projects/${P1}/candles?tf=1d`)).body;
    expect(c.at(-1).c).toBeCloseTo(Number(BigInt(d.nftPriceWei)) / 1e18, 9);
    expect((await inject("GET", "/v1/projects?filter=hot")).body.items.map((p: any) => p.address)).toContain(P1.toLowerCase());
    // NFT traits: fulfil the mock VRF requests, then the metadata job derives rarity from traitSeed (default table;
    // collection.json is unreachable here, so after the retry threshold the default rarity table is used)
    const vrfAbi = [{ type: "function", name: "fulfill", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }, { name: "word", type: "uint256" }], outputs: [] }] as const;
    const { db, t } = ctx.database;
    const { eq, desc: dsc } = await import("drizzle-orm");
    const tok = (await db.select().from(t.nftTokens).where(eq(t.nftTokens.project, P1.toLowerCase())).orderBy(dsc(t.nftTokens.tokenId)).limit(3));
    for (const x of tok) {
      const req = (await read(P1, BondingNFTAbi, "seedRequestOf", [BigInt(x.tokenId)])) as bigint;
      if (req === 0n) continue;
      if (((await read(dep.contracts.TraitRandomness, [{ type: "function", name: "randomWordOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] }], "randomWordOf", [req])) as bigint) !== 0n) continue;
      await send(deployer, dep.contracts.MockVRFCoordinator, encodeFunctionData({ abi: vrfAbi, functionName: "fulfill", args: [req, 123456789n + req] }));
    }
    const { metadataTick, setMetadataFetcher } = await import("../../src/services/metadata.js");
    setMetadataFetcher(async () => { throw new Error("offline"); });
    await db.update(t.projects).set({ metaStatus: "error", metaAttempts: 3, metaCheckedAt: 0 }).where(eq(t.projects.address, P1.toLowerCase()));
    await metadataTick(ctx);
    setMetadataFetcher(null);
    const nfts = (await inject("GET", `/v1/projects/${P1}/nfts?limit=500`)).body;
    const byId = new Map(nfts.map((n: any) => [n.tokenId, n]));
    for (const x of tok) {
      const seed = (await read(P1, BondingNFTAbi, "traitSeed", [BigInt(x.tokenId)])) as bigint;
      const n: any = byId.get(x.tokenId);
      if (seed === 0n) expect(n.rarity).toBeNull();
      else expect(["common", "rare", "epic", "legendary"]).toContain(n.rarity);
    }
    expect(nfts.some((n: any) => n.rarity)).toBe(true);
  });

  it("second project: low share root is attested, then forced graduation after 2h", async () => {
    await increaseTime(node.url, 86_400 + 10); // launch cooldown
    P2 = await launch(L, "Second Coin", "SEC");
    await increaseTime(node.url, 301);
    await mintMany(L, P2, 100);
    await mint({ smart: D, owner: Downer }, P2, 100);
    await mintMany(A, P2, 9_800);
    await indexer.syncToHead();
    expect((await inject("GET", `/v1/projects/${P2}`)).body.phase).toBe("promotion");

    const now = await chainNow(pc);
    const cD = (await inject("GET", `/v1/promotion/${P2}/code?wallet=${D}`)).body;
    dPost = x.addPost({ authorUsername: "delta_bot", text: `${cD.tag} ${cD.code} smart wallet agent reporting for duty`, createdAt: now + 3, likes: 9, quotes: 2, quoteOfId: "1" });
    const dSub = await inject("POST", "/v1/promotions/submit", { project: P2, wallet: D, url: x.url(dPost) });
    expect(dSub.status, JSON.stringify(dSub.body)).toBe(200);
    expect(dSub.body).toMatchObject({ kind: "quote", status: "accepted" }); // quote posts carry their own text + code
    let tick = (await inject("POST", "/v1/admin/jobs/promotion/run", {}, ADMIN)).body;
    let act = tick.find((a: any) => a.project === P2.toLowerCase());
    expect(act.action).toBe("attest:update_root");
    expect(act.shareBps).toBe(Math.floor((100 * 10_000) / 9_900));
    expect(Number(await read(P2, BondingNFTAbi, "phase"))).toBe(1);

    tick = (await inject("POST", "/v1/admin/jobs/promotion/run", {}, ADMIN)).body; // nothing changed -> wait
    expect(tick.find((a: any) => a.project === P2.toLowerCase()).action).toBe("wait");

    await increaseTime(node.url, 7_200);
    tick = (await inject("POST", "/v1/admin/jobs/promotion/run", {}, ADMIN)).body;
    act = tick.find((a: any) => a.project === P2.toLowerCase());
    expect(act.action).toBe("graduate");
    expect(act.txHash).toMatch(/^0x/);
    await indexer.syncToHead();
    const d2 = (await inject("GET", `/v1/projects/${P2}`)).body;
    expect(d2.phase).toBe("graduated");
    expect(d2.forcedGraduation).toBe(true);
    // cursor pagination over two projects
    const pg1 = (await inject("GET", "/v1/projects?limit=1&sort=new")).body;
    expect(pg1.items[0].address).toBe(P2.toLowerCase());
    expect(pg1.nextCursor).toEqual(expect.any(String));
    const pg2 = (await inject("GET", `/v1/projects?limit=1&sort=new&cursor=${pg1.nextCursor}`)).body;
    expect(pg2.items[0].address).toBe(P1.toLowerCase());
    expect(pg2.nextCursor).toBeNull();
    expect((await inject("GET", "/v1/projects?cursor=zzzz")).body.error.code).toBe("bad_cursor");
    const pr = (await inject("GET", `/v1/promotion/${P2}/proof/${D}`)).body;
    await send(deployer, P2, encodeFunctionData({ abi: BondingNFTAbi, functionName: "claimPromoterExemption", args: [D, pr.proof] }));
    expect(await read(P2, BondingNFTAbi, "isPromoter", [D])).toBe(true);

    const lb = (await inject("GET", "/v1/leaderboard?sort=graduations")).body;
    expect(lb.items[0].wallet).toBe(L.address.toLowerCase());
    expect(lb.items[0].graduations).toBe(2);
  });

  it("daily reward job: engagement + referral allocation, root posted, claim via proof", async () => {
    const pool = (await read(dep.contracts.RewardPool, RewardPoolAbi, "unallocated")) as bigint;
    expect(pool).toBeGreaterThan(0n);
    const to = (await chainNow(pc)) + 1;
    epoch = epochOf(to);
    x.posts.get(dPost.id)!.likes = 12; // engagement grew after submission: settlement re-fetches submitted URLs by id
    x.fetched.length = 0;
    const r = (await inject("POST", "/v1/admin/jobs/rewards/run", { epoch, from: windowFrom, to }, ADMIN)).body;
    expect(r.status, JSON.stringify(r)).toBe("posted");
    expect(BigInt(r.total)).toBeLessThanOrEqual(pool);
    expect(BigInt(r.total)).toBeGreaterThan((pool * 999n) / 1000n); // only flooring dust left
    const sum = r.allocations.reduce((s: bigint, a: any) => s + BigInt(a.amount), 0n);
    expect(sum).toBe(BigInt(r.total));
    const byW = Object.fromEntries(r.allocations.map((a: any) => [a.wallet, a]));
    // A: engagement + all referral volume from C's buys; C's duplicate post earns nothing
    expect(BigInt(byW[A.address.toLowerCase()].referralWei)).toBeGreaterThan(0n);
    expect(byW[C.address.toLowerCase()]).toBeUndefined();
    expect(byW[B.address.toLowerCase()].engagementScore).toBe(30 + 2 * 5 + 2 * 3 + 0); // best post counted
    expect(byW[D.toLowerCase()].engagementScore).toBe(12 + 3 * 2);
    expect(x.fetched).toContain(dPost.id);
    const onchain = (await read(dep.contracts.RewardPool, RewardPoolAbi, "epochs", [BigInt(epoch)])) as readonly any[];
    expect(onchain[0]).toBe(r.root);

    await indexer.syncToHead();
    const mine = (await inject("GET", `/v1/rewards/${A.address}`)).body;
    expect(mine.items.length).toBe(1);
    const it0 = mine.items[0];
    const before = await pc.getBalance({ address: A.address });
    await send(deployer, dep.contracts.RewardPool, it0.calldata); // relayed claim: funds go to A
    const after = await pc.getBalance({ address: A.address });
    expect(after - before).toBe(BigInt(it0.amountWei));
    await indexer.syncToHead();
    expect((await inject("GET", `/v1/rewards/${A.address}`)).body.items[0].claimed).toBe(true);
    const again = (await inject("POST", "/v1/admin/jobs/rewards/run", { epoch, from: windowFrom, to }, ADMIN)).body;
    expect(again.skipped).toBe(true);
  });

  it("sybil: wallets funded by one source are clustered; admin removes one from the whitelist", async () => {
    const fresh = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));
    for (const w of fresh) await send(F, w.address, "0x", parseEther("1"));
    for (const [i, w] of fresh.entries()) await registerAgent(w, { agentId: `sybil${i}.ai`, handle: `sybil_${i}`, intent: "trade" });
    expect((await inject("GET", "/v1/admin/sybil/clusters")).status).toBe(401);
    const scan = (await inject("POST", "/v1/admin/jobs/sybil/run", {}, ADMIN)).body;
    expect(scan.clusters.length).toBe(1);
    expect(scan.clusters[0].wallets.sort()).toEqual(fresh.map((w) => w.address.toLowerCase()).sort());
    expect(scan.clusters[0].funders).toEqual([F.address.toLowerCase()]);
    const cl = (await inject("GET", "/v1/admin/sybil/clusters", undefined, ADMIN)).body;
    expect(cl[0].wallets.length).toBe(3);
    const rm = (await inject("POST", `/v1/admin/agents/${fresh[0]!.address}/remove`, { reason: "sybil cluster" }, ADMIN)).body;
    expect(rm.status).toBe("confirmed");
    expect(await read(dep.contracts.AgentRegistry, AgentRegistryAbi, "canTrade", [fresh[0]!.address])).toBe(false);
    await indexer.syncToHead();
    expect((await inject("GET", `/v1/agents/${fresh[0]!.address}`)).body.removed).toBe(true);
    // flagged agents never earn rewards; removed agents cannot re-register
    const ch = await inject("POST", "/v1/register/challenge", { agentId: "sybil0.ai", wallet: fresh[0]!.address, xHandle: "sybil_0" });
    const sp = x.addPost({ authorUsername: "sybil_0", text: ch.body.xPostText });
    const v = await inject("POST", "/v1/register/verify", { challengeId: ch.body.challengeId, signature: await (fresh[0] as any).signMessage({ message: ch.body.message }), tweetUrl: x.url(sp) });
    expect(v.status).toBe(403);
  });

  it("eligibility posts: wallet-signed fresh submission re-qualifies; wrong signer / stale / foreign posts rejected", async () => {
    const fresh = x.seedActivity("launcher_bot", 10, 200);
    const ids = fresh.map((u) => u.split("/").pop()!);
    const issuedAt = Math.floor(Date.now() / 1000);
    const td = eligibilityPostsTypedData(31337, dep.contracts.AgentRegistry, L.address, ids, issuedAt);
    const bad = await inject("POST", "/v1/agents/eligibility-posts", { wallet: L.address, postUrls: fresh, issuedAt, signature: await (A as any).signTypedData(td) });
    expect(bad.status).toBe(401);
    const stale = await inject("POST", "/v1/agents/eligibility-posts", { wallet: L.address, postUrls: fresh, issuedAt: issuedAt - 3600, signature: await (L as any).signTypedData(eligibilityPostsTypedData(31337, dep.contracts.AgentRegistry, L.address, ids, issuedAt - 3600)) });
    expect(stale.body.error.code).toBe("stale_signature");
    const foreign = x.url(x.addPost({ authorUsername: "alpha_bot", text: "not mine" }));
    const urls = [...fresh, foreign];
    const td2 = eligibilityPostsTypedData(31337, dep.contracts.AgentRegistry, L.address, urls.map((u) => u.split("/").pop()!), issuedAt);
    const ok = await inject("POST", "/v1/agents/eligibility-posts", { wallet: L.address, postUrls: urls, issuedAt, signature: await (L as any).signTypedData(td2) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ launchEnabled: true, requalified: true });
    expect(ok.body.eligibility).toMatchObject({ eligible: true, posts30d: 10, engagementBps: 100 });
    expect(ok.body.eligibility.rejectedPosts).toEqual([{ url: foreign, reason: "wrong_author (@alpha_bot)" }]);
  });

  it("30-day requalification revokes launch rights of agents that no longer qualify", async () => {
    const u = await x.getUserByUsername("launcher_bot");
    u!.followers = 1200; // dropped below 5000
    const res = (await inject("POST", "/v1/admin/jobs/requalify/run", { now: Math.floor(Date.now() / 1000) + 31 * 86400 }, ADMIN)).body;
    expect(res.checked).toBe(1);
    expect(res.results[0].wallet).toBe(L.address.toLowerCase());
    expect(res.results[0].eligible).toBe(false);
    // user re-fetched (followers) + stored post URLs re-fetched: 31 days on, they're all outside the 30-day window
    expect(res.results[0].reasons.join(" ")).toContain("followers 1200 < 5000");
    expect(res.results[0].reasons.join(" ")).toContain("submitted posts from the last 30d 0 < 10");
    expect(res.results[0].tx.status).toBe("confirmed");
    expect(await read(dep.contracts.AgentRegistry, AgentRegistryAbi, "canLaunch", [L.address])).toBe(false);
    expect(await read(dep.contracts.AgentRegistry, AgentRegistryAbi, "canTrade", [L.address])).toBe(true);
    await indexer.syncToHead();
    expect((await inject("GET", `/v1/agents/${L.address}`)).body.canLaunch).toBe(false);
    const txs = (await inject("GET", "/v1/admin/txs", undefined, ADMIN)).body;
    expect(txs.some((t: any) => t.kind === "revokeLaunch" && t.status === "confirmed")).toBe(true);
    expect(zeroHash).toBeDefined();
  });
});
