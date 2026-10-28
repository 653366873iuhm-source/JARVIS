import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createTestClient, createWalletClient, getContractAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { CONTRACTS_DIR } from "./node.js";
import { HH_KEYS } from "./keys.js";

/** Binance Charity main wallet on BSC: receives 20% of every curve trading fee (FeeSplitter, immutable). */
export const BINANCE_CHARITY = "0x8B99F3660622e21f2910ECCA7fBe51d654a1517D" as const;

function artifact(file: string, name: string) {
  const p = path.join(CONTRACTS_DIR, "artifacts/contracts", file, `${name}.json`);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode as Hex };
}

export interface LocalDeployment {
  rpcUrl: string;
  chainId: number;
  AgentRegistry: Address;
  RewardPool: Address;
  FeeSplitter: Address;
  TraitRandomness: Address;
  LaunchFactory: Address;
  MockVRF: Address;
  WETH: Address;
  PancakeFactory: Address;
  Router: Address;
  owner: Hex;
  platformSigner: Hex;
  treasury: Address;
}

/**
 * Deploys the full AgentPad stack (+ Pancake/VRF mocks) exactly like contracts/test/fixture.js.
 * Accounts: 0 owner/deployer, 1 platform signer, 2 treasury.
 */
export async function deployLocal(rpcUrl: string): Promise<LocalDeployment> {
  const owner = privateKeyToAccount(HH_KEYS[0]);
  const platformSigner = privateKeyToAccount(HH_KEYS[1]);
  const treasury = privateKeyToAccount(HH_KEYS[2]).address;
  const chain = { ...hardhat, rpcUrls: { default: { http: [rpcUrl] } } };
  const wc = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });
  const pc = createPublicClient({ chain, transport: http(rpcUrl) });

  async function deploy(file: string, name: string, args: unknown[] = []): Promise<Address> {
    const a = artifact(file, name);
    const hash = await wc.deployContract({ abi: a.abi, bytecode: a.bytecode, args } as any);
    const rc = await pc.waitForTransactionReceipt({ hash });
    return rc.contractAddress!;
  }
  async function call(address: Address, file: string, name: string, fn: string, args: unknown[]) {
    const a = artifact(file, name);
    const hash = await wc.writeContract({ address, abi: a.abi, functionName: fn, args } as any);
    await pc.waitForTransactionReceipt({ hash });
  }

  const registry = await deploy("AgentRegistry.sol", "AgentRegistry", [owner.address, platformSigner.address]);
  const rewardPool = await deploy("RewardPool.sol", "RewardPool", [owner.address, registry]);
  const feeSplitter = await deploy("FeeSplitter.sol", "FeeSplitter", [rewardPool, BINANCE_CHARITY]);
  const vrf = await deploy("mocks/MockVRFCoordinator.sol", "MockVRFCoordinator");
  const randomness = await deploy("TraitRandomness.sol", "TraitRandomness", [owner.address, vrf, `0x${"0".repeat(64)}`, 1n, false]);
  const weth = await deploy("mocks/MockWETH.sol", "MockWETH");
  const pf = await deploy("mocks/MockPancake.sol", "MockPancakeFactory");
  const router = await deploy("mocks/MockPancake.sol", "MockPancakeRouter", [pf, weth]);
  const nftTemplate = await deploy("BondingNFT.sol", "BondingNFT");
  const tokenTemplate = await deploy("AgentToken.sol", "AgentToken");
  const settings = {
    nftTemplate, tokenTemplate, registry, feeSplitter, randomness, router, treasury,
    feeBps: 100, launcherShareBps: 3000, rewardShareBps: 2000, graduationFee: 10n ** 18n, launchCooldown: 86_400n,
  };
  const factory = await deploy("LaunchFactory.sol", "LaunchFactory", [owner.address, settings]);
  await call(randomness, "TraitRandomness.sol", "TraitRandomness", "setFactory", [factory]);
  void getContractAddress;
  return {
    rpcUrl, chainId: await pc.getChainId(), AgentRegistry: registry, RewardPool: rewardPool, FeeSplitter: feeSplitter, TraitRandomness: randomness,
    LaunchFactory: factory, MockVRF: vrf, WETH: weth, PancakeFactory: pf, Router: router, owner: HH_KEYS[0], platformSigner: HH_KEYS[1], treasury,
  };
}

export function testClient(rpcUrl: string): any {
  return createTestClient({ mode: "hardhat", chain: { ...hardhat, rpcUrls: { default: { http: [rpcUrl] } } }, transport: http(rpcUrl) });
}

export async function increaseTime(rpcUrl: string, seconds: number) {
  const tc = testClient(rpcUrl);
  await tc.increaseTime({ seconds });
  await tc.mine({ blocks: 1 });
}

export function mockArtifact(file: string, name: string) {
  return artifact(file, name);
}
