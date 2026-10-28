import { createHash } from "node:crypto";

/** A file to pin, with its path inside the pinned directory (e.g. "1", "collection.json", "images/cover.png"). */
export interface PinFile {
  path: string;
  content: Uint8Array | string;
  contentType?: string;
}

export interface PinResult {
  /** CID of the directory. */
  cid: string;
  /** ipfs://<cid>/  (trailing slash: ready to use as a baseURI). */
  uri: string;
}

/** Pluggable IPFS pinning provider. Implement this to use any service (Storacha, Filebase, 4everland, own node…). */
export interface PinningProvider {
  readonly name: string;
  pinDirectory(files: PinFile[], opts?: { name?: string }): Promise<PinResult>;
}

function toBlob(f: PinFile): Blob {
  const data = typeof f.content === "string" ? new TextEncoder().encode(f.content) : f.content;
  return new Blob([data as BlobPart], { type: f.contentType ?? (typeof f.content === "string" ? "application/json" : "application/octet-stream") });
}

/**
 * Pinata (https://pinata.cloud) via the pinFileToIPFS endpoint. All files are sent under one folder prefix so the
 * returned IpfsHash is the folder CID and files resolve at ipfs://<cid>/<path>.
 */
export class PinataProvider implements PinningProvider {
  readonly name = "pinata";
  constructor(private readonly opts: { jwt: string; endpoint?: string; fetch?: typeof fetch }) {
    if (!opts.jwt) throw new Error("PinataProvider: jwt required (env PINATA_JWT)");
  }
  async pinDirectory(files: PinFile[], o: { name?: string } = {}): Promise<PinResult> {
    const folder = (o.name ?? "agentpad").replace(/[^a-zA-Z0-9_-]/g, "_");
    const form = new FormData();
    for (const f of files) form.append("file", toBlob(f), `${folder}/${f.path}`);
    form.append("pinataMetadata", JSON.stringify({ name: folder }));
    form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
    const res = await (this.opts.fetch ?? fetch)(this.opts.endpoint ?? "https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.jwt}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Pinata upload failed: ${res.status} ${await res.text()}`);
    const j: any = await res.json();
    return { cid: j.IpfsHash, uri: `ipfs://${j.IpfsHash}/` };
  }
}

/**
 * Any Kubo-RPC compatible endpoint (local IPFS node, Filebase/4everland IPFS RPC, …):
 * POST {apiUrl}/api/v0/add?wrap-with-directory=true&cid-version=1&pin=true
 */
export class KuboProvider implements PinningProvider {
  readonly name = "kubo";
  constructor(private readonly opts: { apiUrl: string; headers?: Record<string, string>; fetch?: typeof fetch }) {}
  async pinDirectory(files: PinFile[]): Promise<PinResult> {
    const form = new FormData();
    for (const f of files) form.append("file", toBlob(f), f.path);
    const url = `${this.opts.apiUrl.replace(/\/+$/, "")}/api/v0/add?wrap-with-directory=true&cid-version=1&pin=true`;
    const res = await (this.opts.fetch ?? fetch)(url, { method: "POST", headers: this.opts.headers, body: form });
    if (!res.ok) throw new Error(`Kubo add failed: ${res.status} ${await res.text()}`);
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    const dir = lines.find((l) => l.Name === "") ?? lines[lines.length - 1];
    return { cid: dir.Hash, uri: `ipfs://${dir.Hash}/` };
  }
}

/** Wrap any async function as a provider (e.g. Storacha / web3.storage w3up client). */
export class CustomPinningProvider implements PinningProvider {
  constructor(readonly name: string, private readonly fn: (files: PinFile[], opts?: { name?: string }) => Promise<string>) {}
  async pinDirectory(files: PinFile[], opts?: { name?: string }): Promise<PinResult> {
    const cid = await this.fn(files, opts);
    return { cid, uri: `ipfs://${cid}/` };
  }
}

/**
 * Offline mock: deterministic pseudo-CID ("bafymock…", sha256 of the directory listing), content kept in memory.
 * Use for tests, local Hardhat runs and dry runs. Not a real IPFS CID.
 */
export class MockPinningProvider implements PinningProvider {
  readonly name = "mock";
  readonly store = new Map<string, Map<string, Uint8Array>>();
  async pinDirectory(files: PinFile[]): Promise<PinResult> {
    const h = createHash("sha256");
    const dir = new Map<string, Uint8Array>();
    for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const data = typeof f.content === "string" ? new TextEncoder().encode(f.content) : f.content;
      h.update(f.path).update("\0").update(data).update("\0");
      dir.set(f.path, data);
    }
    const cid = `bafymock${h.digest("hex").slice(0, 46)}`;
    this.store.set(cid, dir);
    return { cid, uri: `ipfs://${cid}/` };
  }
  /** Read back a pinned file: get("ipfs://<cid>/collection.json"). */
  get(uri: string): Uint8Array | undefined {
    const m = uri.replace(/^ipfs:\/\//, "").split("/");
    return this.store.get(m[0])?.get(m.slice(1).join("/"));
  }
  getJson(uri: string): any {
    const b = this.get(uri);
    return b ? JSON.parse(new TextDecoder().decode(b)) : undefined;
  }
}

/** Pick a provider from env: PINATA_JWT -> Pinata, IPFS_API_URL -> Kubo, otherwise Mock. */
export function pinningFromEnv(env: Record<string, string | undefined> = process.env): PinningProvider {
  if (env.PINATA_JWT) return new PinataProvider({ jwt: env.PINATA_JWT });
  if (env.IPFS_API_URL) return new KuboProvider({ apiUrl: env.IPFS_API_URL, headers: env.IPFS_API_AUTH ? { Authorization: env.IPFS_API_AUTH } : undefined });
  return new MockPinningProvider();
}
