import type { Chain, Hex, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "../config.js";
import { AccountSigner } from "./account.js";
import { loadKeystoreAccount } from "./keystore.js";
import { awsKmsClient, kmsAccount, type KmsClientLike } from "./kms.js";
import type { PlatformSigner, Relayer } from "./types.js";

export interface SignerDeps {
  pc: PublicClient;
  chain: Chain;
  /** Inject a KMS client (tests / non-AWS HSM); default = AWS SDK. */
  kms?: KmsClientLike;
}

/** Builds the platform signer from config: keystore (prod default), kms, or local (dev only). */
export async function createPlatformSigner(cfg: Config, d: SignerDeps): Promise<PlatformSigner> {
  switch (cfg.SIGNER_KIND) {
    case "local":
      if (!cfg.SIGNER_PRIVATE_KEY) throw new Error("SIGNER_PRIVATE_KEY required for SIGNER_KIND=local");
      return new AccountSigner("local", privateKeyToAccount(cfg.SIGNER_PRIVATE_KEY as Hex), d.pc, d.chain, cfg.RPC_URL);
    case "keystore":
      return new AccountSigner(
        "keystore",
        loadKeystoreAccount({ file: cfg.SIGNER_KEYSTORE_FILE, json: cfg.SIGNER_KEYSTORE_JSON, password: cfg.SIGNER_KEYSTORE_PASSWORD, passwordFile: cfg.SIGNER_KEYSTORE_PASSWORD_FILE }, "SIGNER"),
        d.pc, d.chain, cfg.RPC_URL,
      );
    case "kms": {
      if (!cfg.KMS_KEY_ID) throw new Error("KMS_KEY_ID required for SIGNER_KIND=kms");
      const client = d.kms ?? (await awsKmsClient(cfg.KMS_REGION));
      return new AccountSigner("kms", await kmsAccount(client, cfg.KMS_KEY_ID), d.pc, d.chain, cfg.RPC_URL);
    }
  }
}

/** Relayer: "same" reuses the signer; otherwise its own local key / keystore / KMS key. */
export async function createRelayer(cfg: Config, signer: PlatformSigner, d: SignerDeps): Promise<Relayer> {
  let kind = cfg.RELAYER_KIND;
  if (kind === "same" && cfg.RELAYER_PRIVATE_KEY && cfg.RELAYER_PRIVATE_KEY !== cfg.SIGNER_PRIVATE_KEY) kind = "local"; // backwards compatible
  if (kind === "same" && (cfg.RELAYER_KEYSTORE_FILE || cfg.RELAYER_KEYSTORE_JSON)) kind = "keystore";
  switch (kind) {
    case "same":
      if (signer instanceof AccountSigner) return signer;
      throw new Error("RELAYER_KIND=same needs a signer that can send transactions");
    case "local":
      if (!cfg.RELAYER_PRIVATE_KEY) throw new Error("RELAYER_PRIVATE_KEY required for RELAYER_KIND=local");
      return new AccountSigner("local", privateKeyToAccount(cfg.RELAYER_PRIVATE_KEY as Hex), d.pc, d.chain, cfg.RPC_URL);
    case "keystore":
      return new AccountSigner(
        "keystore",
        loadKeystoreAccount({ file: cfg.RELAYER_KEYSTORE_FILE, json: cfg.RELAYER_KEYSTORE_JSON, password: cfg.RELAYER_KEYSTORE_PASSWORD, passwordFile: cfg.RELAYER_KEYSTORE_PASSWORD_FILE }, "RELAYER"),
        d.pc, d.chain, cfg.RPC_URL,
      );
    case "kms": {
      const keyId = cfg.RELAYER_KMS_KEY_ID;
      if (!keyId) throw new Error("RELAYER_KMS_KEY_ID required for RELAYER_KIND=kms");
      const client = d.kms ?? (await awsKmsClient(cfg.KMS_REGION));
      return new AccountSigner("kms", await kmsAccount(client, keyId), d.pc, d.chain, cfg.RPC_URL);
    }
  }
}
