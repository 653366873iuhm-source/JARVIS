/**
 * Create an encrypted JSON keystore (v3, scrypt N=131072) for the platform signer / relayer.
 *   npx tsx scripts/make-keystore.ts --out ./secrets/signer-keystore.json            # new random key
 *   npx tsx scripts/make-keystore.ts --out k.json --import < key.txt                 # encrypt an existing key (stdin)
 * Password: KEYSTORE_PASSWORD env or --password-file <file>. Prints only the address — never the key.
 */
import fs from "node:fs";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { encryptKeystore } from "../src/signer/keystore.js";

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = opt("--out");
if (!out) throw new Error("--out <file> required");
const pwFile = opt("--password-file");
const password = pwFile ? fs.readFileSync(pwFile, "utf8").replace(/\r?\n$/, "") : process.env.KEYSTORE_PASSWORD;
if (!password || password.length < 12) throw new Error("password (KEYSTORE_PASSWORD or --password-file) of at least 12 chars required");
let key: Hex;
if (args.includes("--import")) {
  const raw = fs.readFileSync(0, "utf8").trim();
  key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("stdin is not a 32-byte hex private key");
} else {
  key = generatePrivateKey();
}
const ks = encryptKeystore(key, password);
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify(ks), { mode: 0o600 });
console.log(JSON.stringify({ address: privateKeyToAccount(key).address, keystore: path.resolve(out) }));
