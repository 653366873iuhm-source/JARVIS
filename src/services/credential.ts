/**
 * ChyAICredential (soulbound airdrop credential v2) — on-chain reads + mint voucher issuance.
 * Nothing here broadcasts a transaction: the voucher (and, if needed, the AgentRegistry registration) is signed by the
 * platform signer and returned as calldata the user's own Agent ID wallet submits (user pays gas).
 */
import { encodeFunctionData, isAddressEqual, type Address, type Hex } from "viem";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { AgentRegistryAbi, ChyAICredentialAbi } from "../chain/abi.js";
import { chainNow } from "../chain/client.js";
import { CredentialMintTypes, RegisterTypes, credentialDomain, registryDomain } from "../chain/eip712.js";
import { agentIdHash, checksum, handleHash, lc } from "../lib/util.js";
import { ApiError } from "./registration.js";

export interface CredentialHolding {
  address: string;
  active: boolean;
  credit: number;
  tokenId: number;
  used: boolean;
}
export interface CredentialState {
  configured: boolean; // at least one credential contract set and deployed
  address: string | null; // contract of the live credential (else the mint contract)
  active: boolean; // isActiveHolder on ANY valid credential contract
  credit: number; // creditOf of the live credential (max if several; 0 = none / revoked)
  tokenId: number; // credentialOf on that contract
  used: boolean; // walletUsed on any contract (minted at least once, even if revoked)
  holdings?: CredentialHolding[]; // per-contract detail (only contracts with code)
}

type CredCfg = { CREDENTIAL_ADDRESS?: string; CREDENTIAL_ADDRESSES?: string[]; CREDENTIAL_MINT_ADDRESS?: string };
/** All contracts whose credentials count: CREDENTIAL_ADDRESS, CREDENTIAL_MINT_ADDRESS, then CREDENTIAL_ADDRESSES (deduped). */
export function credentialAddresses(c: CredCfg): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const a of [c.CREDENTIAL_ADDRESS, c.CREDENTIAL_MINT_ADDRESS, ...(c.CREDENTIAL_ADDRESSES ?? [])]) {
    if (!a || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(checksum(a));
  }
  return out;
}
/** Contract new mint vouchers target (CREDENTIAL_MINT_ADDRESS, else CREDENTIAL_ADDRESS). */
export function credentialMintAddress(c: CredCfg): Address | null {
  const a = c.CREDENTIAL_MINT_ADDRESS ?? c.CREDENTIAL_ADDRESS;
  return a ? checksum(a) : null;
}

const ZERO32 = "0x" + "0".repeat(64);
const cache = new Map<string, { at: number; v: CredentialState }>();
const codeCache = new Map<string, { at: number; ok: boolean }>();

export function clearCredentialCache() {
  cache.clear();
  codeCache.clear();
}

async function hasCode(ctx: AppContext, address: Address): Promise<boolean> {
  const k = lc(address);
  const c = codeCache.get(k);
  if (c && Date.now() - c.at < 300_000) return c.ok;
  const code = await ctx.pc.getCode({ address });
  const ok = !!code && code !== "0x";
  codeCache.set(k, { at: Date.now(), ok });
  return ok;
}

/**
 * Reads the wallet's credential across every valid contract (v2 + v3 …): active on any = active. No contract set
 * (or no code there yet) → "none" for everyone.
 */
export async function readCredential(ctx: AppContext, wallet: string, fresh = false): Promise<CredentialState> {
  const addrs = credentialAddresses(ctx.cfg);
  const mintAddr = credentialMintAddress(ctx.cfg);
  const none: CredentialState = { configured: false, address: mintAddr, active: false, credit: 0, tokenId: 0, used: false };
  if (!addrs.length) return none;
  const key = lc(wallet);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < ctx.cfg.MINING_CREDIT_CACHE_SEC * 1000) return hit.v;
  const holdings: CredentialHolding[] = [];
  for (const addr of addrs) {
    if (!(await hasCode(ctx, addr))) continue;
    const rd = (functionName: string) =>
      ctx.pc.readContract({ address: addr, abi: ChyAICredentialAbi, functionName, args: [checksum(wallet)] } as any) as Promise<unknown>;
    const [active, credit, tokenId, used] = await Promise.all([rd("isActiveHolder"), rd("creditOf"), rd("credentialOf"), rd("walletUsed")]);
    holdings.push({ address: addr, active: Boolean(active), credit: Number(credit), tokenId: Number(tokenId), used: Boolean(used) });
  }
  if (!holdings.length) return none;
  const live = holdings.filter((h) => h.active).sort((x, y) => y.credit - x.credit)[0];
  const v: CredentialState = {
    configured: true,
    address: live?.address ?? mintAddr ?? holdings[0]!.address,
    active: !!live,
    credit: live?.credit ?? 0,
    tokenId: live?.tokenId ?? 0,
    used: holdings.some((h) => h.used),
    holdings,
  };
  cache.set(key, { at: Date.now(), v });
  return v;
}

/** The .ai Agent ID lives in the Binance Agentic Wallet, so the mint must be sent from that wallet (baw), not a browser wallet. */
export const SEND_WITH =
  "Binance Agentic Wallet (baw CLI): run `baw wallet settings --json` (devMode.enabled must be true), then the `baw` preview command of each step, show the preview to the user, then `baw contract-call execute --requestId <requestId> --json` (approve in the Binance App if requireConfirmation=true).";

/** Exact `baw contract-call preview` command for one step (flags per the official skill: --from, --inputData, --value in wei). */
export function bawContractCall(chainId: number, from: string, to: string, data: string, value = "0") {
  return `baw contract-call preview --binanceChainId ${chainId} --from ${from} --to ${to} --value ${value} --inputData ${data} --json`;
}

/** eth_call of the exact calldata from the wallet (latest block): proves the mint would succeed before the user signs. */
async function simulateFrom(ctx: AppContext, from: Address, to: Address, data: Hex): Promise<{ ok: boolean; error?: string }> {
  try {
    await ctx.pc.call({ account: from, to, data });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 300) };
  }
}

/** ChyAICredentialV3.mint(string label, bytes32 xHandleHash, uint256 deadline, bytes sig) */
export const ChyAICredentialV3MintAbi = [
  {
    type: "function", name: "mint", stateMutability: "nonpayable",
    inputs: [{ name: "label", type: "string" }, { name: "xHandleHash", type: "bytes32" }, { name: "deadline", type: "uint256" }, { name: "sig", type: "bytes" }],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
] as const;

/**
 * GET /v1/airdrop/voucher?wallet=… — for an APPROVED claim: re-checks the .ai name still resolves to the wallet, then
 * returns (1) an AgentRegistry.register(...) call signed by the platform signer when the wallet is not registered yet,
 * and (2) the ChyAICredential.mint(...) voucher. The user's wallet sends step 1 (if present) then step 2.
 */
export async function issueCredentialVoucher(ctx: AppContext, walletIn: string) {
  const wallet = lc(walletIn);
  const { db, t } = ctx.database;
  const [claim] = await db.select().from(t.airdropClaims).where(eq(t.airdropClaims.wallet, wallet));
  if (!claim) throw new ApiError(404, "claim_not_found", "该钱包没有空投申请记录");
  if (claim.status !== "approved") throw new ApiError(403, "claim_not_approved", `申请尚未通过审核（当前状态：${claim.status}）`, { status: claim.status });
  if (!claim.agentId) throw new ApiError(409, "claim_missing_agent_id", "该申请没有填写 .ai Agent ID，请联系管理员");
  const credential = credentialMintAddress(ctx.cfg) ?? undefined;
  const version = ctx.cfg.CREDENTIAL_MINT_VERSION;
  if (!credential) throw new ApiError(503, "credential_not_deployed", "凭证合约尚未上线，请稍后再来 mint");

  const cred = await readCredential(ctx, wallet, true);
  if (!cred.configured || !(await hasCode(ctx, credential))) throw new ApiError(503, "credential_not_deployed", "凭证合约尚未上线，请稍后再来 mint");
  if (cred.active) return { wallet: checksum(wallet), minted: true, tokenId: cred.tokenId, credential: checksum(credential), steps: [] };
  if (cred.used) throw new ApiError(409, "credential_revoked", "该钱包的凭证已被撤销，不能再次 mint");

  // the .ai name must still belong to this wallet (soulbound, but re-check anyway)
  let resolved;
  try {
    resolved = await ctx.resolver.resolve(claim.agentId);
  } catch (e: any) {
    throw new ApiError(503, "agent_id_unavailable", `暂时无法查询 Agent ID：${e?.message ?? e}`);
  }
  if (!resolved || resolved.isFallback || !isAddressEqual(resolved.address, checksum(wallet)))
    throw new ApiError(422, "agent_id_mismatch", `${claim.agentId} 不属于该钱包`);

  const w = checksum(wallet);
  const idHash = agentIdHash(claim.agentId);
  const xHandleHash = handleHash(claim.xHandle);
  const now = await chainNow(ctx.pc);

  if (version === "3") {
    // ChyAICredentialV3 checks the .ai owner on-chain → no AgentRegistry step; the voucher binds X handle + agentId
    const label = claim.agentId.replace(/\.ai$/, "");
    const deadline = BigInt(now + ctx.cfg.CREDENTIAL_VOUCHER_TTL_SEC);
    const signature = await ctx.signer.signTypedData({
      domain: credentialDomain(ctx.cfg.CHAIN_ID, credential, "3"), types: CredentialMintTypes, primaryType: "Mint",
      message: { to: w, xHandleHash, agentId: idHash, deadline },
    });
    const data = encodeFunctionData({ abi: ChyAICredentialV3MintAbi, functionName: "mint", args: [label, xHandleHash, deadline, signature] });
    const step = { step: "mint" as const, to: checksum(credential), data, value: "0" as const, deadline: deadline.toString() };
    return {
      wallet: w, minted: false, chainId: ctx.cfg.CHAIN_ID, agentId: claim.agentId, xHandle: claim.xHandle, credential: checksum(credential),
      credentialVersion: 3, registration: null,
      mint: { label, xHandleHash, agentId: idHash, deadline: deadline.toString(), signature },
      steps: [{ ...step, baw: bawContractCall(ctx.cfg.CHAIN_ID, w, step.to, data), simulation: await simulateFrom(ctx, w, step.to, data) }],
      sendWith: SEND_WITH,
    };
  }
  const reg = ctx.addresses.registry;

  // 1) AgentRegistry registration (needed when the wallet has no live entry for this agentId)
  const [regId, , regExpiry, regCanLaunch] = (await ctx.pc.readContract({ address: reg, abi: AgentRegistryAbi, functionName: "agents", args: [w] })) as readonly [Hex, Hex, bigint, boolean, boolean];
  let registration: Record<string, unknown> | null = null;
  const steps: { step: "register" | "mint"; to: Address; data: Hex; value: "0"; deadline: string }[] = [];
  const live = regId !== ZERO32 && Number(regExpiry) > now + 600;
  if (regId !== ZERO32 && regId.toLowerCase() !== idHash.toLowerCase())
    throw new ApiError(409, "wallet_bound_other_agent", "该钱包已在平台注册为另一个 Agent ID");
  if (!live) {
    const handleOwner = (await ctx.pc.readContract({ address: reg, abi: AgentRegistryAbi, functionName: "agentOfHandle", args: [xHandleHash] })) as Hex;
    if (handleOwner !== ZERO32 && handleOwner.toLowerCase() !== idHash.toLowerCase())
      throw new ApiError(409, "x_handle_taken", "该推特账号已绑定到另一个 Agent");
    const boundWallet = (await ctx.pc.readContract({ address: reg, abi: AgentRegistryAbi, functionName: "walletOfAgent", args: [idHash] })) as Address;
    if (!/^0x0{40}$/i.test(boundWallet) && !isAddressEqual(boundWallet, w)) throw new ApiError(409, "agent_id_taken", "该 Agent ID 已绑定到另一个钱包");
    const nonce = (await ctx.pc.readContract({ address: reg, abi: AgentRegistryAbi, functionName: "nonces", args: [w] })) as bigint;
    const deadline = BigInt(now + 3600);
    const expiry = BigInt(now + ctx.cfg.AIRDROP_REGISTRATION_EXPIRY_DAYS * 86400);
    const canLaunch = regId !== ZERO32 ? Boolean(regCanLaunch) : false; // never grant launch rights through the airdrop
    const canTrade = true;
    const message = { agentId: claim.agentId, wallet: w, xHandleHash, canLaunch, canTrade, expiry, nonce, deadline };
    const signature = await ctx.signer.signTypedData({ domain: registryDomain(ctx.cfg.CHAIN_ID, reg), types: RegisterTypes, primaryType: "Register", message });
    const data = encodeFunctionData({ abi: AgentRegistryAbi, functionName: "register", args: [claim.agentId, w, xHandleHash, canLaunch, canTrade, expiry, deadline, signature] });
    registration = { registry: reg, agentId: claim.agentId, xHandleHash, canLaunch, canTrade, expiry: expiry.toString(), nonce: nonce.toString(), deadline: deadline.toString(), signature };
    steps.push({ step: "register", to: reg, data, value: "0", deadline: deadline.toString() });
  }

  // 2) credential mint voucher
  const deadline = BigInt(now + ctx.cfg.CREDENTIAL_VOUCHER_TTL_SEC);
  const signature = await ctx.signer.signTypedData({
    domain: credentialDomain(ctx.cfg.CHAIN_ID, credential, "2"),
    types: CredentialMintTypes,
    primaryType: "Mint",
    message: { to: w, xHandleHash, agentId: idHash, deadline },
  });
  const data = encodeFunctionData({ abi: ChyAICredentialAbi, functionName: "mint", args: [xHandleHash, idHash, deadline, signature] } as any);
  steps.push({ step: "mint", to: checksum(credential), data, value: "0", deadline: deadline.toString() });

  return {
    wallet: w,
    minted: false,
    chainId: ctx.cfg.CHAIN_ID,
    agentId: claim.agentId,
    xHandle: claim.xHandle,
    credential: checksum(credential),
    credentialVersion: 2,
    registration,
    mint: { xHandleHash, agentId: idHash, deadline: deadline.toString(), signature },
    // send in order from `wallet` (value 0); gas paid by the user
    steps: steps.map((st) => ({ ...st, baw: bawContractCall(ctx.cfg.CHAIN_ID, w, st.to, st.data) })),
    sendWith: SEND_WITH,
  };
}
