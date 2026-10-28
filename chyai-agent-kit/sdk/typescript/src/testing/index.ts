/**
 * Testing / local-dev utilities: platform-signer helpers (simulate the backend's EIP-712 signatures) and an
 * in-process mock of the AgentPad backend API (sdk/API_CONTRACT.md). Never use the mock signer key in production.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createPublicClient, getAddress, http, verifyTypedData, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { AgentRegistryAbi, BondingNFTAbi, LaunchFactoryAbi } from "../abi/index.js";
import { agentBindingTypedData, eligibilityPostsTypedData, type RegisterRequestBody } from "../api.js";
import { MAX_CURVE_NFTS } from "../constants.js";
import { quoteBurn, quoteMint } from "../curve.js";
import { promoterTree, rewardTree } from "../merkle.js";
import { normaliseXHandle, xHandleHash } from "../client.js";

export { promoterTree, rewardTree, SimpleMerkleTree, standardLeaf } from "../merkle.js";

export async function signRegistration(
  signer: PrivateKeyAccount,
  p: { chainId: number; registry: Address; agentId: string; wallet: Address; xHandle: string; canLaunch?: boolean; canTrade?: boolean; expiry: bigint; nonce: bigint; deadline: bigint },
) {
  const value = {
    agentId: p.agentId,
    wallet: getAddress(p.wallet),
    xHandleHash: xHandleHash(p.xHandle),
    canLaunch: p.canLaunch ?? true,
    canTrade: p.canTrade ?? true,
    expiry: p.expiry,
    nonce: p.nonce,
    deadline: p.deadline,
  };
  const signature = await signer.signTypedData({
    domain: { name: "AgentPadRegistry", version: "1", chainId: p.chainId, verifyingContract: p.registry },
    types: {
      Register: [
        { name: "agentId", type: "string" },
        { name: "wallet", type: "address" },
        { name: "xHandleHash", type: "bytes32" },
        { name: "canLaunch", type: "bool" },
        { name: "canTrade", type: "bool" },
        { name: "expiry", type: "uint64" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Register",
    message: value,
  });
  return { ...value, signature };
}

export async function signPromotion(signer: PrivateKeyAccount, p: { chainId: number; registry: Address; project: Address; shareBps: number; promoterRoot: Hex; nonce: bigint; deadline: bigint }): Promise<Hex> {
  return signer.signTypedData({
    domain: { name: "AgentPadRegistry", version: "1", chainId: p.chainId, verifyingContract: p.registry },
    types: {
      Promotion: [
        { name: "project", type: "address" },
        { name: "shareBps", type: "uint16" },
        { name: "promoterRoot", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Promotion",
    message: { project: p.project, shareBps: p.shareBps, promoterRoot: p.promoterRoot, nonce: p.nonce, deadline: p.deadline },
  });
}

export interface MockBackendOptions {
  rpcUrl: string;
  chainId: number;
  registry: Address;
  factory: Address;
  rewardPool: Address;
  platformSignerKey: Hex;
  /** Require an X proof URL before approving (default false = auto-approve after the wallet signature checks out). */
  requireXProof?: boolean;
  registrationTtlSeconds?: number;
  port?: number;
}

interface RegState {
  requestId: string;
  agentId: string;
  wallet: Address;
  xHandle: string;
  intent: "launch" | "trade";
  status: "awaiting_wallet_signature" | "awaiting_x_proof" | "verifying" | "approved" | "rejected";
  code: string;
  challenge: string;
  issuedAt: number;
  expiresAt: number;
  walletVerified: boolean;
  reason?: string;
  tweetUrl?: string;
}

/**
 * In-process mock of the AgentPad backend. Implements every endpoint in API_CONTRACT.md against the chain,
 * with the platform signer key held locally. Extra test hooks: setPromoters(), postRewards() data, reject().
 */
export class MockBackend {
  server?: Server;
  url = "";
  readonly signer: PrivateKeyAccount;
  readonly pc: PublicClient;
  readonly regs = new Map<string, RegState>();
  readonly promoters = new Map<string, { root: Hex; proofs: Map<string, Hex[]> }>();
  readonly rewards = new Map<string, { epoch: bigint; amount: bigint; proof: Hex[] }[]>();
  readonly codes = new Map<string, string>();
  /** Promotion post URLs submitted via POST /promotions/submit (project|wallet -> urls). Not verified against X. */
  readonly promoSubmissions = new Map<string, string[]>();
  /** Eligibility post URLs: from register-request (eligibilityPostUrls) and POST /agents/eligibility-posts, by wallet. */
  readonly eligibilityPosts = new Map<string, string[]>();
  readonly requests: { method: string; path: string; body?: unknown }[] = [];
  /** Optional hook to look up time (tests that warp the chain should use chain time). */
  now: () => Promise<number>;

  constructor(readonly o: MockBackendOptions) {
    this.signer = privateKeyToAccount(o.platformSignerKey);
    this.pc = createPublicClient({ transport: http(o.rpcUrl) });
    this.now = async () => Number((await this.pc.getBlock()).timestamp);
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res).catch((e) => this.json(res, 500, { error: { code: "internal", message: String(e?.message ?? e) } })));
    await new Promise<void>((r) => this.server!.listen(this.o.port ?? 0, "127.0.0.1", () => r()));
    const addr = this.server.address() as any;
    this.url = `http://127.0.0.1:${addr.port}`;
    return this.url;
  }

  async stop() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** Build the promoter tree for a project; returns the root to attest. */
  setPromoters(project: Address, addresses: Address[]): Hex {
    const t = promoterTree(addresses);
    const proofs = new Map<string, Hex[]>();
    for (const a of addresses) proofs.set(getAddress(a), t.proofOf(a));
    this.promoters.set(getAddress(project), { root: t.root, proofs });
    return t.root;
  }

  /** Build a reward epoch; returns { root, total } for RewardPool.postRoot. */
  setRewards(epoch: bigint, entries: { account: Address; amount: bigint }[]) {
    const t = rewardTree(epoch, entries);
    for (const e of entries) {
      const k = getAddress(e.account);
      const list = this.rewards.get(k) ?? [];
      list.push({ epoch, amount: e.amount, proof: t.proofOf(e) });
      this.rewards.set(k, list);
    }
    return { root: t.root, total: t.total };
  }

  reject(agentId: string, reason: string) {
    for (const r of this.regs.values()) if (r.agentId === agentId) Object.assign(r, { status: "rejected", reason });
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  }

  private async body(req: IncomingMessage): Promise<any> {
    let s = "";
    for await (const c of req) s += c;
    return s ? JSON.parse(s) : undefined;
  }

  private async projectSummary(addr: Address) {
    const r = (fn: string, args: any[] = []) => this.pc.readContract({ address: addr, abi: BondingNFTAbi, functionName: fn as any, args } as any) as Promise<any>;
    const [token, name, symbol, launcher, phase, stage, totalSupply, vb, vt, reserve, feeBps, launchTime, spot, pair] = await Promise.all(
      ["token", "name", "symbol", "launcher", "phase", "promotionStage", "totalSupply", "virtualBnb", "virtualToken", "reserveBnb", "feeBps", "launchTime", "spotPrice", "pair"].map((f) => r(f)),
    );
    const logs = await this.pc.getContractEvents({ address: this.o.factory, abi: LaunchFactoryAbi, eventName: "Launched", args: { project: addr }, fromBlock: 0n });
    const l: any = logs[0];
    return {
      address: getAddress(addr), token, launcher, launcherAgentId: null, name, symbol, baseURI: l?.args.baseURI ?? "", index: Number(l?.args.index ?? 0),
      launchedAt: Number(launchTime), launchBlock: String(l?.blockNumber ?? 0n), launchTx: l?.transactionHash ?? null,
      phase: ["trading", "promotion", "graduated"][Number(phase)], promotionStage: Number(stage), totalSupply: String(totalSupply), virtualBnb: String(vb),
      virtualToken: String(vt), reserveBnb: String(reserve), feeBps: Number(feeBps), spotPriceWei: String(spot), progressBps: Number((totalSupply * 10_000n) / MAX_CURVE_NFTS),
      holders: 0, volumeBnb24h: "0", pair: pair === "0x0000000000000000000000000000000000000000" ? null : pair, story: null, image: null, collectionUri: l ? `${l.args.baseURI}collection.json` : null,
      promotionStart: null, graduatedAt: null, updatedAt: Math.floor(Date.now() / 1000),
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    const body = req.method === "POST" ? await this.body(req) : undefined;
    this.requests.push({ method: req.method ?? "", path: url.pathname + url.search, body });

    // POST /agents/register-request
    if (req.method === "POST" && url.pathname === "/agents/register-request") {
      const b = body as RegisterRequestBody;
      if (!b?.agentId?.endsWith(".ai")) return this.json(res, 400, { error: { code: "invalid_agent_id", message: "agentId must be a .ai Agent ID" } });
      if (b.chainId !== this.o.chainId) return this.json(res, 400, { error: { code: "wrong_chain", message: "chainId mismatch" } });
      const now = Math.floor(Date.now() / 1000);
      const key = `${b.agentId}|${getAddress(b.wallet)}`;
      let r = this.regs.get(key);
      if (!r) {
        r = {
          requestId: `req_${this.regs.size + 1}`, agentId: b.agentId, wallet: getAddress(b.wallet), xHandle: normaliseXHandle(b.xHandle), intent: b.intent ?? "launch",
          status: "awaiting_wallet_signature", code: `AP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          challenge: `agentpad-${Math.random().toString(36).slice(2, 12)}`, issuedAt: now, expiresAt: now + 900, walletVerified: false,
        };
        this.regs.set(key, r);
      }
      if (r.expiresAt < now) Object.assign(r, { challenge: `agentpad-${Math.random().toString(36).slice(2, 12)}`, issuedAt: now, expiresAt: now + 900 });
      if (b.walletSignature) {
        if (b.challenge !== r.challenge) return this.json(res, 400, { error: { code: "bad_challenge", message: "unknown or expired challenge" } });
        const td = agentBindingTypedData({ chainId: b.chainId, registry: this.o.registry, agentId: b.agentId, wallet: r.wallet, xHandle: r.xHandle, intent: r.intent, challenge: r.challenge, issuedAt: r.issuedAt, expiresAt: r.expiresAt });
        const ok = await verifyTypedData({ address: r.wallet, signature: b.walletSignature, ...(td as any) }).catch(() => false);
        if (!ok) return this.json(res, 401, { error: { code: "bad_wallet_signature", message: "wallet signature does not match" } });
        r.walletVerified = true;
        if (r.status === "awaiting_wallet_signature") r.status = "awaiting_x_proof";
      }
      if (b.xProofTweetUrl && r.walletVerified) r.tweetUrl = b.xProofTweetUrl;
      if (b.eligibilityPostUrls?.length && r.walletVerified) this.eligibilityPosts.set(r.wallet, b.eligibilityPostUrls);
      if (r.walletVerified && r.status !== "rejected" && (!this.o.requireXProof || r.tweetUrl)) r.status = "approved";
      return this.json(res, 200, {
        requestId: r.requestId, agentId: r.agentId, wallet: r.wallet, xHandle: r.xHandle, intent: r.intent, status: r.status,
        binding: { challenge: r.challenge, issuedAt: r.issuedAt, expiresAt: r.expiresAt },
        xChallenge: { code: r.code, text: `Verifying my agent ${r.agentId} on @AgentPad: ${r.code}`, expiresAt: now + 3600 }, reason: r.reason ?? null,
      });
    }

    // GET /agents/:agentId/registration-signature?wallet=
    if (req.method === "GET" && parts[0] === "agents" && parts[2] === "registration-signature") {
      const agentId = decodeURIComponent(parts[1]);
      const wallet = url.searchParams.get("wallet");
      const r = [...this.regs.values()].find((x) => x.agentId === agentId && (!wallet || x.wallet === getAddress(wallet)));
      if (!r) return this.json(res, 404, { error: { code: "not_found", message: "no registration request" } });
      if (r.status === "rejected") return this.json(res, 403, { status: "rejected", reason: r.reason ?? "rejected" });
      if (r.status !== "approved") return this.json(res, 202, { status: "pending", requestStatus: r.status, retryAfter: 1 });
      const nonce = (await this.pc.readContract({ address: this.o.registry, abi: AgentRegistryAbi, functionName: "nonces", args: [r.wallet] })) as bigint;
      const chainNow = BigInt(await this.now());
      const s = await signRegistration(this.signer, {
        chainId: this.o.chainId, registry: this.o.registry, agentId: r.agentId, wallet: r.wallet, xHandle: r.xHandle,
        canLaunch: r.intent === "launch", canTrade: true,
        expiry: chainNow + BigInt(this.o.registrationTtlSeconds ?? 30 * 86_400), nonce, deadline: chainNow + 3600n,
      });
      return this.json(res, 200, { status: "ready", chainId: this.o.chainId, registry: this.o.registry, ...s });
    }

    // GET /projects
    if (req.method === "GET" && url.pathname === "/projects") {
      const n = (await this.pc.readContract({ address: this.o.factory, abi: LaunchFactoryAbi, functionName: "projectCount" })) as bigint;
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const phase = url.searchParams.get("phase");
      const items: any[] = [];
      for (let i = n; i > 0n && items.length < limit; i--) {
        const addr = (await this.pc.readContract({ address: this.o.factory, abi: LaunchFactoryAbi, functionName: "allProjects", args: [i - 1n] })) as Address;
        const s = await this.projectSummary(addr);
        if (!phase || s.phase === phase) items.push(s);
      }
      return this.json(res, 200, { items, nextCursor: null });
    }

    // GET /projects/:addr[/quote]
    if (req.method === "GET" && parts[0] === "projects" && parts[1]) {
      const addr = getAddress(parts[1]);
      const isProject = await this.pc.readContract({ address: this.o.factory, abi: LaunchFactoryAbi, functionName: "isProject", args: [addr] });
      if (!isProject) return this.json(res, 404, { error: { code: "not_found", message: "unknown project" } });
      if (parts[2] === "quote") {
        const side = url.searchParams.get("side");
        const count = Number(url.searchParams.get("count"));
        const blockNumber = await this.pc.getBlockNumber({ cacheTime: 0 });
        const r = (fn: string) => this.pc.readContract({ address: addr, abi: BondingNFTAbi, functionName: fn as any, blockNumber } as any) as Promise<any>;
        const [vb, vt, ts, fee] = await Promise.all([r("virtualBnb"), r("virtualToken"), r("totalSupply"), r("feeBps")]);
        const st = { virtualBnb: vb, virtualToken: vt, totalSupply: ts, feeBps: BigInt(fee) };
        try {
          const q = side === "burn" ? quoteBurn(st, count) : quoteMint(st, count);
          const amount = "cost" in q ? q.cost : q.gross;
          const total = "total" in q ? q.total : q.net;
          return this.json(res, 200, { project: addr, side, count, amount: String(amount), fee: String(q.fee), total: String(total), blockNumber: String(blockNumber), state: { virtualBnb: String(vb), virtualToken: String(vt), totalSupply: String(ts), feeBps: Number(fee) } });
        } catch (e: any) {
          return this.json(res, 400, { error: { code: "bad_amount", message: e.message } });
        }
      }
      const s = await this.projectSummary(addr);
      return this.json(res, 200, { ...s, launcherHoldings: 0, firstPostGradId: null, promotion: null, topHolders: [], recentTrades: [] });
    }

    // GET /rewards/:wallet/proof
    if (req.method === "GET" && parts[0] === "rewards" && parts[2] === "proof") {
      const w = getAddress(parts[1]);
      const promoterExemptions = [...this.promoters.entries()].filter(([, v]) => v.proofs.has(w)).map(([project, v]) => ({ project, root: v.root, proof: v.proofs.get(w)!, claimed: false }));
      const rewards = (this.rewards.get(w) ?? []).map((r) => ({ epoch: String(r.epoch), amount: String(r.amount), proof: r.proof, claimed: false, rewardPool: this.o.rewardPool }));
      return this.json(res, 200, { wallet: w, rewards, promoterExemptions });
    }

    // POST /promotions/code
    if (req.method === "POST" && url.pathname === "/promotions/code") {
      const project = getAddress(body.project);
      const wallet = getAddress(body.wallet);
      const canTrade = await this.pc.readContract({ address: this.o.registry, abi: AgentRegistryAbi, functionName: "canTrade", args: [wallet] });
      if (!canTrade) return this.json(res, 403, { error: { code: "not_registered", message: "wallet is not a registered agent" } });
      const bal = (await this.pc.readContract({ address: project, abi: BondingNFTAbi, functionName: "balanceOf", args: [wallet] })) as bigint;
      if (bal === 0n) return this.json(res, 403, { error: { code: "not_holder", message: "wallet holds no NFTs of this project" } });
      const key = `${project}|${wallet}`;
      const code = this.codes.get(key) ?? `AP${this.codes.size + 1}${wallet.slice(2, 6).toUpperCase()}`;
      this.codes.set(key, code);
      const symbol = await this.pc.readContract({ address: project, abi: BondingNFTAbi, functionName: "symbol" });
      const now = Math.floor(Date.now() / 1000);
      return this.json(res, 200, {
        project, wallet, code, tag: "#AgentPad", cashtag: `$${symbol}`, link: `https://agentpad.example/#/project/${project}?ref=${code}`,
        requiredText: ["#AgentPad", code],
        rules: ["one original post per agent per project", "include #AgentPad and your code", "no profit promises or price predictions", "write your own text — no copy-paste"],
        window: null, expiresAt: now + 86_400,
      });
    }

    // POST /promotions/submit (shape-only: the real backend verifies author/tag/code through FxTwitter)
    if (req.method === "POST" && url.pathname === "/promotions/submit") {
      const project = getAddress(body.project);
      const wallet = getAddress(body.wallet);
      const m = String(body.url ?? "").match(/(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d{5,25})/i) ?? String(body.url ?? "").match(/^(\d{5,25})$/);
      if (!m) return this.json(res, 400, { error: { code: "bad_tweet_url", message: "not an X post URL" } });
      const key = `${project}|${wallet}`;
      this.promoSubmissions.set(key, [...(this.promoSubmissions.get(key) ?? []), body.url]);
      return this.json(res, 200, {
        tweetId: m[1], url: body.url, project, wallet, kind: "original", status: "stored", similarTo: null, shareBps: null,
        metrics: { likes: 0, reposts: 0, replies: 0, quotes: 0 },
      });
    }

    // POST /agents/eligibility-posts
    if (req.method === "POST" && url.pathname === "/agents/eligibility-posts") {
      const wallet = getAddress(body.wallet);
      const td = eligibilityPostsTypedData({ chainId: this.o.chainId, registry: this.o.registry, wallet, postUrls: body.postUrls, issuedAt: body.issuedAt });
      const ok = await verifyTypedData({ address: wallet, signature: body.signature, ...(td as any) }).catch(() => false);
      if (!ok) return this.json(res, 401, { error: { code: "bad_signature", message: "signature does not match EligibilityPosts" } });
      this.eligibilityPosts.set(wallet, body.postUrls);
      const n = body.postUrls.length;
      return this.json(res, 200, {
        wallet, launchEnabled: true, requalified: n >= 10,
        eligibility: { eligible: n >= 10, followers: 0, accountAgeDays: 0, posts30d: n, engagementBps: 0, reasons: n >= 10 ? [] : ["fewer than 10 posts"], checkedAt: Math.floor(Date.now() / 1000) },
      });
    }

    return this.json(res, 404, { error: { code: "not_found", message: `${req.method} ${url.pathname}` } });
  }
}
