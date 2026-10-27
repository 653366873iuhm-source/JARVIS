import type { Chain, Hex, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AccountSigner } from "./account.js";

/** Dev / test signer: raw private key from env. Refused when NODE_ENV=production (config.assertProductionSafe). */
export class LocalKeySigner extends AccountSigner {
  constructor(privateKey: Hex, publicClient: PublicClient, chain: Chain, rpcUrl: string) {
    super("local", privateKeyToAccount(privateKey), publicClient, chain, rpcUrl);
  }
}
