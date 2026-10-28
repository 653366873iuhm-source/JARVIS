import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { AgentPad, AgentPadApi, MockPinningProvider, Phase, ViemSigner, lintPromotionPost, type Deployment } from "../src/index.js";
import { MockBackend, signPromotion } from "../src/testing/index.js";
import { AutoAgent } from "../examples/auto-agent/src/agent.js";
import { HeuristicStrategy } from "../examples/auto-agent/src/strategy.js";
import { MockXPoster } from "../examples/auto-agent/src/poster.js";
import { launchGenerated } from "../examples/auto-agent/src/launcher.js";
import { generatePlaceholder } from "../examples/auto-agent/src/generator.js";
import { deployLocal, increaseTime, type LocalDeployment } from "./helpers/deploy.js";
import { HH_KEYS } from "./helpers/keys.js";

const exec = promisify(execFile);
const RPC = process.env.AGENTPAD_TEST_RPC!;
const SDK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chain = () => ({ ...hardhat, rpcUrls: { default: { http: [RPC] } } });

let d: LocalDeployment;
let dep: Deployment;
let pc: PublicClient;
let backend: MockBackend;
let api: AgentPadApi;
let depFile: string;
const pad = (key: Hex) =>
  new AgentPad({ publicClient: pc, signer: new ViemSigner(createWalletClient({ account: privateKeyToAccount(key), chain: chain(), transport: http(RPC) })), deployment: dep, api });

let launcherPad: AgentPad, agentPad: AgentPad, whalePad: AgentPad;
let project: Address;
let agent: AutoAgent;
let poster: MockXPoster;

beforeAll(async () => {
  pc = createPublicClient({ chain: chain(), transport: http(RPC) }) as PublicClient;
  d = await deployLocal(RPC);
  dep = { chainId: d.chainId, AgentRegistry: d.AgentRegistry, LaunchFactory: d.LaunchFactory, FeeSplitter: d.FeeSplitter, RewardPool: d.RewardPool, fromBlock: 0n };
  backend = new MockBackend({ rpcUrl: RPC, chainId: d.chainId, registry: d.AgentRegistry, factory: d.LaunchFactory, rewardPool: d.RewardPool, platformSignerKey: d.platformSigner });
  api = new AgentPadApi({ baseUrl: await backend.start() });
  launcherPad = pad(HH_KEYS[3]);
  agentPad = pad(HH_KEYS[4]);
  whalePad = pad(HH_KEYS[5]);
  await launcherPad.register({ agentId: "maker.ai", xHandle: "maker" });
  await agentPad.register({ agentId: "auto.ai", xHandle: "auto_agent", intent: "trade" });
  await whalePad.register({ agentId: "whale.ai", xHandle: "whale", intent: "trade" });
  depFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "apdep-")), "local.json");
  fs.writeFileSync(depFile, JSON.stringify({ chainId: d.chainId, fromBlock: 0, contracts: { ...dep, fromBlock: undefined } }));
});

afterAll(async () => {
  await backend?.stop();
});

describe("examples/auto-agent", () => {
  it("placeholder generator is deterministic and valid", () => {
    const a = generatePlaceholder("seed-1");
    expect(generatePlaceholder("seed-1")).toEqual(a);
    expect(a.symbol).toMatch(/^[A-Z0-9]{2,10}$/);
    expect(a.story.length).toBeGreaterThan(50);
  });

  it("launcher example generates, pins (mock) and launches", async () => {
    const pinning = new MockPinningProvider();
    const r = await launchGenerated(launcherPad, { seed: "demo", pinning, llm: null, agentId: "maker.ai", tokenFileCount: 5 });
    project = r.project;
    expect(pinning.getJson(`${r.baseURI}collection.json`).traits[0].values[2].image).toMatch(/legendary\.svg$/);
    expect((await launcherPad.getProject(project)).name).toBe(r.generated.name);
  });

  it("auto agent buys within budget and stops at the per-project cap", async () => {
    poster = new MockXPoster(path.join(os.tmpdir(), `posts-${Date.now()}.jsonl`));
    agent = new AutoAgent({
      pad: agentPad,
      strategy: new HeuristicStrategy({ maxEntryProgressBps: 9000, maxEntryAgeSeconds: 365 * 86400, buyThreshold: 0.3, takeProfitPct: 10_000, stopLossPct: 99, baseSize: 30 }),
      budget: { maxPerProjectWei: parseEther("0.01"), maxTotalWei: parseEther("0.1"), maxPerTickWei: parseEther("0.006"), gasReserveWei: parseEther("0.01") },
      poster,
      llm: null,
      log: () => {},
    });
    const t1 = await agent.tick();
    const m1 = t1.actions.find((a) => a.action === "mint");
    expect(m1).toBeDefined();
    const pos1 = agent.state.positions[project];
    expect(BigInt(pos1.costWei)).toBeLessThanOrEqual(parseEther("0.006"));
    await agent.tick();
    await agent.tick();
    const pos = agent.state.positions[project];
    expect(BigInt(pos.costWei)).toBeLessThanOrEqual(parseEther("0.01"));
    expect(pos.count).toBe((await agentPad.getHoldings(project)).length);
    const t4 = await agent.tick();
    expect(t4.actions.find((a) => a.action === "mint")).toBeUndefined(); // cap reached
  });

  it("posts exactly one compliant promotion when the held project hits the promotion gate", async () => {
    await increaseTime(RPC, 301);
    for (;;) {
      const info = await whalePad.getProject(project, { withApi: false });
      if (info.phase !== Phase.Trading) break;
      await whalePad.mint(project, 100);
    }
    const t = await agent.tick();
    const promo = t.actions.find((a) => a.action === "promote");
    expect(promo).toBeDefined();
    expect(poster.posts.length).toBe(1);
    // no X search on the backend: the agent submitted its post URL right after posting
    expect((promo!.detail as any).submitted).toMatchObject({ status: "stored", url: (promo!.detail as any).url });
    expect(backend.requests.filter((q) => q.path === "/promotions/submit")).toHaveLength(1);
    const code = await agentPad.getPromotionCode(project);
    expect(lintPromotionPost(poster.posts[0].text, code).ok).toBe(true);
    await agent.tick();
    expect(poster.posts.length).toBe(1); // never twice
  });

  it("claims the promoter exemption after graduation", async () => {
    const me = privateKeyToAccount(HH_KEYS[4]).address;
    const root = backend.setPromoters(project, [me]);
    const info = await whalePad.getProject(project, { withApi: false });
    const deadline = (await pc.getBlock()).timestamp + 600n;
    const signature = await signPromotion(privateKeyToAccount(d.platformSigner), { chainId: d.chainId, registry: d.AgentRegistry, project, shareBps: 5000, promoterRoot: root, nonce: info.attestationNonce, deadline });
    await whalePad.submitPromotion(project, { shareBps: 5000, promoterRoot: root, deadline, signature });
    const t = await agent.tick();
    expect(t.actions.find((a) => a.action === "claim-exemption")).toBeDefined();
    const held = await agentPad.getHoldings(project);
    expect(await agentPad.isLocked(project, held[0])).toBe(false);
  });
});

describe("agentpad CLI", () => {
  const cli = async (args: string[], env: Record<string, string> = {}) => {
    const r = await exec("npx", ["tsx", "src/cli.ts", ...args, "--rpc", RPC, "--chain-id", String(d.chainId), "--deployment", depFile, "--api", api.baseUrl], { cwd: SDK, env: { ...process.env, ...env } }).catch((e) => e);
    return JSON.parse(r.stdout);
  };

  it("status / quote / dry-run / promo-post", async () => {
    const st = await cli(["status", "--wallet", privateKeyToAccount(HH_KEYS[4]).address]);
    expect(st.success).toBe(true);
    expect(st.data.canTrade).toBe(true);

    // a fresh trading project for quotes (cooldown: advance 24h)
    await increaseTime(RPC, 86_401);
    const pinning = new MockPinningProvider();
    const r = await launchGenerated(launcherPad, { seed: "cli", pinning, llm: null, tokenFileCount: 2 });
    const q = await cli(["quote", "mint", r.project, "5"]);
    expect(q.data.total).toBe((await agentPad.quoteMint(r.project, 5)).total.toString());

    const dry = await cli(["mint", r.project, "3", "--dry-run", "--from", privateKeyToAccount(HH_KEYS[4]).address]);
    expect(dry.data.dryRun).toBe(true);
    expect(dry.data.tx.to.toLowerCase()).toBe(r.project.toLowerCase());
    expect(dry.data.bawPreview).toContain("contract-call preview --binanceChainId 56");

    const minted = await cli(["mint", r.project, "2", "--signer", "key"], { AGENTPAD_PRIVATE_KEY: HH_KEYS[4] });
    expect(minted.success).toBe(true);
    expect(minted.data.tokenIds.length).toBe(2);

    const post = await cli(["promo-post", r.project, "--signer", "key"], { AGENTPAD_PRIVATE_KEY: HH_KEYS[4] });
    expect(post.data.lint.ok).toBe(true);

    const bad = await cli(["mint", r.project, "1", "--signer", "key"], { AGENTPAD_PRIVATE_KEY: HH_KEYS[9] });
    expect(bad.success).toBe(false);
    expect(bad.error.code).toBe("NotAgent");
  });
});
