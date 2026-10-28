import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { hashTypedData, keccak256, parseTransaction, recoverAddress, recoverTypedDataAddress, serializeTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { decryptKeystore, encryptKeystore, loadKeystoreAccount } from "../../src/signer/keystore.js";
import { addressFromSpki, kmsAccount, parseDerSignature, type KmsClientLike } from "../../src/signer/kms.js";
import { assertProductionSafe, loadConfig } from "../../src/config.js";
import { parseCorsOrigins, isOriginAllowed } from "../../src/api/cors.js";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex; // hardhat #1 (public)
const ADDR = privateKeyToAccount(PK).address;
const td = {
  domain: { name: "AgentPad", version: "1", chainId: 31337, verifyingContract: "0x00000000000000000000000000000000000000aa" as Hex },
  types: { Ping: [{ name: "n", type: "uint256" }] },
  primaryType: "Ping" as const,
  message: { n: 7n },
};

describe("encrypted keystore signer", () => {
  it("round-trips our own v3 keystore and rejects a wrong password", () => {
    const ks = encryptKeystore(PK, "s3cret", { n: 1024 });
    expect(ks.address).toBe(ADDR.slice(2).toLowerCase());
    expect(decryptKeystore(JSON.stringify(ks), "s3cret")).toBe(PK);
    expect(() => decryptKeystore(ks, "nope")).toThrow(/wrong keystore password/);
  });

  it("decrypts an ethers v6 JSON keystore (scrypt) and a pbkdf2 keystore", async () => {
    const req = createRequire(path.resolve(__dirname, "../../../contracts/package.json"));
    const { Wallet } = req("ethers");
    const json = new Wallet(PK).encryptSync("pässwörd", { scrypt: { N: 1024 } });
    expect(decryptKeystore(json, "pässwörd")).toBe(PK);
    // pbkdf2 variant (geth `--lightkdf`-style tools): build it with node crypto
    const crypto = await import("node:crypto");
    const salt = crypto.randomBytes(32), iv = crypto.randomBytes(16);
    const dk = crypto.pbkdf2Sync("pw", salt, 1000, 32, "sha256");
    const c = crypto.createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
    const ct = Buffer.concat([c.update(Buffer.from(PK.slice(2), "hex")), c.final()]);
    const mac = keccak256(new Uint8Array(Buffer.concat([dk.subarray(16, 32), ct]))).slice(2);
    const pb = { version: 3, crypto: { cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: ct.toString("hex"), kdf: "pbkdf2", kdfparams: { c: 1000, dklen: 32, prf: "hmac-sha256", salt: salt.toString("hex") }, mac } };
    expect(decryptKeystore(JSON.stringify(pb), "pw")).toBe(PK);
  });

  it("loads from file + password file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-"));
    fs.writeFileSync(path.join(dir, "k.json"), JSON.stringify(encryptKeystore(PK, "pw", { n: 1024 })));
    fs.writeFileSync(path.join(dir, "pw"), "pw\n");
    const acct = loadKeystoreAccount({ file: path.join(dir, "k.json"), passwordFile: path.join(dir, "pw") });
    expect(acct.address).toBe(ADDR);
    expect(() => loadKeystoreAccount({ file: path.join(dir, "k.json") })).toThrow(/PASSWORD/);
  });
});

describe("production guard", () => {
  const base = { NODE_ENV: "production", ADMIN_TOKEN: "x".repeat(32), CODE_SECRET: "y".repeat(32) };
  it("refuses plaintext keys and dev secrets in production", () => {
    expect(() => loadConfig({ ...base, SIGNER_KIND: "local", SIGNER_PRIVATE_KEY: PK })).toThrow(/SIGNER_KIND=local[\s\S]*SIGNER_PRIVATE_KEY/);
    expect(() => loadConfig({ ...base, SIGNER_KIND: "keystore", RELAYER_PRIVATE_KEY: PK })).toThrow(/RELAYER_PRIVATE_KEY/);
    expect(() => loadConfig({ NODE_ENV: "production", SIGNER_KIND: "keystore" })).toThrow(/ADMIN_TOKEN[\s\S]*CODE_SECRET/);
    expect(loadConfig({ ...base, SIGNER_KIND: "keystore", SIGNER_KEYSTORE_FILE: "/k.json" }).SIGNER_KIND).toBe("keystore");
    expect(() => assertProductionSafe(loadConfig({ SIGNER_PRIVATE_KEY: PK }))).not.toThrow(); // development: allowed
  });
});

describe("KMS adapter", () => {
  // fake KMS backed by a local secp256k1 key: returns DER SPKI and DER signatures (high-s half the time)
  const priv = Buffer.from(PK.slice(2), "hex");
  const pub = secp256k1.getPublicKey(priv, false);
  const spki = new Uint8Array([...Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex"), ...pub]);
  let flip = false;
  const fake: KmsClientLike = {
    async getPublicKey() { return spki; },
    async sign(_k, digest) {
      const sig = secp256k1.sign(digest, priv, { lowS: true });
      flip = !flip;
      const s = flip ? secp256k1.CURVE.n - sig.s : sig.s; // KMS does not normalise s
      return new secp256k1.Signature(sig.r, s).toDERRawBytes();
    },
  };
  it("derives the address, signs typed data and transactions that recover to it", async () => {
    expect(addressFromSpki(spki)).toBe(ADDR);
    const der = new secp256k1.Signature(5n, 9n).toDERRawBytes();
    expect(parseDerSignature(der)).toEqual({ r: 5n, s: 9n });
    const acct = await kmsAccount(fake, "alias/agentpad");
    expect(acct.address).toBe(ADDR);
    for (let i = 0; i < 2; i++) {
      const sig = await acct.signTypedData(td as any);
      expect(await recoverTypedDataAddress({ ...(td as any), signature: sig })).toBe(ADDR);
      expect(sig).toBe(await privateKeyToAccount(PK).signTypedData(td as any)); // RFC6979 + low-s = identical
    }
    const tx = { chainId: 31337, type: "eip1559" as const, nonce: 3, to: ADDR, value: 1n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, gas: 21000n };
    const raw = await acct.signTransaction(tx);
    const parsed = parseTransaction(raw);
    const unsigned = serializeTransaction({ ...tx });
    expect(await recoverAddress({ hash: keccak256(unsigned), signature: { r: parsed.r!, s: parsed.s!, yParity: parsed.yParity! } })).toBe(ADDR);
    void hashTypedData;
  });
});

describe("CORS policy", () => {
  it("parses exact and wildcard origins", () => {
    const p = parseCorsOrigins({ CORS_ORIGINS: "https://agentpad.vercel.app, https://*.vercel.app", NODE_ENV: "production", PUBLIC_APP_URL: "x" });
    expect(isOriginAllowed("https://agentpad.vercel.app", p)).toBe(true);
    expect(isOriginAllowed("https://agentpad-git-main.vercel.app", p)).toBe(true);
    expect(isOriginAllowed("https://evil.com", p)).toBe(false);
    expect(isOriginAllowed(undefined, p)).toBe(true);
    expect(parseCorsOrigins({ CORS_ORIGINS: "", NODE_ENV: "development", PUBLIC_APP_URL: "" })).toBe("*");
    expect(parseCorsOrigins({ CORS_ORIGINS: undefined, NODE_ENV: "production", PUBLIC_APP_URL: "https://agentpad.pages.dev/" })).toEqual(["https://agentpad.pages.dev"]);
  });
});
