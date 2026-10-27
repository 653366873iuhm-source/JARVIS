/**
 * Encrypted JSON keystore (Web3 Secret Storage v3 — the format written by ethers `Wallet.encrypt`, geth, foundry
 * `cast wallet new`, MetaMask exports). Implemented on node:crypto (scrypt / pbkdf2-sha256 + aes-128-ctr, keccak MAC)
 * so the backend needs no extra dependency.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { bytesToHex, hexToBytes, keccak256, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export interface KeystoreV3 {
  version: 3;
  id?: string;
  address?: string;
  crypto?: KeystoreCrypto;
  Crypto?: KeystoreCrypto; // ethers writes "Crypto"
}
interface KeystoreCrypto {
  cipher: string;
  cipherparams: { iv: string };
  ciphertext: string;
  kdf: "scrypt" | "pbkdf2";
  kdfparams: { dklen: number; salt: string; n?: number; r?: number; p?: number; c?: number; prf?: string };
  mac: string;
}

const strip = (h: string) => h.replace(/^0x/i, "");
const buf = (h: string) => Buffer.from(strip(h), "hex");
const pw = (p: string) => Buffer.from(p.normalize("NFKC"), "utf8"); // ethers normalises passwords with NFKC

function deriveKey(c: KeystoreCrypto, password: string): Buffer {
  const k = c.kdfparams;
  const salt = buf(k.salt);
  if (c.kdf === "scrypt") {
    const N = k.n!, r = k.r!, p = k.p!;
    return crypto.scryptSync(pw(password), salt, k.dklen, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
  }
  if (c.kdf === "pbkdf2") {
    if (k.prf && k.prf !== "hmac-sha256") throw new Error(`unsupported pbkdf2 prf ${k.prf}`);
    return crypto.pbkdf2Sync(pw(password), salt, k.c!, k.dklen, "sha256");
  }
  throw new Error(`unsupported keystore kdf ${(c as any).kdf}`);
}

const mac = (dk: Buffer, ciphertext: Buffer) => strip(keccak256(new Uint8Array(Buffer.concat([dk.subarray(16, 32), ciphertext]))));

/** Decrypts a v3 keystore; throws "wrong keystore password" on MAC mismatch. */
export function decryptKeystore(json: string | KeystoreV3, password: string): Hex {
  const ks: KeystoreV3 = typeof json === "string" ? JSON.parse(json) : json;
  if (Number(ks.version) !== 3) throw new Error(`unsupported keystore version ${ks.version}`);
  const c = ks.crypto ?? ks.Crypto;
  if (!c) throw new Error("keystore has no crypto section");
  if (c.cipher !== "aes-128-ctr") throw new Error(`unsupported keystore cipher ${c.cipher}`);
  const dk = deriveKey(c, password);
  const ct = buf(c.ciphertext);
  if (mac(dk, ct).toLowerCase() !== strip(c.mac).toLowerCase()) throw new Error("wrong keystore password (MAC mismatch)");
  const d = crypto.createDecipheriv("aes-128-ctr", dk.subarray(0, 16), buf(c.cipherparams.iv));
  const pk = Buffer.concat([d.update(ct), d.final()]);
  const key = bytesToHex(new Uint8Array(pk));
  if (ks.address) {
    const a = privateKeyToAccount(key).address.toLowerCase();
    if (strip(a) !== strip(ks.address).toLowerCase()) throw new Error(`keystore address mismatch (file ${ks.address}, key ${a})`);
  }
  return key;
}

/** Encrypts a private key into a v3 keystore (scrypt; default N=131072 like ethers/geth "standard"). */
export function encryptKeystore(privateKey: Hex, password: string, opts: { n?: number; r?: number; p?: number } = {}): KeystoreV3 {
  const n = opts.n ?? 131072, r = opts.r ?? 8, p = opts.p ?? 1;
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const c: KeystoreCrypto = {
    cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: "", kdf: "scrypt",
    kdfparams: { dklen: 32, n, r, p, salt: salt.toString("hex") }, mac: "",
  };
  const dk = deriveKey(c, password);
  const e = crypto.createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
  const ct = Buffer.concat([e.update(Buffer.from(hexToBytes(privateKey))), e.final()]);
  c.ciphertext = ct.toString("hex");
  c.mac = mac(dk, ct);
  return { version: 3, id: crypto.randomUUID(), address: strip(privateKeyToAccount(privateKey).address).toLowerCase(), crypto: c };
}

export interface KeystoreSource {
  file?: string;
  json?: string;
  password?: string;
  passwordFile?: string;
}

/** Loads + decrypts a keystore from a file or inline JSON, password from a secret file (preferred) or env. */
export function loadKeystoreAccount(src: KeystoreSource, label = "SIGNER"): PrivateKeyAccount {
  const json = src.json?.trim() ? src.json : src.file ? fs.readFileSync(src.file, "utf8") : null;
  if (!json) throw new Error(`${label}_KEYSTORE_FILE or ${label}_KEYSTORE_JSON required for keystore signer`);
  const password = src.passwordFile ? fs.readFileSync(src.passwordFile, "utf8").replace(/\r?\n$/, "") : src.password;
  if (password === undefined || password === "") throw new Error(`${label}_KEYSTORE_PASSWORD_FILE or ${label}_KEYSTORE_PASSWORD required for keystore signer`);
  return privateKeyToAccount(decryptKeystore(json, password));
}
