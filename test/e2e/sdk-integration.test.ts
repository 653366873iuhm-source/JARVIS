/**
 * SDK ⇄ backend integration: local Hardhat node + real contracts + the real backend (SQLite, mocked X / Binance
 * Agent ID providers) + the TypeScript SDK (`../sdk/src`) talking to it over HTTP at `/v1`.
 *   register (two-phase register-request + registration-signature) -> launch -> quote -> mint to sell-out
 *   -> promotion code (403 checks) -> promotion gate -> graduation -> reward + promoter-exemption proofs -> claims
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createWalletClient, getAddress, http, toHex, type Address, type Hex, type PublicClient } from "viem";
import { mnemonicToAccount, privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { FastifyInstance } from "fastify";
import { startHardhatNode, increaseTime } from "../helpers/hardhat.js";
import { deployAll, type Deployment as BackendDeployment } from "../../scripts/lib/deploy.js";
import { loadConfig } from "../../src/config.js";
import { createContext, type AppContext } from "../../src/context.js";
import { buildServer } from "../../src/api/server.js";
import { Indexer } from "../../src/services/indexer.js";
import { MockXProvider } from "../../src/providers/x/mock.js";
import { MockAgentIdResolver } from "../../src/providers/agentid/index.js";
import { makeChain, makePublicClient, chainNow } from "../../src/chain/client.js";
import { epochOf } from "../../src/services/rewards.js";
// the SDK under test, straight from source
import { AgentPad, AgentPadApi, ApiError as SdkApiError, ViemSigner, agentBindingTypedData, quoteMint, type Deployment } from "../../../sdk/src/index.js";

const MNEMONIC = "test test test test test test test test test test test junk";
const acct = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const pk = (i: number) => toHex(acct(i).getHdKey().privateKey!) as Hex;
const quiet = { info() {}, warn() {}, debug() {}, error(o: unknown, m?: string) { console.error("[ctx error]", m, o); } };
const ADMIN = { authorization: "Bearer test-admin" };

let node: { url: string; stop: () => Promise<void> };
let dep: BackendDeployment;
let sdkDep: Deployment;
let ctx: AppContext;
let app: FastifyInstance;
let pc: PublicClient;
let x: MockXProvider;
let resolver: MockAgentIdResolver;
let indexer: Indexer;
let dbFile: string;
let api: AgentPadApi;

const deployer = acct(0);
const platformSigner = acct(1);
const treasury = acct(2);
const keys = { L: pk(3), A: pk(4), B: pk(5), C: pk(6), D: pk(7) };
const pads: Record<string, AgentPad> = {};

function padFor(key: Hex) {
  const account = privateKeyToAccount(key);
  const wc = createWalletClient({ account, chain: makeChain({ CHAIN_ID: 31337, RPC_URL: node.url }), transport: http(node.url) });
  return new AgentPad({ publicClient: pc as any, signer: new ViemSigner(wc as any), deployment: sdkDep, api });
}
const inject = async (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.inject({ method, url, payload: payload as any, headers });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
function seedX(handle: string, eligible: boolean): string[] {
  x.addUser({ username: handle, followers: eligible ? 20_000 : 300, createdAt: Math.floor(Date.now() / 1000) - 400 * 86400 });
  return x.seedActivity(handle, 12, eligible ? 200 : 0); // the agent's own recent post URLs (submitted for eligibility)
}
async function expectApiError(p: Promise<unknown>, status: number, code: string) {
  const e = await p.then(() => null, (err) => err);
  expect(e, `expected ${status} ${code}`).toBeInstanceOf(SdkApiError);
  expect(e.status).toBe(status);
  expect(e.code).toBe(code);
}

beforeAll(async () => {
  const port = 19545 + Math.floor(Math.random() * 1000);
  node = await startHardhatNode(port);
  const chainCfg = { CHAIN_ID: 31337, RPC_URL: node.url };
  pc = makePublicClient(chainCfg);
  dep = await deployAll({ pc, chain: makeChain(chainCfg), rpcUrl: node.url, deployer, platformSigner: platformSigner.address, treasury: treasury.address });
  sdkDep = {
    chainId: 31337, AgentRegistry: dep.contracts.AgentRegistry, LaunchFactory: dep.contracts.LaunchFactory, FeeSplitter: dep.contracts.FeeSplitter,
    RewardPool: dep.contracts.RewardPool, TraitRandomness: dep.contracts.TraitRandomness, fromBlock: 0n,
  };
  dbFile = path.join(os.tmpdir(), `agentpad-sdk-int-${Date.now()}.db`);
  const cfg = loadConfig({
    NODE_ENV: "test", DATABASE_URL: `file:${dbFile}`, RPC_URL: node.url, CHAIN_ID: "31337",
    REGISTRY_ADDRESS: dep.contracts.AgentRegistry, FACTORY_ADDRESS: dep.contracts.LaunchFactory, REWARD_POOL_ADDRESS: dep.contracts.RewardPool,
    FEE_SPLITTER_ADDRESS: dep.contracts.FeeSplitter, SIGNER_PRIVATE_KEY: pk(1), X_PROVIDER: "mock", AGENTID_PROVIDER: "mock",
    FUNDING_PROVIDER: "mock", PLATFORM_ADDRESSES: treasury.address, ADMIN_TOKEN: "test-admin",
  });
  x = new MockXProvider();
  resolver = new MockAgentIdResolver();
  ctx = await createContext(cfg, { x, resolver, log: quiet });
  app = await buildServer(ctx);
  await app.listen({ port: 0, host: "127.0.0.1" });
  api = new AgentPadApi({ baseUrl: `http://127.0.0.1:${(app.server.address() as any).port}/v1` });
  indexer = new Indexer(ctx);
  for (const [k, key] of Object.entries(keys)) pads[k] = padFor(key);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await ctx?.database.close();
  await node?.stop();
  if (dbFile) for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true });
});

describe("SDK client against the real backend", () => {
  let P: Address;
  let launchedAt: number;
  const agents = {
    L: { agentId: "launcher.ai", handle: "launcher_bot", intent: "launch" as const, eligible: true },
    A: { agentId: "alpha.ai", handle: "alpha_bot", intent: "trade" as const, eligible: false },
    B: { agentId: "beta.ai", handle: "beta_bot", intent: "trade" as const, eligible: false },
    C: { agentId: "gamma.ai", handle: "gamma_bot", intent: "trade" as const, eligible: false },
    D: { agentId: "delta.ai", handle: "delta_bot", intent: "trade" as const, eligible: false },
  };

  it("register-request validation: wrong_chain, invalid_agent_id, bad_challenge, bad_wallet_signature, 404 / 202 / 403 signature", async () => {
    const w = privateKeyToAccount(generatePrivateKey());
    seedX("probe_bot", false);
    resolver.set("probe.ai", w.address);
    const base = { agentId: "probe.ai", wallet: w.address, xHandle: "@Probe_Bot", chainId: 31337, intent: "trade" as const };
    await expectApiError(api.registerRequest({ ...base, chainId: 56 }), 400, "wrong_chain");
    await expectApiError(api.registerRequest({ ...base, agentId: "probe" }), 400, "invalid_agent_id");
    await expectApiError(api.registerRequest({ ...base, agentId: "Probe.ai" }), 400, "invalid_agent_id");
    await expectApiError(api.registrationSignature("probe.ai", w.address), 404, "not_found");

    const r1 = await api.registerRequest(base);
    expect(r1).toMatchObject({ agentId: "probe.ai", wallet: getAddress(w.address), xHandle: "probe_bot", intent: "trade", status: "awaiting_wallet_signature", reason: null });
    expect(r1.requestId).toEqual(expect.any(String));
    expect(r1.binding.expiresAt).toBeGreaterThan(r1.binding.issuedAt);
    expect(r1.xChallenge.text).toContain(r1.xChallenge.code);
    // idempotent: same request, same challenge
    const again = await api.registerRequest(base);
    expect(again.requestId).toBe(r1.requestId);
    expect(again.binding).toEqual(r1.binding);
    expect(await api.registrationSignature("probe.ai", w.address)).toEqual({ status: "pending", requestStatus: "awaiting_wallet_signature", retryAfter: expect.any(Number), reason: null });

    const td = agentBindingTypedData({ chainId: 31337, registry: dep.contracts.AgentRegistry, agentId: "probe.ai", wallet: w.address, xHandle: "probe_bot", intent: "trade", ...r1.binding });
    const sig = await w.signTypedData(td as any);
    await expectApiError(api.registerRequest({ ...base, ...r1.binding, challenge: "nope", walletSignature: sig }), 400, "bad_challenge");
    const other = privateKeyToAccount(generatePrivateKey());
    await expectApiError(api.registerRequest({ ...base, ...r1.binding, walletSignature: await other.signTypedData(td as any) }), 401, "bad_wallet_signature");

    // valid signature, no X post URL yet -> awaiting_x_proof (202); the backend never searches X
    const r2 = await api.registerRequest({ ...base, ...r1.binding, walletSignature: sig });
    expect(r2.status).toBe("awaiting_x_proof");
    expect(r2.reason).toMatch(/x_post_url_required/);
    const pend = await api.registrationSignature("probe.ai", w.address);
    expect(pend).toMatchObject({ status: "pending", requestStatus: "awaiting_x_proof" });

    // agentId now resolves elsewhere -> rejected (403 flat body, returned as a value by the SDK)
    resolver.set("probe.ai", other.address);
    const post = x.addPost({ authorUsername: "probe_bot", text: r2.xChallenge.text });
    // wallet already proven: the URL alone can be submitted (no new signature)
    const r3 = await api.registerRequest({ ...base, ...r1.binding, xProofTweetUrl: `https://x.com/probe_bot/status/${post.id}` });
    expect(r3.status).toBe("rejected");
    expect(r3.reason).toMatch(/agent_id_mismatch/);
    expect(await api.registrationSignature("probe.ai", w.address)).toEqual({ status: "rejected", reason: r3.reason });
    const raw = await fetch(`${api.baseUrl}/agents/probe.ai/registration-signature?wallet=${w.address}`);
    expect(raw.status).toBe(403);

    // after fixing the Agent ID, a new phase-1 call starts a fresh request (the post URL must be submitted again)
    resolver.set("probe.ai", w.address);
    const r4 = await api.registerRequest(base);
    expect(r4.requestId).not.toBe(r1.requestId);
    expect(r4.status).toBe("awaiting_wallet_signature");
  });

  it("registers five agents through AgentPad.register (two-phase request -> X proof -> signature -> on-chain)", async () => {
    for (const [k, a] of Object.entries(agents)) {
      const own = seedX(a.handle, a.eligible);
      const pad = pads[k]!;
      resolver.set(a.agentId, await pad.address());
      let challenged = 0;
      const res = await pad.register({
        agentId: a.agentId, xHandle: "@" + a.handle, intent: a.intent, pollMs: 500, timeoutMs: 30_000,
        eligibilityPostUrls: a.intent === "launch" ? own : undefined,
        onChallenge: async (c) => {
          challenged++;
          const post = x.addPost({ authorUsername: a.handle, text: c.text });
          return `https://x.com/${a.handle}/status/${post.id}`;
        },
      });
      expect(challenged).toBe(1);
      expect(res.tx?.receipt.status).toBe("success");
      expect(res.status.canTrade).toBe(true);
      expect(res.status.canLaunch).toBe(a.intent === "launch");
      // ready signature stays served (and is refreshed for the new nonce)
      const s = await api.registrationSignature(a.agentId, await pad.address());
      expect(s).toMatchObject({ status: "ready", chainId: 31337, agentId: a.agentId, canTrade: true });
      if (s.status === "ready") {
        expect(getAddress(s.registry)).toBe(getAddress(dep.contracts.AgentRegistry));
        expect(s.nonce).toBe("1");
        for (const f of ["expiry", "nonce", "deadline"] as const) expect(s[f]).toMatch(/^\d+$/);
      }
      // re-running is idempotent
      expect((await pad.register({ agentId: a.agentId, xHandle: a.handle, intent: a.intent })).skipped).toBe(true);
    }
    // phase-1 on an approved request returns approved
    const again = await api.registerRequest({ agentId: "alpha.ai", wallet: await pads.A!.address(), xHandle: "alpha_bot", chainId: 31337, intent: "trade" });
    expect(again.status).toBe("approved");
    await indexer.syncToHead();
  });

  it("launch, quote (pinned block) and mint to sell-out with the SDK", async () => {
    const r = await pads.L!.launch({ name: "Agent Coin", symbol: "AGC", baseURI: "ipfs://bafytestcid/" });
    P = r.project;
    await indexer.syncToHead();
    const proj = await api.getProject(P);
    expect(proj.phase).toBe("trading");
    launchedAt = proj.launchedAt;

    const q = await api.quote(P, "mint", 10);
    const local = await pads.A!.quoteMint(P, 10);
    expect(q).toMatchObject({ project: getAddress(P), side: "mint", count: 10, amount: local.cost.toString(), fee: local.fee.toString(), total: local.total.toString() });
    expect(q.blockNumber).toMatch(/^\d+$/);
    expect(q.state).toEqual({ virtualBnb: expect.stringMatching(/^\d+$/), virtualToken: expect.stringMatching(/^\d+$/), totalSupply: "0", feeBps: 100 });
    expect(quoteMint({ virtualBnb: BigInt(q.state.virtualBnb), virtualToken: BigInt(q.state.virtualToken), totalSupply: 0n, feeBps: 100n }, 10).total.toString()).toBe(q.total);
    await expectApiError(api.quote(P, "mint", 0), 400, "bad_amount");
    await expectApiError(api.quote(P, "mint", 10_001), 400, "bad_amount");
    await expectApiError(api.quote(P, "burn", 1), 400, "bad_amount"); // nothing minted yet
    await expectApiError(api.quote(`0x${"ab".repeat(20)}`, "mint", 1), 404, "not_found");

    // first mint inside anti-snipe window, checked against the quote at that state
    const m = await pads.C!.mint(P, 10);
    expect(m.cost + m.fee).toBe(BigInt(q.total));
    await increaseTime(node.url, 301);
    const plan: [string, number][] = [["L", 300], ["A", 4000], ["B", 3000], ["C", 2690]];
    for (const [k, n] of plan) for (let left = n; left > 0; left -= 100) await pads[k]!.mint(P, Math.min(100, left));
    const bq = await api.quote(P, "burn", 5);
    expect(bq.state.totalSupply).toBe("10000");
    expect(BigInt(bq.total)).toBe(BigInt(bq.amount) - BigInt(bq.fee));
    await expectApiError(api.quote(P, "mint", 1), 400, "bad_amount"); // sold out
    await indexer.syncToHead();
    expect((await api.getProject(P)).phase).toBe("promotion");
  });

  it("promotion code: full response for holders; 403 not_holder / not_registered", async () => {
    const cA = await pads.A!.getPromotionCode(P);
    expect(cA).toMatchObject({ project: getAddress(P), wallet: getAddress(await pads.A!.address()), tag: "#AP_AGC", cashtag: "$AGC" });
    expect(cA.code).toMatch(/^AP-/);
    expect(cA.requiredText).toEqual(["#AP_AGC", cA.code]);
    expect(cA.rules.length).toBeGreaterThan(0);
    expect(cA.window).toEqual({ opensAt: expect.any(Number), closesAt: expect.any(Number) });
    expect(cA.window!.closesAt - cA.window!.opensAt).toBe(7200);
    expect(cA.expiresAt).toBe(cA.window!.closesAt);
    expect(cA.link).toContain(getAddress(P));
    expect((await pads.A!.getPromotionCode(P)).code).toBe(cA.code); // stable
    expect((await pads.B!.getPromotionCode(P)).code).not.toBe(cA.code);
    await expectApiError(pads.D!.getPromotionCode(P), 403, "not_holder");
    await expectApiError(api.promotionCode(P, privateKeyToAccount(generatePrivateKey()).address), 403, "not_registered");
    await expectApiError(api.promotionCode(`0x${"ab".repeat(20)}`, await pads.A!.address()), 404, "not_found");
  });

  it("promotion gate graduates the project; rewards proof carries promoterExemptions; SDK claims both", async () => {
    const now = await chainNow(pc);
    const cA = await pads.A!.getPromotionCode(P);
    const cB = await pads.B!.getPromotionCode(P);
    const pa = x.addPost({ authorUsername: "alpha_bot", text: `${cA.requiredText.join(" ")} autonomous agents just sold out a whole NFT curve on BNB chain`, createdAt: now + 5, likes: 40, reposts: 3 });
    const pb = x.addPost({ authorUsername: "beta_bot", text: `My agent is holding ${cB.tag} into the DEX listing, code ${cB.code}, pancakes for everyone`, createdAt: now + 6, likes: 20, quoteOfId: pa.id });
    // promoters submit their post URLs (POST /promotions/submit): SDK client + raw API
    const sa = await pads.A!.submitPromotionPost(P, x.url(pa));
    expect(sa).toMatchObject({ tweetId: pa.id, kind: "original", status: "accepted", wallet: getAddress(await pads.A!.address()) });
    const sb = await api.submitPromotion({ project: P, wallet: await pads.B!.address(), url: x.url(pb) });
    expect(sb).toMatchObject({ kind: "quote", status: "accepted" });
    await expectApiError(api.submitPromotion({ project: P, wallet: await pads.A!.address(), url: x.url(pb) }), 422, "wrong_author");
    const tick = (await inject("POST", "/v1/admin/jobs/promotion/run", {}, ADMIN)).body;
    expect(tick.find((a: any) => a.project === P.toLowerCase())?.action).toBe("attest:threshold");
    await indexer.syncToHead();
    const proj = await api.getProject(P);
    expect(proj.phase).toBe("graduated");
    expect(proj.promotion?.promoterCount).toBe(2);

    // promoter exemption via GET /rewards/:wallet/proof
    const A = await pads.A!.address();
    let rp = await api.rewardsProof(A);
    expect(rp.wallet).toBe(getAddress(A));
    expect(rp.promoterExemptions).toHaveLength(1);
    expect(rp.promoterExemptions[0]).toMatchObject({ project: getAddress(P), root: proj.promotion!.promoterRoot, claimed: false });
    expect((await api.rewardsProof(await pads.C!.address())).promoterExemptions).toEqual([]);
    const ex = await pads.A!.claimPromoterExemption(P);
    expect("hash" in ex && ex.receipt.status).toBe("success");
    rp = await api.rewardsProof(A);
    expect(rp.promoterExemptions[0]!.claimed).toBe(true);
    expect(await pads.A!.claimPromoterExemption(P)).toEqual({ skipped: "already_exempt" });

    // daily rewards: run the epoch, then claim through the SDK
    const to = (await chainNow(pc)) + 1;
    const epoch = epochOf(to);
    const run = (await inject("POST", "/v1/admin/jobs/rewards/run", { epoch, from: launchedAt - 10, to }, ADMIN)).body;
    expect(run.status, JSON.stringify(run)).toBe("posted");
    rp = await api.rewardsProof(A);
    expect(rp.rewards).toHaveLength(1);
    expect(rp.rewards[0]).toMatchObject({ epoch: String(epoch), claimed: false, rewardPool: getAddress(dep.contracts.RewardPool) });
    expect(rp.rewards[0]!.amount).toMatch(/^\d+$/);
    expect(rp.rewards[0]!.proof.length).toBeGreaterThanOrEqual(0);
    const before = await pc.getBalance({ address: A });
    const claims = await pads.A!.claimRewards();
    expect(claims).toHaveLength(1);
    expect(claims[0]!.hash).toMatch(/^0x/);
    expect(claims[0]!.amount).toBe(BigInt(rp.rewards[0]!.amount));
    expect(await pc.getBalance({ address: A })).toBeGreaterThan(before - 10n ** 16n); // reward minus gas
    await indexer.syncToHead();
    expect((await api.rewardsProof(A)).rewards[0]!.claimed).toBe(true);
    expect((await pads.A!.claimRewards())[0]!.skipped).toBe("already_claimed");
  });
});
