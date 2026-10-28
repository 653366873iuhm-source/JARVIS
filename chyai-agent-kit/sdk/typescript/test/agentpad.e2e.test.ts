import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import {
  AgentPad,
  AgentPadApi,
  AgentPadError,
  BawSigner,
  BondingNFTAbi,
  AgentTokenAbi,
  MockPinningProvider,
  Phase,
  RewardPoolAbi,
  ViemSigner,
  buildPromotionPost,
  lintPromotionPost,
  postHash,
  quoteBurn,
  quoteMint,
  TOKENS_PER_NFT,
  BINANCE_CHARITY,
  splitFee,
  type Deployment,
} from "../src/index.js";
import { MockBackend, signPromotion } from "../src/testing/index.js";
import { deployLocal, increaseTime, mockArtifact, type LocalDeployment } from "./helpers/deploy.js";
import { HH_KEYS } from "./helpers/keys.js";

const RPC = process.env.AGENTPAD_TEST_RPC!;
const here = path.dirname(fileURLToPath(import.meta.url));

let d: LocalDeployment;
let dep: Deployment;
let pc: PublicClient;
let backend: MockBackend;
let api: AgentPadApi;
const chain = () => ({ ...hardhat, rpcUrls: { default: { http: [RPC] } } });

function padFor(key: Hex, opts: { api?: boolean } = {}) {
  const account = privateKeyToAccount(key);
  const wc = createWalletClient({ account, chain: chain(), transport: http(RPC) });
  return new AgentPad({ publicClient: pc, signer: new ViemSigner(wc), deployment: dep, api: opts.api === false ? undefined : api });
}

async function gasCost(hash: Hex) {
  const r = await pc.getTransactionReceipt({ hash });
  return r.gasUsed * r.effectiveGasPrice;
}

const launcherKey = HH_KEYS[3];
const a1Key = HH_KEYS[4];
const a2Key = HH_KEYS[5];
const bawKey = HH_KEYS[6];
const humanKey = HH_KEYS[7];

let launcher: AgentPad, a1: AgentPad, a2: AgentPad, human: AgentPad, bawPad: AgentPad;
let project: Address;
let token: Address;
let pinning: MockPinningProvider;
let bawState: string;

beforeAll(async () => {
  pc = createPublicClient({ chain: chain(), transport: http(RPC) }) as PublicClient;
  d = await deployLocal(RPC);
  dep = { chainId: d.chainId, AgentRegistry: d.AgentRegistry, LaunchFactory: d.LaunchFactory, FeeSplitter: d.FeeSplitter, RewardPool: d.RewardPool, TraitRandomness: d.TraitRandomness, fromBlock: 0n };
  backend = new MockBackend({ rpcUrl: RPC, chainId: d.chainId, registry: d.AgentRegistry, factory: d.LaunchFactory, rewardPool: d.RewardPool, platformSignerKey: d.platformSigner });
  api = new AgentPadApi({ baseUrl: await backend.start() });
  launcher = padFor(launcherKey);
  a1 = padFor(a1Key);
  a2 = padFor(a2Key);
  human = padFor(humanKey);
  pinning = new MockPinningProvider();

  bawState = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "baw-")), "state.json");
  process.env.MOCK_BAW_KEY = bawKey;
  process.env.MOCK_BAW_RPC = RPC;
  process.env.MOCK_BAW_STATE = bawState;
  const previews: unknown[] = [];
  const signer = new BawSigner({ bin: path.join(here, "helpers/mock-baw.mjs"), binanceChainId: "56", confirm: (p) => (previews.push(p), true) });
  bawPad = new AgentPad({ publicClient: pc, signer, deployment: dep, api });
});

afterAll(async () => {
  await backend?.stop();
});

describe("curve math (pure)", () => {
  it("matches the contract's reference rounding model on a full buy/sell path", () => {
    let s = { virtualBnb: 7142857142857142857n, virtualToken: 1085714285714n * 10n ** 15n, totalSupply: 0n, feeBps: 100n };
    let raised = 0n;
    for (let i = 0; i < 100; i++) {
      const q = quoteMint(s, 100);
      raised += q.cost;
      s = { ...s, virtualBnb: q.newVirtualBnb, virtualToken: s.virtualToken - 100n * TOKENS_PER_NFT, totalSupply: s.totalSupply + 100n };
    }
    expect(s.totalSupply).toBe(10_000n);
    // ~20 BNB raised net of fees (README: 20.00000000002)
    expect(Number(raised) / 1e18).toBeCloseTo(20, 6);
    expect(() => quoteMint(s, 1)).toThrow(/BadAmount/);
    const b = quoteBurn(s, 1);
    expect(b.net).toBe(b.gross - b.fee);
  });
});

describe("AgentPad SDK end-to-end on Hardhat", () => {
  it("registers agents through the API (backend EIP-712 signature) and AgentRegistry", async () => {
    let challengeSeen = false;
    backend.o.requireXProof = true; // launcher: backend waits for the X verification post URL
    const r = await launcher.register({ agentId: "launcher.ai", xHandle: "@Launcher_Agent", onChallenge: async (c) => ((challengeSeen = !!c.code), "https://x.com/launcher_agent/status/1") });
    expect(r.tx?.receipt.status).toBe("success");
    expect(r.status.canLaunch).toBe(true);
    expect(r.status.canTrade).toBe(true);
    expect(challengeSeen).toBe(true);
    backend.o.requireXProof = false; // others: backend discovers the post itself
    // idempotent: second call skips
    expect((await launcher.register({ agentId: "launcher.ai", xHandle: "launcher_agent" })).skipped).toBe(true);
    await a1.register({ agentId: "alpha.ai", xHandle: "alpha" });
    await a2.register({ agentId: "beta.ai", xHandle: "beta", intent: "trade" });
    const s2 = await a2.getAgent();
    expect(s2.canTrade).toBe(true);
    expect(s2.canLaunch).toBe(false);
    // the backend saw both phases of register-request
    expect(backend.requests.filter((q) => q.path === "/agents/register-request").length).toBeGreaterThanOrEqual(6);
  });

  it("rejects a tampered registration signature with a decoded custom error", async () => {
    const res = await api.registerRequest({ agentId: "evil.ai", wallet: privateKeyToAccount(humanKey).address, xHandle: "evil", chainId: d.chainId, intent: "trade" });
    expect(res.status).toBe("awaiting_wallet_signature");
    // human signs its binding properly through the SDK, then we tamper with canLaunch before relaying
    await human.requestRegistration({ agentId: "evil.ai", xHandle: "evil", intent: "trade" });
    const sig = await human.waitForRegistrationSignature("evil.ai");
    await expect(human.submitRegistration({ ...sig, canLaunch: true })).rejects.toThrow(/BadSignature/);
  });

  it("uploads metadata through a pinning provider and launches", async () => {
    const r = await launcher.launch({
      name: "Signal Cats",
      symbol: "SCAT",
      story: "A colony of autonomous cats that trade signals at night and nap through every dip.",
      images: [{ name: "cover.svg", content: "<svg xmlns='http://www.w3.org/2000/svg'/>", contentType: "image/svg+xml" }],
      pinning,
      agentId: "launcher.ai",
      tokenFileCount: 20,
    });
    project = r.project;
    token = r.token;
    expect(r.baseURI).toMatch(/^ipfs:\/\/bafymock[0-9a-f]+\/$/);
    expect(pinning.getJson(`${r.baseURI}collection.json`).story).toContain("autonomous cats");
    expect(pinning.getJson(`${r.baseURI}7`).name).toBe("Signal Cats #7");
    const info = await launcher.getProject(project);
    expect(info.phase).toBe(Phase.Trading);
    expect(info.launcher).toBe(privateKeyToAccount(launcherKey).address);
    expect(info.api?.name).toBe("Signal Cats");
    // cooldown is enforced client-side before sending
    await expect(launcher.launch({ name: "Again", symbol: "AGN", baseURI: "ipfs://x/" })).rejects.toThrow(/Cooldown/);
    // a trade-only agent cannot launch
    await expect(a2.launch({ name: "Nope", symbol: "NOPE", baseURI: "ipfs://x/" })).rejects.toThrow(/NotLauncher/);
  });

  it("quote == contract quote == actual cost (mint & burn), anti-snipe enforced", async () => {
    for (const n of [1n, 7n, 20n]) {
      const local = await a1.quoteMint(project, n);
      const onchain = (await pc.readContract({ address: project, abi: BondingNFTAbi, functionName: "quoteMint", args: [n] })) as readonly bigint[];
      expect([local.cost, local.fee, local.total]).toEqual([...onchain]);
    }
    const apiQ = await api.quote(project, "mint", 7);
    expect(apiQ.total).toBe((await a1.quoteMint(project, 7)).total.toString());
    await expect(a1.mint(project, 21)).rejects.toThrow(/AntiSnipeLimit/);
    const addr = privateKeyToAccount(a1Key).address;
    const q = await a1.quoteMint(project, 20);
    const before = await pc.getBalance({ address: addr });
    const r = await a1.mint(project, 20);
    const after = await pc.getBalance({ address: addr });
    expect(r.cost).toBe(q.cost);
    expect(r.fee).toBe(q.fee);
    expect(before - after - (await gasCost(r.hash))).toBe(q.total); // overpayment (slippage) fully refunded
    expect(r.tokenIds).toEqual(Array.from({ length: 20 }, (_, i) => BigInt(i + 1)));
    expect(await pc.readContract({ address: project, abi: BondingNFTAbi, functionName: "tokenURI", args: [5n] })).toMatch(/\/5$/);

    // burn: received == quote.net exactly
    const bq = await a1.quoteBurn(project, 3);
    const onchainB = (await pc.readContract({ address: project, abi: BondingNFTAbi, functionName: "quoteBurn", args: [3n] })) as readonly bigint[];
    expect([bq.gross, bq.fee, bq.net]).toEqual([...onchainB]);
    const b0 = await pc.getBalance({ address: addr });
    const br = await a1.burn(project, 3);
    const b1 = await pc.getBalance({ address: addr });
    expect(br.net).toBe(bq.net);
    expect(b1 - b0 + (await gasCost(br.hash))).toBe(bq.net);
    expect(br.tokenIds).toEqual([18n, 19n, 20n]);
    expect(await a1.getHoldings(project)).toEqual(Array.from({ length: 17 }, (_, i) => BigInt(i + 1)));
  });

  it("non-agents are refused (preflight + on-chain NotAgent)", async () => {
    const outsider = padFor(HH_KEYS[8]);
    const err = await outsider.mint(project, 1).catch((e) => e);
    if (!/NotAgent/.test(String(err))) console.log("OUTSIDER", err);
    expect(String(err)).toMatch(/NotAgent/);
    // bypass the preflight: the contract itself reverts and the SDK decodes it
    const q = await outsider.quoteMint(project, 1);
    await expect(outsider.send(outsider.encode.mint(project, 1n, q.total))).rejects.toThrow(/NotAgent/);
  });

  it("Binance Agentic Wallet adapter: registers (EIP-712 via sign-message), mints and burns via baw contract-call", async () => {
    const reg = await bawPad.register({ agentId: "bawagent.ai", xHandle: "baw_agent" });
    expect(reg.status.canTrade).toBe(true);
    await increaseTime(RPC, 301); // leave the anti-snipe window
    const m = await bawPad.mint(project, 30);
    expect(m.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(m.tokenIds.length).toBe(30);
    const b = await bawPad.burn(project, m.tokenIds.slice(0, 2));
    expect(b.receipt.status).toBe("success");
    const log: string[] = JSON.parse(fs.readFileSync(bawState, "utf8")).log;
    expect(log).toContain("contract-call preview");
    expect(log).toContain("contract-call execute");
    expect(log).toContain("sign-message preview");
    expect(log).toContain("wallet settings");
  });

  it("baw adapter refuses risky previews and requires confirmation", async () => {
    const noConfirm = new AgentPad({ publicClient: pc, signer: new BawSigner({ bin: path.join(here, "helpers/mock-baw.mjs") }), deployment: dep });
    await expect(noConfirm.mint(project, 1)).rejects.toThrow(/confirm/);
    process.env.MOCK_BAW_RISK = "1";
    try {
      const risky = new AgentPad({ publicClient: pc, signer: new BawSigner({ bin: path.join(here, "helpers/mock-baw.mjs"), autoApprove: true }), deployment: dep });
      await expect(risky.mint(project, 1)).rejects.toThrow(/risk/i);
    } finally {
      delete process.env.MOCK_BAW_RISK;
    }
    const declined = new AgentPad({ publicClient: pc, signer: new BawSigner({ bin: path.join(here, "helpers/mock-baw.mjs"), confirm: () => false }), deployment: dep });
    await expect(declined.mint(project, 1)).rejects.toThrow(/declined/);
  });

  it("launcher cap and mint-to-completion with exact quotes at every step", async () => {
    // launcher buys 100 (cap 500 is far away), then the rest of the curve is bought by a1/a2 in 100-NFT batches
    await launcher.mint(project, 100);
    let i = 0;
    for (;;) {
      const info = await a1.getProject(project, { withApi: false });
      if (info.phase !== Phase.Trading) break;
      const buyer = i++ % 3 === 0 ? a2 : a1;
      const n = info.remaining > 100n ? 100n : info.remaining;
      const q = await buyer.quoteMint(project, n);
      const r = await buyer.mint(project, 100); // clamps to remaining on the last batch
      expect(r.cost + r.fee).toBe(q.total);
    }
    const info = await a1.getProject(project, { withApi: false });
    expect(info.phase).toBe(Phase.Promotion);
    expect(info.totalSupply).toBe(10_000n);
    expect(Number(info.reserveBnb) / 1e18).toBeCloseTo(20, 6);
    await expect(a1.mint(project, 1)).rejects.toThrow(/WrongPhase/);
  });

  it("promotion: code from API, compliant post, attested by the (simulated) backend signer, graduation", async () => {
    const code = await a2.getPromotionCode(project);
    expect(code.code).toBeTruthy();
    const post = buildPromotionPost({ name: "Signal Cats", symbol: "SCAT", storyLine: "Cats that trade signals at night.", code });
    const lint = lintPromotionPost(post, code);
    expect(lint.issues).toEqual([]);
    expect(lintPromotionPost(post, code, [postHash(post)]).issues).toContain("duplicate of an earlier post");
    expect(lintPromotionPost(`${post} guaranteed 100x`, code).ok).toBe(false);
    await expect(human.getPromotionCode(project)).rejects.toThrow(/not_registered|not_holder/);

    const a2Addr = privateKeyToAccount(a2Key).address;
    const root = backend.setPromoters(project, [a2Addr, privateKeyToAccount(launcherKey).address]);
    const info = await a1.getProject(project, { withApi: false });
    const block = await pc.getBlock();
    const deadline = block.timestamp + 600n;
    const signature = await signPromotion(privateKeyToAccount(d.platformSigner), { chainId: d.chainId, registry: d.AgentRegistry, project, shareBps: 6000, promoterRoot: root, nonce: info.attestationNonce, deadline });
    const tx = await human.submitPromotion(project, { shareBps: 6000, promoterRoot: root, deadline, signature }); // anyone relays
    expect(tx.receipt.status).toBe("success");
    const g = await a1.getProject(project, { withApi: false });
    expect(g.phase).toBe(Phase.Graduated);
    expect(g.pair).not.toBe("0x0000000000000000000000000000000000000000");
  });

  it("after graduation: promoter exemption via API proof, locks, redeem, deposit", async () => {
    // a2 is a promoter -> claims exemption with the API proof and redeems at once
    const ex = await a2.claimPromoterExemption(project);
    expect("hash" in ex).toBe(true);
    const a2Addr = privateKeyToAccount(a2Key).address;
    const held = await a2.getHoldings(project);
    const red = await a2.redeem(project, held.slice(0, 2));
    expect(red.tokens).toBe(2n * TOKENS_PER_NFT);
    expect(await pc.readContract({ address: token, abi: AgentTokenAbi, functionName: "balanceOf", args: [a2Addr] })).toBe(2n * TOKENS_PER_NFT);

    // a1 is not a promoter -> locked for 24h
    const a1held = await a1.getHoldings(project);
    expect(await a1.isLocked(project, a1held[0])).toBe(true);
    await expect(a1.redeem(project, [a1held[0]])).rejects.toThrow(/Locked/);
    await increaseTime(RPC, 86_401);
    const r1 = await a1.redeem(project); // default: up to 100 unlocked ids
    expect(r1.tokenIds.length).toBe(100);

    // deposit: approve + deposit -> new ids above 10,000
    const dep1 = await a1.deposit(project, 3);
    expect(dep1.approveTx).toBeDefined();
    const g = await a1.getProject(project, { withApi: false });
    expect(dep1.tokenIds.length).toBe(3);
    expect(dep1.tokenIds[0]).toBeGreaterThanOrEqual(g.firstPostGradId);
    expect(dep1.tokenIds[0]).toBeGreaterThan(10_000n);
    expect(await a1.isLocked(project, dep1.tokenIds[0])).toBe(false);

    // launcher still locked (7 days) despite being in the promoter list
    await launcher.claimPromoterExemption(project);
    const lh = await launcher.getHoldings(project);
    expect(await launcher.isLocked(project, lh[0])).toBe(true);
  });

  it("claims promotion rewards (Merkle proof from API) and launcher fees", async () => {
    const a2Addr = privateKeyToAccount(a2Key).address;
    const unallocated = (await pc.readContract({ address: d.RewardPool, abi: RewardPoolAbi, functionName: "unallocated" })) as bigint;
    expect(unallocated).toBeGreaterThan(0n); // 0.2% of every trade
    const amount = unallocated / 4n;
    const { root, total } = backend.setRewards(20_000n, [{ account: a2Addr, amount }, { account: privateKeyToAccount(a1Key).address, amount: amount / 2n }]);
    const signerWc = createWalletClient({ account: privateKeyToAccount(d.platformSigner), chain: chain(), transport: http(RPC) });
    const h = await signerWc.writeContract({ address: d.RewardPool, abi: RewardPoolAbi, functionName: "postRoot", args: [20_000n, root, total] });
    await pc.waitForTransactionReceipt({ hash: h });

    const before = await pc.getBalance({ address: a2Addr });
    const claims = await a2.claimRewards();
    expect(claims.length).toBe(1);
    const after = await pc.getBalance({ address: a2Addr });
    expect(after - before + (await gasCost(claims[0].hash!))).toBe(amount);
    expect((await a2.claimRewards())[0].skipped).toBe("already_claimed");

    const fees = await launcher.feeBalance();
    expect(fees).toBeGreaterThan(parseEther("0.05")); // 0.3% of ~40 BNB volume
    const w = await launcher.withdrawFees();
    expect(w.receipt.status).toBe("success");
    expect(await launcher.feeBalance()).toBe(0n);

    // charity: 20% of every trading fee accrues to Binance Charity; anyone can flush
    const cs = await a2.charityStats();
    expect(cs.charity).toBe(BINANCE_CHARITY);
    expect(cs.totalDonated).toBeGreaterThan(parseEther("0.03")); // 0.2% of ~20 BNB curve volume
    expect(cs.pending).toBe(cs.totalDonated);
    const cBefore = await pc.getBalance({ address: BINANCE_CHARITY });
    const fl = await a2.flushCharity();
    expect(fl.receipt.status).toBe("success");
    expect(await pc.getBalance({ address: BINANCE_CHARITY })).toBe(cBefore + cs.totalDonated);
    expect(await a2.charityStats()).toMatchObject({ totalFlushed: cs.totalDonated, pending: 0n });
    expect(splitFee(10_000n)).toEqual({ launcher: 3000n, reward: 2000n, charity: 2000n, platform: 3000n });
  });

  it("lists projects via API and via chain fallback", async () => {
    const viaApi = await a1.listProjects({ limit: 10 });
    expect(viaApi.items.length).toBe(1);
    const noApi = padFor(a1Key, { api: false });
    const viaChain = await noApi.listProjects({ limit: 10 });
    expect((viaChain.items[0] as any).address).toBe(project);
    void mockArtifact;
  });
});
