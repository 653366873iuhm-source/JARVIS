import crypto from "node:crypto";
import { getAddress, keccak256, toBytes, type Address } from "viem";

export const lc = (a: string) => a.toLowerCase();
export const nowSec = () => Math.floor(Date.now() / 1000);
export const uuid = () => crypto.randomUUID();
export const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
export const checksum = (a: string) => getAddress(a) as Address;

/** JSON with bigint -> decimal string. */
export function jsonStringify(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}

const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export function base32(buf: Buffer, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += B32[buf[i % buf.length]! % 32];
  return out;
}
export function randomCode(len = 8): string {
  return base32(crypto.randomBytes(len), len);
}
export function hmacCode(secret: string, parts: string[], len = 8): string {
  const h = crypto.createHmac("sha256", secret).update(parts.join("|")).digest();
  return base32(h, len);
}

/** X handle normalisation: lowercase, strip leading @. */
export function normHandle(h: string): string {
  return h.trim().replace(/^@/, "").toLowerCase();
}
/** On-chain xHandleHash = keccak256(utf8(lowercased handle without "@")). */
export function handleHash(h: string): `0x${string}` {
  return keccak256(toBytes(normHandle(h)));
}
export function agentIdHash(id: string): `0x${string}` {
  return keccak256(toBytes(id));
}
export function normAgentId(id: string): string {
  return id.trim().toLowerCase();
}

/** Extract tweet id from https://x.com/<user>/status/<id> or a bare id. */
export function parseTweetId(urlOrId: string): string | null {
  const s = urlOrId.trim();
  if (/^\d{5,25}$/.test(s)) return s;
  const m = s.match(/(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d{5,25})/i);
  return m ? m[1]! : null;
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
