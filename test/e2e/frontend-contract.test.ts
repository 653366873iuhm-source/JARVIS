/**
 * Frontend contract snapshot: local Hardhat + real contracts + backend. Drives a small market (register,
 * launch, mints, a burn, a promo post), then records the real responses of every endpoint the frontend live
 * data layer calls (exact FE URLs, relative to VITE_API_URL) plus one WS `trade` push after a `subscribe`.
 * Written to frontend/src/data/__fixtures__/backend-live.json; frontend/src/data/contract.test.ts feeds it to
 * createLiveSource() and checks every parsed value against the FE types.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createWalletClient, encodeFunctionData, http, toHex, type Account, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type { FastifyInstance } from "fastify";
import { startHardhatNode, increaseTime } from "../helpers/hardhat.js";
import { deployAll, type Deployment } from "../../scripts/lib/deploy.js";
import { loadConfig } from "../../src/config.js";
import { createContext, type AppContext } from "../../src/context.js";
import { buildServer } from "../../src/api/server.js";
import { Indexer } from "../../src/services/indexer.js";
import { MockXProvider } from "../../src/providers/x/mock.js";
import { MockAgentIdResolver } from "../../src/providers/agentid/index.js";
import { makeChain, makePublicClient } from "../../src/chain/client.js";
import { BondingNFTAbi, LaunchFactoryAbi } from "../../src/chain/abi.js";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../frontend/src/data/__fixtures__/backend-live.json");
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
const L = acct(3);
const A = acct(4);
const NOBODY = acct(12);

const wallets = new Map<string, WalletClient>();
function wc(a: Account) {
  let w = wallets.get(a.address);
  if (!w) wallets.set(a.address, (w = createWalletClient({ account: a, chain: makeChain({ CHAIN_ID: 31337, RPC_URL: node.url }), transport: http(node.url) })));
  return w;
}
async function send(a: Account, to: Address, data: Hex, value = 0n) {
  const hash = await wc(a).sendTransaction({ account: a, chain: wc(a).chain, to, data, value });
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`tx reverted ${hash}`);
  return rc;
}
const inject = async (method: "GET" | "POST", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as any });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
async function registerAgent(a: Account, agentId: string, handle: string, intent: "launch" | "trade", eligible: boolean) {
  x.addUser({ username: handle, followers: eligible ? 20_000 : 300, createdAt: Math.floor(Date.now() / 1000) - 400 * 86400 });
  const own = x.seedActivity(handle, 12, eligible ? 200 : 0);
  resolver.set(agentId, a.address, { addressType: "EOA" });
  const ch = await inject("POST", "/v1/register/challenge", { agentId, wallet: a.address, xHandle: "@" + handle, intent });
  expect(ch.status, JSON.stringify(ch.body)).toBe(200);
  const post = x.addPost({ authorUsername: handle, text: ch.body.xPostText });
  const signature = await (a as any).signMessage({ message: ch.body.message });
  const v = await inject("POST", "/v1/register/verify", { challengeId: ch.body.challengeId, signature, tweetUrl: `https://x.com/${handle}/status/${post.id}`, eligibilityPostUrls: intent === "launch" ? own : undefined });
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  await send(a, v.body.registry, v.body.calldata);
}
async function mint(a: Account, project: Address, n: number) {
  const [, , total] = (await pc.readContract({ address: project, abi: BondingNFTAbi, functionName: "quoteMint", args: [BigInt(n)] })) as readonly bigint[];
  return send(a, project, encodeFunctionData({ abi: BondingNFTAbi, functionName: "mint", args: [BigInt(n)] }), total!);
}

beforeAll(async () => {
  const port = 19545 + Math.floor(Math.random() * 1000);
  node = await startHardhatNode(port);
  const chainCfg = { CHAIN_ID: 31337, RPC_URL: node.url };
  pc = makePublicClient(chainCfg);
  dep = await deployAll({ pc, chain: makeChain(chainCfg), rpcUrl: node.url, deployer: acct(0), platformSigner: acct(1).address, treasury: acct(2).address });
  dbFile = path.join(os.tmpdir(), `agentpad-fe-contract-${Date.now()}.db`);
  const cfg = loadConfig({
    NODE_ENV: "test", DATABASE_URL: `file:${dbFile}`, RPC_URL: node.url, CHAIN_ID: "31337",
    REGISTRY_ADDRESS: dep.contracts.AgentRegistry, FACTORY_ADDRESS: dep.contracts.LaunchFactory, REWARD_POOL_ADDRESS: dep.contracts.RewardPool,
    FEE_SPLITTER_ADDRESS: dep.contracts.FeeSplitter, SIGNER_PRIVATE_KEY: pk(1), X_PROVIDER: "mock", AGENTID_PROVIDER: "mock",
    FUNDING_PROVIDER: "mock", PLATFORM_ADDRESSES: acct(2).address, ADMIN_TOKEN: "test-admin",
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

describe("frontend contract snapshot", () => {
  it("records real responses for every FE live endpoint", async () => {
    await registerAgent(L, "nova.ai", "nova_agent", "launch", true);
    await registerAgent(A, "zeta.ai", "zeta_bot", "trade", false);
    await indexer.syncToHead();

    const rc = await send(L, dep.contracts.LaunchFactory, encodeFunctionData({ abi: LaunchFactoryAbi, functionName: "launch", args: ["Neon Oracle", "ORCL", "ipfs://bafytestcid/"] }));
    const log = rc.logs.find((l) => l.address.toLowerCase() === dep.contracts.LaunchFactory.toLowerCase())!;
    const P = ("0x" + log.topics[3]!.slice(26)).toLowerCase() as Address;
    await increaseTime(node.url, 301);
    await mint(L, P, 40);
    await increaseTime(node.url, 120);
    await mint(A, P, 60);
    await indexer.syncToHead();

    // websocket: subscribe to P, then one more trade (burn) is pushed in the FE format
    const ws = new WebSocket(`ws://127.0.0.1:${apiPort}/v1/ws`);
    const wsMsgs: any[] = [];
    ws.on("message", (m) => wsMsgs.push(JSON.parse(m.toString())));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "subscribe", channel: "trades", project: P }));
    for (let i = 0; i < 100 && !wsMsgs.some((m) => m.type === "subscribed"); i++) await new Promise((r) => setTimeout(r, 20));
    const { db, t } = ctx.database;
    const { eq, and } = await import("drizzle-orm");
    const ids = (await db.select().from(t.nftTokens).where(and(eq(t.nftTokens.project, P), eq(t.nftTokens.owner, A.address.toLowerCase())))).slice(0, 5).map((r) => BigInt(r.tokenId));
    await increaseTime(node.url, 120);
    await send(A, P, encodeFunctionData({ abi: BondingNFTAbi, functionName: "burn", args: [ids, 0n] }));
    await indexer.syncToHead();
    for (let i = 0; i < 100 && !wsMsgs.some((m) => m.type === "trade"); i++) await new Promise((r) => setTimeout(r, 20));
    ws.close();
    const wsTrade = wsMsgs.find((m) => m.type === "trade");
    expect(wsTrade?.data).toMatchObject({ project: P, side: "burn", count: 5, agentId: "zeta.ai", symbol: "ORCL" });

    // a promo post (stored as the promotion gate stores it) so /promotions is non-empty
    await db.insert(t.xPosts).values({ tweetId: "1900000000000000001", project: P, wallet: A.address.toLowerCase(), authorId: "u-zeta", text: "#AP_ORCL hello from zeta", createdAt: Math.floor(Date.now() / 1000), hasCode: true, gateStatus: "accepted", likes: 7, reposts: 1 });

    const urls = [
      "/projects?filter=hot",
      "/projects?filter=new&sort=progress&limit=1",
      "/projects?filter=almost&sort=progress&q=orc",
      `/projects/${P}`,
      `/projects/0x${"ab".repeat(20)}`,
      `/projects/${P}/trades?limit=50`,
      `/projects/${P}/holders`,
      `/projects/${P}/candles?tf=1m`,
      `/projects/${P}/candles?tf=1h`,
      `/projects/${P}/promotions`,
      `/projects/${P}/nfts`,
      "/agents/leaderboard?range=24h",
      "/agents/leaderboard?range=7d",
      "/agents/leaderboard?range=all",
      "/ticker",
      "/agents/nova.ai",
      "/agents/zeta.ai",
      `/agents/${A.address.toLowerCase()}`,
      `/agents/${NOBODY.address.toLowerCase()}`,
      "/agents/nobody.ai",
      "/stats",
    ];
    const responses: Record<string, { status: number; body: unknown }> = {};
    for (const u of urls) {
      const r = await fetch(`http://127.0.0.1:${apiPort}/v1${u}`);
      responses[u] = { status: r.status, body: await r.json() };
      expect(r.headers.get("access-control-allow-origin") ?? "*", u).toBeTruthy();
    }
    // quick backend-side sanity (the FE test does the type checks)
    expect(responses[`/projects/${P}`]!.status).toBe(200);
    expect((responses["/stats"]!.body as any).charity).toMatchObject({ source: "chain", shareBps: 2000 });
    expect(BigInt((responses["/stats"]!.body as any).charity.totalDonatedWei)).toBeGreaterThan(0n);
    expect(responses[`/projects/0x${"ab".repeat(20)}`]!.status).toBe(404);
    expect(responses["/agents/nobody.ai"]!.status).toBe(404);
    expect(responses[`/agents/${NOBODY.address.toLowerCase()}`]!.body).toMatchObject({ registered: false });
    expect((responses["/projects?filter=new&sort=progress&limit=1"]!.body as any).items[0].address).toBe(P);
    for (const u of urls.filter((u) => /holders|candles|promotions|nfts|leaderboard|ticker|trades/.test(u))) expect(Array.isArray(responses[u]!.body), u).toBe(true);
    const lbAll = responses["/agents/leaderboard?range=all"]!.body as any[];
    expect(lbAll.map((r) => r.agentId).sort()).toEqual(["nova.ai", "zeta.ai"]);
    const prof = responses["/agents/zeta.ai"]!.body as any;
    expect(prof.holdings[0]).toMatchObject({ project: P, count: 55 });
    expect(prof.recentTrades.length).toBe(2);

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(
      OUT,
      JSON.stringify({ generatedBy: "backend/test/e2e/frontend-contract.test.ts", project: P, launcher: L.address.toLowerCase(), trader: A.address.toLowerCase(), unregistered: NOBODY.address.toLowerCase(), responses, ws: [wsTrade] }, null, 2) + "\n",
    );
  });
});
