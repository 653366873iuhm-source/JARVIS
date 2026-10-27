/**
 * AWS KMS signer adapter (optional). The key must be ECC_SECG_P256K1 / SIGN_VERIFY; IAM needs only kms:GetPublicKey
 * and kms:Sign. The AWS SDK is NOT a hard dependency: install `@aws-sdk/client-kms` in the image to enable it
 * (it is loaded with a dynamic import), or inject any {@link KmsClientLike} (other HSMs, tests).
 *
 *   getAddress    GetPublicKey -> DER SubjectPublicKeyInfo -> uncompressed point -> keccak256(point[1:])[12:]
 *   sign(digest)  Sign(MessageType=DIGEST, ECDSA_SHA_256) -> DER (r,s) -> low-s -> recovery id by recoverAddress
 *   tx            viem serializeTransaction -> keccak256 -> sign -> serializeTransaction(tx, sig)
 */
import { keccak256, recoverAddress, serializeSignature, serializeTransaction, hashTypedData, hashMessage, bytesToHex, getAddress, type Address, type Hex } from "viem";
import { toAccount, type LocalAccount } from "viem/accounts";

export interface KmsClientLike {
  /** DER-encoded SubjectPublicKeyInfo of the key. */
  getPublicKey(keyId: string): Promise<Uint8Array>;
  /** DER-encoded ECDSA signature of a 32-byte digest. */
  sign(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
}

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The last 65 bytes of a secp256k1 SPKI are the uncompressed point 0x04||X||Y. */
export function addressFromSpki(spki: Uint8Array): Address {
  const point = spki.slice(spki.length - 65);
  if (point[0] !== 0x04) throw new Error("KMS public key is not an uncompressed secp256k1 point");
  return getAddress(`0x${keccak256(point.slice(1)).slice(-40)}`);
}

/** Parses a DER ECDSA signature SEQUENCE { INTEGER r, INTEGER s }. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error("bad DER signature");
  let len = der[i++];
  if (len & 0x80) i += len & 0x7f;
  const int = () => {
    if (der[i++] !== 0x02) throw new Error("bad DER integer");
    const l = der[i++];
    const v = BigInt(bytesToHex(der.slice(i, i + l)));
    i += l;
    return v;
  };
  const r = int();
  const s = int();
  return { r, s };
}

export async function kmsSignDigest(client: KmsClientLike, keyId: string, address: Address, digest: Hex): Promise<{ r: Hex; s: Hex; yParity: 0 | 1 }> {
  const der = await client.sign(keyId, Buffer.from(digest.slice(2), "hex"));
  let { r, s } = parseDerSignature(der);
  if (s > N / 2n) s = N - s; // EIP-2: low-s
  const rh = `0x${r.toString(16).padStart(64, "0")}` as Hex;
  const sh = `0x${s.toString(16).padStart(64, "0")}` as Hex;
  for (const yParity of [0, 1] as const) {
    const rec = await recoverAddress({ hash: digest, signature: serializeSignature({ r: rh, s: sh, yParity }) });
    if (rec.toLowerCase() === address.toLowerCase()) return { r: rh, s: sh, yParity };
  }
  throw new Error("KMS signature does not recover to the key address");
}

/** viem LocalAccount whose signatures come from KMS (usable with walletClient.sendTransaction). */
export async function kmsAccount(client: KmsClientLike, keyId: string): Promise<LocalAccount> {
  const address = addressFromSpki(await client.getPublicKey(keyId));
  const sig = async (digest: Hex) => serializeSignature(await kmsSignDigest(client, keyId, address, digest));
  return toAccount({
    address,
    async signMessage({ message }) {
      return sig(hashMessage(message));
    },
    async signTypedData(td) {
      return sig(hashTypedData(td as any));
    },
    async signTransaction(tx, opts) {
      const serializer = opts?.serializer ?? serializeTransaction;
      const s = await kmsSignDigest(client, keyId, address, keccak256(await serializer(tx)));
      return serializer(tx, s) as any;
    },
  });
}

/** AWS SDK v3 adapter, loaded lazily (the package is optional). */
export async function awsKmsClient(region?: string): Promise<KmsClientLike> {
  const pkg = "@aws-sdk/client-kms";
  let mod: any;
  try {
    mod = await import(/* @vite-ignore */ pkg);
  } catch {
    throw new Error("SIGNER_KIND=kms needs the optional dependency @aws-sdk/client-kms (npm i @aws-sdk/client-kms)");
  }
  const kms = new mod.KMSClient(region ? { region } : {});
  return {
    async getPublicKey(keyId) {
      const r = await kms.send(new mod.GetPublicKeyCommand({ KeyId: keyId }));
      if (r.KeySpec && r.KeySpec !== "ECC_SECG_P256K1") throw new Error(`KMS key ${keyId} has spec ${r.KeySpec}, need ECC_SECG_P256K1`);
      return new Uint8Array(r.PublicKey);
    },
    async sign(keyId, digest) {
      const r = await kms.send(new mod.SignCommand({ KeyId: keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }));
      return new Uint8Array(r.Signature);
    },
  };
}
