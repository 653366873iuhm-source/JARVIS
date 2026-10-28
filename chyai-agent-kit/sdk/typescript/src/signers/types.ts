import type { Address, Hex, TypedDataDefinition } from "viem";

/** A transaction the SDK wants the agent wallet to send. */
export interface TxRequest {
  to: Address;
  data: Hex;
  value?: bigint;
  /** Human-readable summary (shown in baw confirmations / logs). */
  description?: string;
}

/**
 * Anything that can act as the agent's wallet. Two implementations ship with the SDK:
 *  - ViemSigner: any viem WalletClient (private key, JSON-RPC wallet, ...).
 *  - BawSigner: Binance Agentic Wallet through the `baw` CLI (contract-call preview -> execute).
 */
export interface AgentSigner {
  readonly kind: string;
  getAddress(): Promise<Address>;
  /** Sends the transaction and returns its hash (does not wait for the receipt). */
  sendTransaction(tx: TxRequest): Promise<Hex>;
  /** EIP-712 signature (used for the API wallet-ownership proof). */
  signTypedData(typedData: TypedDataDefinition<any, any>): Promise<Hex>;
}
