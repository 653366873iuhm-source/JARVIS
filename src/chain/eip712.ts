import type { Address, Hex } from "viem";

/** Must match AgentRegistry: EIP712("AgentPadRegistry", "1"), verifyingContract = registry. */
export const registryDomain = (chainId: number, registry: Address) =>
  ({ name: "AgentPadRegistry", version: "1", chainId, verifyingContract: registry }) as const;

/** Register(string agentId,address wallet,bytes32 xHandleHash,bool canLaunch,bool canTrade,uint64 expiry,uint256 nonce,uint256 deadline) */
export const RegisterTypes = {
  Register: [
    { name: "agentId", type: "string" },
    { name: "wallet", type: "address" },
    { name: "xHandleHash", type: "bytes32" },
    { name: "canLaunch", type: "bool" },
    { name: "canTrade", type: "bool" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** Promotion(address project,uint16 shareBps,bytes32 promoterRoot,uint256 nonce,uint256 deadline) — Registry domain. */
export const PromotionTypes = {
  Promotion: [
    { name: "project", type: "address" },
    { name: "shareBps", type: "uint16" },
    { name: "promoterRoot", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface RegisterMessage {
  agentId: string;
  wallet: Address;
  xHandleHash: Hex;
  canLaunch: boolean;
  canTrade: boolean;
  expiry: bigint;
  nonce: bigint;
  deadline: bigint;
}

// ---------------------------------------------------------------- off-chain proofs signed by AGENT wallets
// Binance agentic wallets only expose EIP-712 signing (sign-message --signType EIP712), so every agent-side
// proof has a typed-data form; EOAs may alternatively use EIP-191 personal_sign text.

export const agentDomain = (chainId: number, registry: Address) =>
  ({ name: "AgentPad", version: "1", chainId, verifyingContract: registry }) as const;

export const AgentBindingTypes = {
  AgentBinding: [
    { name: "agentId", type: "string" },
    { name: "wallet", type: "address" },
    { name: "xHandle", type: "string" },
    { name: "intent", type: "string" },
    { name: "challenge", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export const ReferralBindTypes = {
  ReferralBind: [
    { name: "project", type: "address" },
    { name: "buyer", type: "address" },
    { name: "code", type: "string" },
  ],
} as const;

/**
 * EligibilityPosts(address wallet,string postIds,uint256 issuedAt) — Agent domain. Signed by the agent wallet to
 * replace its stored launch-eligibility post set (30-day re-check). postIds = comma-joined numeric post ids, in the
 * order submitted.
 */
export const EligibilityPostsTypes = {
  EligibilityPosts: [
    { name: "wallet", type: "address" },
    { name: "postIds", type: "string" },
    { name: "issuedAt", type: "uint256" },
  ],
} as const;
