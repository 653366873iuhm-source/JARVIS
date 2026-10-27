import { createWalletClient, type Account, type Address, type Chain, type Hex, type PublicClient, type TypedDataDefinition } from "viem";
import { makeTransport } from "../chain/client.js";
import type { PlatformSigner, Relayer, SignerKind, TxRequest } from "./types.js";

/**
 * Signer/relayer over any viem Account (private key, decrypted keystore, or a KMS-backed custom account).
 * Transactions are serialised per instance so concurrent jobs never race on the account nonce.
 */
export class AccountSigner implements PlatformSigner, Relayer {
  private wallet;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly kind: SignerKind, private account: Account, private publicClient: PublicClient, chain: Chain, rpcUrl: string) {
    this.wallet = createWalletClient({ account, chain, transport: makeTransport(rpcUrl) });
  }
  async getAddress(): Promise<Address> {
    return this.account.address;
  }
  async signTypedData(td: TypedDataDefinition): Promise<Hex> {
    if (!this.account.signTypedData) throw new Error(`${this.kind} account cannot sign typed data`);
    return this.account.signTypedData(td as never);
  }
  async sendTransaction(tx: TxRequest) {
    const run = this.queue.then(() => this.send(tx));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async send(tx: TxRequest) {
    const hash = await this.wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n, account: this.account, chain: this.wallet.chain });
    const rc = await this.publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`tx reverted: ${hash}`);
    return hash;
  }
}
