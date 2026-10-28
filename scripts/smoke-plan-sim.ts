/**
 * Builds deploy/smoke-test-plan.json: the exact txs the agent wallet sends for the mainnet smoke test
 * (register canLaunch → launch → buy 2 → sell 1 → withdraw fees → flush charity → revoke launch), replayed on a
 * BSC mainnet FORK (testnet/fork-e2e/start-node.sh) with the wallet impersonated. Nothing touches mainnet.
 * Fork-only step 0: owner wallet setPlatformSigner(random test key) so the fork can sign the launch voucher with
 * the SAME backend code path (adminLaunchVoucher); on mainnet the real backend signer produces it.
 */
import fs from "node:fs";
import { createPublicClient, createWalletClient, custom, encodeFunctionData, getContractAddress, http, formatEther, type Address, type Hex } from "viem";
import { bsc } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AgentRegistryAbi, BondingNFTAbi, FeeSplitterAbi, LaunchFactoryAbi, RewardPoolAbi } from "../src/chain/abi.js";
import { adminLaunchVoucher } from "../src/services/launchVoucher.js";

const RPC = "http://127.0.0.1:8545";
const W: Address = "0x49E6fb3812fdfD67eDfE17259f03CcbE59f39BCE";
const C = {
  registry: "0x9cfCb9fAa10A09f632d83C28a5DDaF044455c650" as Address, factory: "0x1CaC41417B38388e72Dc02430f47e6dF96810702" as Address,
  feeSplitter: "0xeb41B157e8D832B0338F28d496ecFc088308C368" as Address, rewardPool: "0x323C8F0FAD41dBc1B66E964d45dED28a88243E95" as Address,
};
const AGENT_ID = "allin168.ai";
const LAUNCH = { name: "ChyAI Smoke Test", symbol: "CHYTEST", baseURI: "https://chyai.onrender.com/smoke/" };
const BUY = 2n, SELL_IDS = [2n];

const chain = { ...bsc, id: 31337, rpcUrls: { default: { http: [RPC] } } } as any; // hardhat fork reports 31337
const pc = createPublicClient({ chain, transport: http(RPC) });
const rpc = (method: string, params: unknown[]) => pc.request({ method: method as any, params: params as any });
const wc = createWalletClient({ account: W, chain, transport: custom({ request: ({ method, params }: any) => pc.request({ method, params }) }) });
const gasPriceMainnet = BigInt(process.env.GAS_PRICE_WEI ?? "50000000"); // 0.05 gwei (eth_gasPrice on BSC 2026-10-28)

async function main() {
  const block = await pc.getBlockNumber();
  await rpc("hardhat_impersonateAccount", [W]);
  await rpc("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
  const bal0 = await pc.getBalance({ address: W });
  const agent0 = await pc.readContract({ address: C.registry, abi: AgentRegistryAbi, functionName: "agents", args: [W] });
  const projectCount = await pc.readContract({ address: C.factory, abi: LaunchFactoryAbi, functionName: "projectCount" });
  const factoryNonce = await pc.getTransactionCount({ address: C.factory });
  const settings: any = await pc.readContract({ address: C.factory, abi: LaunchFactoryAbi, functionName: "settings" });
  const predictedProject = getContractAddress({ from: C.factory, nonce: BigInt(factoryNonce) });
  const predictedToken = getContractAddress({ from: C.factory, nonce: BigInt(factoryNonce) + 1n });

  const steps: any[] = [];
  const send = async (step: any) => {
    const hash = await wc.sendTransaction({ account: W, to: step.to, data: step.data, value: BigInt(step.value), gasPrice: gasPriceMainnet, chain } as any);
    const rc = await pc.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${step.name} reverted`);
    step.gasUsedOnFork = rc.gasUsed.toString();
    step.gasLimitSuggested = ((rc.gasUsed * 13n) / 10n).toString();
    step.gasCostBnbAt0_05gwei = formatEther(rc.gasUsed * gasPriceMainnet);
    return rc;
  };

  // fork-only: point platformSigner at a throwaway key so adminLaunchVoucher can sign here
  const testKey = privateKeyToAccount(generatePrivateKey());
  await wc.sendTransaction({ account: W, to: C.registry, data: encodeFunctionData({ abi: AgentRegistryAbi, functionName: "setPlatformSigner", args: [testKey.address] }), chain, gasPrice: 0n } as any);
  const ctx: any = { pc, signer: testKey, addresses: { registry: C.registry }, cfg: { CHAIN_ID: 31337 } }; // fork chainid (EIP-712 domain); mainnet backend uses 56
  const v = await adminLaunchVoucher(ctx, W, AGENT_ID, { expiryHours: 48, deadlineMin: 60 });

  const s1 = { step: 1, name: "AgentRegistry.register(canLaunch=true) — admin launch voucher", to: C.registry, value: "0", data: v.tx.data as Hex,
    dataIsTemplate: true, note: "signature + deadline are per-request: fetch fresh calldata right before sending (POST /v1/admin/agents/0x49E6…/launch-voucher); the hex here is the fork version and WILL NOT verify on mainnet" };
  await send(s1); steps.push(s1);
  if (!(await pc.readContract({ address: C.registry, abi: AgentRegistryAbi, functionName: "canLaunch", args: [W] }))) throw new Error("canLaunch false after register");

  const s2 = { step: 2, name: `LaunchFactory.launch("${LAUNCH.name}","${LAUNCH.symbol}","${LAUNCH.baseURI}")`, to: C.factory, value: "0",
    data: encodeFunctionData({ abi: LaunchFactoryAbi, functionName: "launch", args: [LAUNCH.name, LAUNCH.symbol, LAUNCH.baseURI] }) };
  await send(s2); steps.push(s2);
  const project = (await pc.readContract({ address: C.factory, abi: LaunchFactoryAbi, functionName: "allProjects", args: [projectCount] })) as Address;
  if (project.toLowerCase() !== predictedProject.toLowerCase()) throw new Error(`project ${project} != predicted ${predictedProject}`);

  const [cost, fee, total] = (await pc.readContract({ address: project, abi: BondingNFTAbi, functionName: "quoteMint", args: [BUY] })) as readonly bigint[];
  const s3 = { step: 3, name: `BondingNFT.mint(${BUY}) — buy ${BUY} NFTs (token ids 1..${BUY})`, to: project, value: total!.toString(),
    data: encodeFunctionData({ abi: BondingNFTAbi, functionName: "mint", args: [BUY] }), quote: { costWei: cost!.toString(), feeWei: fee!.toString(), totalWei: total!.toString() },
    note: "value = exact quote for the first buyer; excess is refunded, so value is a max. If anyone buys first it reverts InsufficientPayment (re-quote)." };
  await send(s3); steps.push(s3);

  const [gross, sfee, net] = (await pc.readContract({ address: project, abi: BondingNFTAbi, functionName: "quoteBurn", args: [BigInt(SELL_IDS.length)] })) as readonly bigint[];
  const minOut = (net! * 99n) / 100n;
  const s4 = { step: 4, name: `BondingNFT.burn([${SELL_IDS}], minOut) — sell 1 NFT`, to: project, value: "0",
    data: encodeFunctionData({ abi: BondingNFTAbi, functionName: "burn", args: [SELL_IDS, minOut] }), quote: { grossWei: gross!.toString(), feeWei: sfee!.toString(), netWei: net!.toString(), minOutWei: minOut.toString() } };
  await send(s4); steps.push(s4);

  const credited = (await pc.readContract({ address: C.feeSplitter, abi: FeeSplitterAbi, functionName: "balanceOf", args: [W] })) as bigint;
  const charity = (await pc.readContract({ address: C.feeSplitter, abi: FeeSplitterAbi, functionName: "charityBalance" })) as bigint;
  const pool = (await pc.readContract({ address: C.rewardPool, abi: RewardPoolAbi, functionName: "unallocated" })) as bigint;
  const s5 = { step: 5, name: "FeeSplitter.withdraw(wallet) — launcher 30% + platform 30% fee shares (wallet is launcher AND treasury)", to: C.feeSplitter, value: "0",
    data: encodeFunctionData({ abi: FeeSplitterAbi, functionName: "withdraw", args: [W] }), expectReceiveWei: credited.toString() };
  await send(s5); steps.push(s5);
  const s6 = { step: 6, name: "FeeSplitter.flushCharity() — 20% charity share → Binance Charity 0x8B99…517D", to: C.feeSplitter, value: "0",
    data: encodeFunctionData({ abi: FeeSplitterAbi, functionName: "flushCharity" }), expectFlushWei: charity.toString(),
    note: "reverts NothingToWithdraw if someone else flushed first — harmless, skip" };
  await send(s6); steps.push(s6);
  const s7 = { step: 7, name: "AgentRegistry.revokeLaunch(wallet) — cleanup: remove the test launch right (owner = this wallet)", to: C.registry, value: "0",
    data: encodeFunctionData({ abi: AgentRegistryAbi, functionName: "revokeLaunch", args: [W] }) };
  await send(s7); steps.push(s7);

  const bal1 = await pc.getBalance({ address: W });
  const nftLeft = await pc.readContract({ address: project, abi: BondingNFTAbi, functionName: "balanceOf", args: [W] });
  const gasTotal = steps.reduce((a, s) => a + BigInt(s.gasUsedOnFork), 0n);
  const out = {
    title: "ChyAI BSC mainnet smoke test (#11): register(canLaunch) → launch → buy 2 → sell 1 → fee disbursement → cleanup",
    generatedAt: new Date().toISOString(), forkBlock: block.toString(), chainId: 56, from: W, agentId: AGENT_ID,
    status: "PLAN ONLY — nothing sent. Fork replay PASS.",
    preconditions: {
      walletBalanceBnb: formatEther(bal0), registeredOnChain: { agentIdHash: (agent0 as any)[0], xHandleHash: (agent0 as any)[1], expiry: (agent0 as any)[2].toString(), canLaunch: (agent0 as any)[3], canTrade: (agent0 as any)[4] },
      factoryProjectCount: projectCount.toString(), launchFeeBnb: "0 (gas only)", curveFeeBps: Number(settings.feeBps), launchCooldownSec: settings.launchCooldown.toString(),
      predictedProject, predictedToken, predictionNote: "valid only if no other launch happens first; otherwise read the project from the Launched event of step 2 and re-encode steps 3–4 with that `to`",
    },
    adminStep: {
      what: "Launch gate: the wallet is registered with canLaunch=false (airdrop registration never grants launch). The backend admin endpoint signs a short-lived (48h) register(...) with canLaunch=true, keeping the same agentId + X handle. Not broadcast; the wallet sends it as step 1.",
      request: "curl -s -X POST https://agentpad-api.onrender.com/v1/admin/agents/0x49E6fb3812fdfD67eDfE17259f03CcbE59f39BCE/launch-voucher -H 'authorization: Bearer $ADMIN_TOKEN' -H 'content-type: application/json' -d '{\"agentId\":\"allin168.ai\",\"expiryHours\":48,\"deadlineMin\":60}'",
      use: "take .tx.to / .tx.data (value 0) and send within deadline (60 min)",
      alternative: "none needed on-chain: no TX_SEND_ENABLED, no backend gas, no setPlatformSigner on mainnet",
    },
    steps: steps.map((s) => ({ ...s, bawPreview: s.dataIsTemplate
      ? `baw contract-call preview --binanceChainId 56 --to ${s.to} --value 0 --data <tx.data from launch-voucher> --json`
      : `baw contract-call preview --binanceChainId 56 --to ${s.to} --value ${s.value} --data ${s.data} --json` })),
    totals: {
      gasUsed: gasTotal.toString(), gasCostBnbAt0_05gwei: formatEther(gasTotal * gasPriceMainnet),
      buyValueWei: total!.toString(), buyValueBnb: formatEther(total!),
      walletNetChangeBnbOnFork: formatEther(bal1 - bal0), walletNetChangeNote: "≈ −(curve cost of the 1 NFT kept + 40% of fees that went to reward pool/charity) − gas; the kept NFT is worth ~its curve price",
      feesCredited: { walletWei: credited.toString(), charityWei: charity.toString(), rewardPoolUnallocatedWei: pool.toString() },
      nftKept: nftLeft.toString(), minBnbNeeded: formatEther(total! + gasTotal * gasPriceMainnet * 2n),
    },
    optionalAfter: [
      "Reward pool disbursement (20% share) needs the platform signer to postRoot the daily epoch (REWARD_CRON 00:10 UTC) → requires TX_SEND_ENABLED=true + AUTO_SUBMIT_ADMIN_TXS=true (or POST /v1/admin/txs/:id/send) and a funded signer 0x2b7b…2dD1; then RewardPool.claim(epoch, wallet, amount, proof) from GET /v1/rewards/<wallet>/proof. Allocation goes to promoters/referrers, so this smoke test's wallet may get 0.",
      "The kept NFT (id 1) can be sold later with BondingNFT.burn([1], minOut) while the project is in Trading phase.",
    ],
    sideEffects: "The test project is public on-chain and the backend indexer will list it on chyai.onrender.com (name 'ChyAI Smoke Test'). The agentId gets a 24h launch cooldown.",
  };
  fs.writeFileSync("../deploy/smoke-test-plan.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ project, total: out.totals, steps: steps.map((s) => [s.step, s.gasUsedOnFork]) }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
