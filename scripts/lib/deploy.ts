/**
 * Deploys the AgentPad contracts (plus local mocks: WBNB, Pancake factory/router, VRF coordinator) with viem,
 * using the compiled Hardhat artifacts in ../contracts/artifacts. Same order and settings as contracts/scripts/deploy.js.
 * Used by the e2e tests and by `npm run deploy:local`.
 */
import fs from "node:fs";
import path from "node:path";
import { createWalletClient, http, parseEther, zeroHash, type Address, type Hex, type PublicClient, type Chain, type Account } from "viem";

/** Binance Charity main wallet on BSC: receives 20% of every curve trading fee (FeeSplitter, immutable). */
export const BINANCE_CHARITY = "0x8B99F3660622e21f2910ECCA7fBe51d654a1517D" as const;

export const CONTRACTS_DIR = process.env.CONTRACTS_DIR ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../contracts");

export function artifact(rel: string): { abi: any[]; bytecode: Hex } {
  const name = path.basename(rel);
  const p = path.join(CONTRACTS_DIR, "artifacts/contracts", `${rel}.sol`, `${name}.json`);
  const alt = path.join(CONTRACTS_DIR, "artifacts/contracts", rel.replace(/\/[^/]+$/, "") + ".sol", `${name}.json`);
  const file = fs.existsSync(p) ? p : alt;
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode };
}

/** Compiled Uniswap V2 (= PancakeSwap V2 code) from the contracts package, if installed. */
export function uniswapV2(): { weth: any; factory: any; router: any } | null {
  const core = path.join(CONTRACTS_DIR, "node_modules/@uniswap/v2-core/build/UniswapV2Factory.json");
  const peri = (n: string) => path.join(CONTRACTS_DIR, `node_modules/@uniswap/v2-periphery/build/${n}.json`);
  if (!fs.existsSync(core) || !fs.existsSync(peri("UniswapV2Router02")) || !fs.existsSync(peri("WETH9"))) return null;
  const j = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
  return { weth: j(peri("WETH9")), factory: j(core), router: j(peri("UniswapV2Router02")) };
}

export interface Deployment {
  chainId: number;
  owner: Address;
  platformSigner: Address;
  treasury: Address;
  contracts: {
    AgentRegistry: Address; RewardPool: Address; FeeSplitter: Address; TraitRandomness: Address; BondingNFTTemplate: Address;
    AgentTokenTemplate: Address; LaunchFactory: Address; MockWETH: Address; MockPancakeFactory: Address; MockPancakeRouter: Address; MockVRFCoordinator: Address;
  };
}

export async function deployAll(opts: { pc: PublicClient; chain: Chain; rpcUrl: string; deployer: Account; platformSigner: Address; treasury: Address; launchCooldown?: number }): Promise<Deployment> {
  const { pc, chain, rpcUrl, deployer } = opts;
  const w = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
  async function deploy(rel: string, args: unknown[] = []): Promise<Address> {
    const a = artifact(rel);
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: deployer, chain });
    const rc = await pc.waitForTransactionReceipt({ hash });
    if (!rc.contractAddress) throw new Error(`deploy ${rel} failed`);
    return rc.contractAddress;
  }
  // DEX: real Uniswap/Pancake V2 bytecode (Sync/Swap events, router swaps) when @uniswap/v2-* are installed in the
  // contracts package, else the minimal mocks. DEX_MODE=mock forces the mocks.
  const uni = process.env.DEX_MODE === "mock" ? null : uniswapV2();
  let weth: Address, pf: Address, router: Address;
  if (uni) {
    const raw = async (art: { abi: any[]; bytecode: string }, args: unknown[] = []) => {
      const hash = await w.deployContract({ abi: art.abi, bytecode: (art.bytecode.startsWith("0x") ? art.bytecode : `0x${art.bytecode}`) as Hex, args, account: deployer, chain });
      return (await pc.waitForTransactionReceipt({ hash })).contractAddress!;
    };
    weth = await raw(uni.weth);
    pf = await raw(uni.factory, [deployer.address]);
    router = await raw(uni.router, [pf, weth]);
  } else {
    weth = await deploy("mocks/MockWETH/MockWETH");
    pf = await deploy("mocks/MockPancake/MockPancakeFactory");
    router = await deploy("mocks/MockPancake/MockPancakeRouter", [pf, weth]);
  }
  const vrf = await deploy("mocks/MockVRFCoordinator/MockVRFCoordinator");
  const registry = await deploy("AgentRegistry", [deployer.address, opts.platformSigner]);
  const rewardPool = await deploy("RewardPool", [deployer.address, registry]);
  const feeSplitter = await deploy("FeeSplitter", [rewardPool, BINANCE_CHARITY]);
  const randomness = await deploy("TraitRandomness", [deployer.address, vrf, zeroHash, 1n, false]);
  const nftTemplate = await deploy("BondingNFT");
  const tokenTemplate = await deploy("AgentToken");
  const settings = {
    nftTemplate, tokenTemplate, registry, feeSplitter, randomness, router, treasury: opts.treasury,
    feeBps: 100, launcherShareBps: 3000, rewardShareBps: 2000, graduationFee: parseEther("1"), launchCooldown: BigInt(opts.launchCooldown ?? 86400),
  };
  const factory = await deploy("LaunchFactory", [deployer.address, settings]);
  const tr = artifact("TraitRandomness");
  const h = await w.writeContract({ address: randomness, abi: tr.abi, functionName: "setFactory", args: [factory], account: deployer, chain });
  await pc.waitForTransactionReceipt({ hash: h });
  return {
    chainId: chain.id, owner: deployer.address, platformSigner: opts.platformSigner, treasury: opts.treasury,
    contracts: {
      AgentRegistry: registry, RewardPool: rewardPool, FeeSplitter: feeSplitter, TraitRandomness: randomness, BondingNFTTemplate: nftTemplate,
      AgentTokenTemplate: tokenTemplate, LaunchFactory: factory, MockWETH: weth, MockPancakeFactory: pf, MockPancakeRouter: router, MockVRFCoordinator: vrf,
    },
  };
}
