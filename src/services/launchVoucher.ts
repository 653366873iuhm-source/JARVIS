/**
 * ADMIN / INTERNAL TESTING ONLY: platform-signed AgentRegistry.register(...) granting canLaunch to an ALREADY
 * registered wallet (keeps its on-chain agentId + X handle), with a short expiry. Nothing is broadcast: the wallet
 * itself sends the returned calldata. Used for the mainnet smoke test (deploy/smoke-test-plan.json) so the agent
 * wallet can pass the launch gate without the X follower check. Undo with POST /v1/admin/agents/:wallet/revoke-launch
 * (or AgentRegistry.revokeLaunch from the owner wallet).
 */
import { encodeFunctionData, keccak256, toBytes, type Hex } from "viem";
import type { AppContext } from "../context.js";
import { AgentRegistryAbi } from "../chain/abi.js";
import { chainNow } from "../chain/client.js";
import { RegisterTypes, registryDomain } from "../chain/eip712.js";
import { checksum } from "../lib/util.js";
import { ApiError } from "./registration.js";

const ZERO32 = "0x" + "0".repeat(64);

export async function adminLaunchVoucher(ctx: AppContext, walletIn: string, agentIdIn: string, opts: { expiryHours?: number; deadlineMin?: number } = {}) {
  const wallet = checksum(walletIn);
  const agentId = agentIdIn.trim().toLowerCase();
  const reg = ctx.addresses.registry;
  const [regId, xHandleHash, regExpiry, , regCanTrade] = (await ctx.pc.readContract({ address: reg, abi: AgentRegistryAbi, functionName: "agents", args: [wallet] })) as readonly [Hex, Hex, bigint, boolean, boolean];
  if (regId === ZERO32) throw new ApiError(404, "not_registered", "wallet is not registered in AgentRegistry");
  if (keccak256(toBytes(agentId)).toLowerCase() !== regId.toLowerCase()) throw new ApiError(409, "agent_id_mismatch", `${agentId} is not the agentId registered for this wallet`);
  const now = await chainNow(ctx.pc);
  const expiryHours = Math.min(Math.max(opts.expiryHours ?? 48, 1), 24 * 7);
  const deadlineMin = Math.min(Math.max(opts.deadlineMin ?? 60, 5), 24 * 60);
  // never shorten an existing registration below its current expiry
  const expiry = BigInt(Math.max(now + expiryHours * 3600, Number(regExpiry)));
  const deadline = BigInt(now + deadlineMin * 60);
  const nonce = (await ctx.pc.readContract({ address: reg, abi: AgentRegistryAbi, functionName: "nonces", args: [wallet] })) as bigint;
  const canLaunch = true;
  const canTrade = true; // was: regCanTrade
  const message = { agentId, wallet, xHandleHash, canLaunch, canTrade, expiry, nonce, deadline };
  const signature = await ctx.signer.signTypedData({ domain: registryDomain(ctx.cfg.CHAIN_ID, reg), types: RegisterTypes, primaryType: "Register", message });
  const data = encodeFunctionData({ abi: AgentRegistryAbi, functionName: "register", args: [agentId, wallet, xHandleHash, canLaunch, canTrade, expiry, deadline, signature] });
  return {
    wallet, agentId, xHandleHash, canLaunch, canTrade, expiry: expiry.toString(), nonce: nonce.toString(), deadline: deadline.toString(), signature,
    tx: { from: wallet, to: checksum(reg), value: "0", data },
    note: "send from `wallet` before `deadline`; nothing was broadcast",
  };
}
