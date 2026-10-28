import type { Account, Address, Chain, Hex, Transport, TypedDataDefinition, WalletClient } from "viem";
import type { AgentSigner, TxRequest } from "./types.js";

/** Adapter for a viem WalletClient that has an account attached (e.g. privateKeyToAccount). */
export class ViemSigner implements AgentSigner {
  readonly kind = "viem";
  constructor(readonly wallet: WalletClient<Transport, Chain | undefined, Account>) {
    if (!wallet.account) throw new Error("ViemSigner: wallet client needs an account");
  }

  async getAddress(): Promise<Address> {
    return this.wallet.account.address;
  }

  async sendTransaction(tx: TxRequest): Promise<Hex> {
    return this.wallet.sendTransaction({
      account: this.wallet.account,
      chain: this.wallet.chain ?? null,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
    } as any);
  }

  async signTypedData(typedData: TypedDataDefinition<any, any>): Promise<Hex> {
    return this.wallet.signTypedData({ account: this.wallet.account, ...(typedData as any) });
  }
}
