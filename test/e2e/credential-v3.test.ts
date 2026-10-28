/**
 * Credential migration v2 → v3, end to end on a local Hardhat node with the REAL ChyAICredential (v2),
 * ChyAICredentialV3 and a SPACE ID registry stand-in (MockSpaceIdRegistry, same ownerOfHandle view):
 *   - backend configured with CREDENTIAL_ADDRESS = v2 (unchanged), CREDENTIAL_ADDRESSES = v3,
 *     CREDENTIAL_MINT_ADDRESS = v3, CREDENTIAL_MINT_VERSION = 3
 *   - an existing v2 holder (tokenId 1) keeps mining, its voucher says "already minted"
 *   - a new user gets a single-step v3 voucher (no AgentRegistry step), mints it, and mines
 *   - v3 refuses a wallet already used on v2 (legacy check), /v1/config + /v1/mining/stats list both contracts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createWalletClient, encodeFunctionData, getAddress, http, toHex, type Account, type Address, type Hex, type PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type { FastifyInstance } from "fastify";
import { startHardhatNode } from "../helpers/hardhat.js";
import { artifact, deployAll, type Deployment } from "../../scripts/lib/deploy.js";
import { loadConfig } from "../../src/config.js";
import { createContext, type AppContext } from "../../src/context.js";
import { buildServer } from "../../src/api/server.js";
import { MockXProvider } from "../../src/providers/x/mock.js";
import { MockAgentIdResolver } from "../../src/providers/agentid/index.js";
import { makeChain, makePublicClient } from "../../src/chain/client.js";
import { AgentRegistryAbi, ChyAICredentialAbi } from "../../src/chain/abi.js";
import { CredentialMintTypes, RegisterTypes, credentialDomain, registryDomain } from "../../src/chain/eip712.js";
import { ChyAICredentialV3MintAbi, clearCredentialCache, credentialAddresses } from "../../src/services/credential.js";
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
let v2: Address;
let v3: Address;
let spaceId: Address;
let dbFile: string;
const deployer = acct(0);
const platformSigner = acct(1);
const OLD = acct(13); // existing v2 holder (tokenId 1)
const NEW = acct(14); // new user → v3
const chainCfg = () => ({ CHAIN_ID: 31337, RPC_URL: node.url });

let ipSeq = 0;
const inject = async (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.inject({ method, url, payload: payload as any, headers: { "x-forwarded-for": `10.8.0.${++ipSeq}`, ...headers } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const wallet = (a: Account) => createWalletClient({ account: a, chain: makeChain(chainCfg()), transport: http(node.url) });
async function send(a: Account, to: Address, data: Hex) {
  const w = wallet(a);
  const hash = await w.sendTransaction({ account: a, chain: w.chain, to, data, value: 0n });
  const rc = await pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`tx reverted ${hash}`);
  return rc;
}
async function deploy(name: string, args: unknown[]) {
  const art = artifact(name);
  const w = wallet(deployer);
  const h = await w.deployContract({ abi: art.abi, bytecode: art.bytecode, args, account: deployer, chain: w.chain });
  return getAddress((await pc.waitForTransactionReceipt({ hash: h })).contractAddress!);
}
/** Mints a v2 credential for `a` the way the live site did (AgentRegistry.register + v2 mint, both platform-signed). */
async function mintV2(a: Account, agentId: string, xHandle: string) {
  const reg = dep.contracts.AgentRegistry;
  const now = Number((await pc.getBlock()).timestamp);
  const nonce = (await pc.readContract({ address: reg, abi: AgentRegistryAbi, functionName: "nonces", args: [a.address] })) as bigint;
  const expiry = BigInt(now + 365 * 86400);
  const deadline = BigInt(now + 3600);
  const xh = handleHash(xHandle);
  const rs = await platformSigner.signTypedData({
    domain: registryDomain(31337, reg), types: RegisterTypes, primaryType: "Register",
    message: { agentId, wallet: a.address, xHandleHash: xh, canLaunch: false, canTrade: true, expiry, nonce, deadline },
  });
  await send(a, reg, encodeFunctionData({ abi: AgentRegistryAbi, functionName: "register", args: [agentId, a.address, xh, false, true, expiry, deadline, rs] }));
  const ms = await platformSigner.signTypedData({
    domain: credentialDomain(31337, v2, "2"), types: CredentialMintTypes, primaryType: "Mint",
    message: { to: a.address, xHandleHash: xh, agentId: agentIdHash(agentId), deadline },
  });
  await send(a, v2, encodeFunctionData({ abi: ChyAICredentialAbi, functionName: "mint", args: [xh, agentIdHash(agentId), deadline, ms] } as any));
}

beforeAll(async () => {
  node = await startHardhatNode(20145 + Math.floor(Math.random() * 500));
  pc = makePublicClient(chainCfg());
  dep = await deployAll({ pc, chain: makeChain(chainCfg()), rpcUrl: node.url, deployer, platformSigner: platformSigner.address, treasury: acct(2).address });
  v2 = await deploy("ChyAICredential", [deployer.address, platformSigner.address, dep.contracts.AgentRegistry, ""]);
  spaceId = await deploy("mocks/MockSpaceIdRegistry", []);
  v3 = await deploy("ChyAICredentialV3", [deployer.address, platformSigner.address, spaceId, v2, ""]);
  await mintV2(OLD, "oldie.ai", "old_holder");

  dbFile = path.join(os.tmpdir(), `chyai-cred3-${Date.now()}.db`);
  const cfg = loadConfig({
    NODE_ENV: "test", DATABASE_URL: `file:${dbFile}`, RPC_URL: node.url, CHAIN_ID: "31337",
    REGISTRY_ADDRESS: dep.contracts.AgentRegistry, FACTORY_ADDRESS: dep.contracts.LaunchFactory, REWARD_POOL_ADDRESS: dep.contracts.RewardPool,
    FEE_SPLITTER_ADDRESS: dep.contracts.FeeSplitter, SIGNER_PRIVATE_KEY: pk(1), X_PROVIDER: "mock", AGENTID_PROVIDER: "mock",
    ADMIN_TOKEN: "test-admin", MINING_CREDIT_CACHE_SEC: "0",
    CREDENTIAL_ADDRESS: v2, CREDENTIAL_ADDRESSES: v3, CREDENTIAL_MINT_ADDRESS: v3, CREDENTIAL_MINT_VERSION: "3",
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

describe("credential v2 + v3 side by side (CREDENTIAL_ADDRESSES)", () => {
  it("config lists both contracts; v2 stays first (backward compatible)", async () => {
    expect(credentialAddresses(ctx.cfg).map((a) => a.toLowerCase())).toEqual([v2.toLowerCase(), v3.toLowerCase()]);
    const c = await inject("GET", "/v1/config");
    expect(c.body.credential).toMatchObject({ mintAddress: v3, mintVersion: 3 });
    expect(c.body.credential.validAddresses).toEqual([v2, v3]);
    expect(c.body.launchGate).toMatchObject({ minFollowers: 1200, minAccountAgeDays: 30 });
    // old single-contract config still works the same
    expect(credentialAddresses({ CREDENTIAL_ADDRESS: v2 })).toEqual([v2]);
    expect(credentialAddresses({})).toEqual([]);
  });

  it("existing v2 holder (tokenId 1) keeps its credential and mines", async () => {
    clearCredentialCache();
    const m = await inject("GET", `/v1/mining/${OLD.address}`);
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body.credential).toMatchObject({ configured: true, active: true, credit: 1000, tokenId: 1, address: v2 });
    expect(m.body.mining).toBe(true);
    expect(m.body.ratePerDay).toBe(10);
    // its voucher (approved claim) says "already minted" instead of issuing a v3 mint
    resolver.set("oldie.ai", OLD.address);
    const a = await inject("POST", "/v1/admin/airdrop/test-approve", { xHandle: "old_holder", wallet: OLD.address, aiName: "oldie.ai" }, ADMIN);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const v = await inject("GET", `/v1/airdrop/voucher?wallet=${OLD.address}`);
    expect(v.body).toMatchObject({ minted: true, tokenId: 1, steps: [] });
  });

  it("new user: single-step v3 voucher (no registry step), minted from the user's wallet, then mines", async () => {
    await send(deployer, spaceId, encodeFunctionData({
      abi: [{ type: "function", name: "set", stateMutability: "nonpayable", inputs: [{ name: "handle", type: "string" }, { name: "owner", type: "address" }], outputs: [] }],
      functionName: "set", args: ["newbie", NEW.address],
    }));
    resolver.set("newbie.ai", NEW.address);
    const a = await inject("POST", "/v1/admin/airdrop/test-approve", { xHandle: "new_user", wallet: NEW.address, aiName: "newbie.ai" }, ADMIN);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const v = await inject("GET", `/v1/airdrop/voucher?wallet=${NEW.address}`);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body).toMatchObject({ minted: false, credentialVersion: 3, credential: v3, registration: null, mint: { label: "newbie", agentId: agentIdHash("newbie.ai"), xHandleHash: handleHash("new_user") } });
    expect(v.body.steps).toHaveLength(1);
    expect(v.body.steps[0]).toMatchObject({ step: "mint", to: v3, value: "0" });
    await send(NEW, v.body.steps[0].to, v.body.steps[0].data);
    clearCredentialCache();
    const m = await inject("GET", `/v1/mining/${NEW.address}`);
    expect(m.body.credential).toMatchObject({ active: true, credit: 1000, tokenId: 1, address: v3 });
    const st = await inject("GET", `/v1/airdrop/status?wallet=${NEW.address}`);
    expect(st.body.credential.holdings.map((h: any) => [h.address, h.active])).toEqual([[v2, false], [v3, true]]);
    expect(m.body.mining).toBe(true);
    const again = await inject("GET", `/v1/airdrop/voucher?wallet=${NEW.address}`);
    expect(again.body).toMatchObject({ minted: true, steps: [] });
  });

  it("v3 refuses a wallet already used on v2 (legacy check) even with a valid voucher", async () => {
    await send(deployer, spaceId, encodeFunctionData({
      abi: [{ type: "function", name: "set", stateMutability: "nonpayable", inputs: [{ name: "handle", type: "string" }, { name: "owner", type: "address" }], outputs: [] }],
      functionName: "set", args: ["oldie", OLD.address],
    }));
    const now = Number((await pc.getBlock()).timestamp);
    const deadline = BigInt(now + 3600);
    const sig = await platformSigner.signTypedData({
      domain: credentialDomain(31337, v3, "3"), types: CredentialMintTypes, primaryType: "Mint",
      message: { to: OLD.address, xHandleHash: handleHash("old_holder_2"), agentId: agentIdHash("oldie.ai"), deadline },
    });
    const data = encodeFunctionData({ abi: ChyAICredentialV3MintAbi, functionName: "mint", args: ["oldie", handleHash("old_holder_2"), deadline, sig] });
    await expect(send(OLD, v3, data)).rejects.toThrow();
  });

  it("stats + leaderboard count holders of both contracts", async () => {
    const st = await inject("GET", "/v1/mining/stats");
    expect(st.body).toMatchObject({ participants: 2, activeMiners: 2, credentialConfigured: true, credentialAddress: v3 });
    expect(st.body.credentialAddresses).toEqual([v2, v3]);
    const lb = await inject("GET", "/v1/mining/leaderboard");
    expect(lb.body.items.map((i: any) => i.wallet).sort()).toEqual([OLD.address, NEW.address].sort());
  });
});
