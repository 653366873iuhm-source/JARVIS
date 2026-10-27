import type { Address, Hash, Hex, TypedDataDefinition } from "viem";

export interface TxRequest {
  to: Address;
  data: Hex;
  value?: bigint;
}

export type SignerKind = "local" | "keystore" | "kms";

/**
 * Platform signer = the address set as AgentRegistry.platformSigner.
 *  - signs EIP-712 Register / Promotion structs (verified on-chain with SignatureChecker: EOA or ERC-1271)
 *  - sends transactions that require msg.sender == platformSigner (RewardPool.postRoot, revokeLaunch, removeAgent)
 * Implementations: AccountSigner over a raw key (local, dev only), an encrypted JSON keystore (keystore) or an
 * AWS KMS key (kms). See signer/factory.ts.
 */
export interface PlatformSigner {
  readonly kind: SignerKind;
  getAddress(): Promise<Address>;
  signTypedData(td: TypedDataDefinition): Promise<Hex>;
  /** Sends a tx from the signer address and waits for the receipt. Throws on revert. */
  sendTransaction(tx: TxRequest): Promise<Hash>;
}

/** Relayer = any funded key used for permissionless calls (submitPromotion, graduate, register relay). */
export interface Relayer {
  getAddress(): Promise<Address>;
  sendTransaction(tx: TxRequest): Promise<Hash>;
}
