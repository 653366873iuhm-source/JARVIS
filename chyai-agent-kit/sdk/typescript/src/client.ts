import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseEventLogs,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { AgentRegistryAbi, AgentTokenAbi, BondingNFTAbi, FeeSplitterAbi, LaunchFactoryAbi, RewardPoolAbi } from "./abi/index.js";
import { AgentPadApi, agentBindingTypedData, eligibilityPostsTypedData, type EligibilityPostsResponse, type PromotionSubmitResponse, type RegisterIntent, type ListProjectsParams, type ProjectDetail, type ProjectSummary, type PromotionCodeResponse, type RegisterRequestResponse, type RegistrationSignatureReady, type XChallenge } from "./api.js";
import {
  ANTI_SNIPE_DURATION,
  ANTI_SNIPE_MAX_PER_TX,
  ANTI_SNIPE_MAX_PER_WALLET,
  DEFAULT_SLIPPAGE_BPS,
  DEPLOYMENTS,
  LAUNCHER_MAX_NFTS,
  MAX_CURVE_NFTS,
  MAX_PER_TX,
  Phase,
  PromotionStage,
  TOKENS_PER_NFT,
  type Deployment,
} from "./constants.js";
import { quoteBurn as curveQuoteBurn, quoteMint as curveQuoteMint, withSlippageDown, withSlippageUp, type BurnQuote, type CurveState, type MintQuote } from "./curve.js";
import { AgentPadError, decodeAgentPadError } from "./errors.js";
import { uploadLaunchAssets, type LaunchAssets, type LaunchAssetsInput } from "./metadata.js";
import type { PinningProvider } from "./pinning.js";
import type { AgentSigner, TxRequest } from "./signers/types.js";

export interface AgentPadOptions {
  publicClient: PublicClient;
  /** Required for write calls. */
  signer?: AgentSigner;
  /** Contract addresses; defaults to DEPLOYMENTS[chainId]. */
  deployment?: Deployment;
  /** Backend API client or base URL. Needed for register(), promotion codes, reward proofs and listProjects(). */
  api?: AgentPadApi | string;
  /** Default slippage in bps (default 50 = 0.5%). */
  slippageBps?: bigint;
  /** Max block range per eth_getLogs call (default 5,000 — public BSC RPC limit). */
  logChunkSize?: bigint;
  /** eth_call the transaction before sending to surface decoded custom errors (default true). */
  simulate?: boolean;
  /** Receipt confirmations to wait for (default 1). */
  confirmations?: number;
}

export interface AgentStatus {
  wallet: Address;
  registered: boolean;
  agentIdHash: Hex;
  xHandleHash: Hex;
  expiry: bigint;
  canLaunch: boolean;
  canTrade: boolean;
}

export interface ProjectInfo {
  address: Address;
  token: Address;
  name: string;
  symbol: string;
  launcher: Address;
  phase: Phase;
  promotionStage: PromotionStage;
  totalSupply: bigint;
  remaining: bigint;
  nextTokenId: bigint;
  virtualBnb: bigint;
  virtualToken: bigint;
  reserveBnb: bigint;
  feeBps: bigint;
  launchTime: bigint;
  antiSnipeEndsAt: bigint;
  promotionStart: bigint;
  graduatedAt: bigint;
  firstPostGradId: bigint;
  pair: Address;
  promoterRoot: Hex;
  attestationNonce: bigint;
  spotPrice: bigint;
  graduationFee: bigint;
  blockNumber: bigint;
  /** Backend extras (story, image, holders…) when an API is configured and reachable. */
  api?: ProjectDetail;
}

export interface TxResult {
  hash: Hex;
  receipt: TransactionReceipt;
}

export interface MintResult extends TxResult {
  tokenIds: bigint[];
  cost: bigint;
  fee: bigint;
  quote: MintQuote;
}

export interface BurnResult extends TxResult {
  tokenIds: bigint[];
  gross: bigint;
  fee: bigint;
  net: bigint;
  quote: BurnQuote;
}

export interface LaunchResult extends TxResult {
  project: Address;
  token: Address;
  index: bigint;
  baseURI: string;
  assets?: LaunchAssets;
}

export interface RegisterOptions {
  agentId: string;
  xHandle: string;
  /** "launch" (default; needs the X follower/age/engagement bar) or "trade" (trading only). */
  intent?: RegisterIntent;
  /** URL of the X post containing the challenge text, if already posted. */
  xProofTweetUrl?: string;
  /**
   * intent=launch: >= 10 of the agent's own X post URLs from the last 30 days. The backend looks each one up
   * (author, date, likes/retweets/replies) — it never searches X — and averages engagement over them.
   */
  eligibilityPostUrls?: string[];
  /**
   * Called when the backend wants the X verification post. Post `challenge.text` from the agent's X account and
   * return the post URL. The backend never searches X, so a URL is required (returning undefined ends with an error).
   */
  onChallenge?: (challenge: XChallenge) => Promise<string | undefined>;
  /** Poll timeout for the registration signature (default 10 min). */
  timeoutMs?: number;
  pollMs?: number;
  /** Skip if already registered with canTrade and expiry further away than this many seconds (default 3 days). */
  minRemainingSeconds?: number;
}

export interface RewardClaim {
  epoch: bigint;
  amount: bigint;
  hash?: Hex;
  skipped?: "already_claimed";
}

/** xHandleHash = keccak256(lowercased handle without leading "@"). Must match what the backend signs. */
export function xHandleHash(handle: string): Hex {
  return keccak256(toBytes(normaliseXHandle(handle)));
}

export function normaliseXHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

export function agentIdHash(agentId: string): Hex {
  return keccak256(toBytes(agentId));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * High-level AgentPad client. Reads go through `publicClient`; writes go through the pluggable `signer`
 * (ViemSigner or BawSigner). Every write returns the tx hash + receipt and decoded results.
 */
export class AgentPad {
  readonly publicClient: PublicClient;
  readonly signer?: AgentSigner;
  readonly api?: AgentPadApi;
  readonly slippageBps: bigint;
  readonly logChunkSize: bigint;
  private readonly simulateFirst: boolean;
  private readonly confirmations: number;
  private _deployment?: Deployment;

  constructor(opts: AgentPadOptions) {
    this.publicClient = opts.publicClient;
    this.signer = opts.signer;
    this.api = typeof opts.api === "string" ? new AgentPadApi({ baseUrl: opts.api }) : opts.api;
    this.slippageBps = opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    this.logChunkSize = opts.logChunkSize ?? 5_000n;
    this.simulateFirst = opts.simulate ?? true;
    this.confirmations = opts.confirmations ?? 1;
    this._deployment = opts.deployment;
  }

  // ------------------------------------------------------------------ basics

  async deployment(): Promise<Deployment> {
    if (this._deployment) return this._deployment;
    const chainId = await this.publicClient.getChainId();
    const d = DEPLOYMENTS[chainId];
    if (!d) throw new Error(`no AgentPad deployment known for chain ${chainId}; pass options.deployment`);
    this._deployment = d;
    return d;
  }

  private requireSigner(): AgentSigner {
    if (!this.signer) throw new Error("this call needs a signer (ViemSigner or BawSigner)");
    return this.signer;
  }

  private requireApi(): AgentPadApi {
    if (!this.api) throw new Error("this call needs the AgentPad API (options.api)");
    return this.api;
  }

  async address(): Promise<Address> {
    return this.requireSigner().getAddress();
  }

  /** Simulate (eth_call from the agent wallet), send through the signer, wait for the receipt. */
  async send(tx: TxRequest): Promise<TxResult> {
    const signer = this.requireSigner();
    const from = await signer.getAddress();
    if (this.simulateFirst) {
      try {
        await this.publicClient.call({ account: from, to: tx.to, data: tx.data, value: tx.value ?? 0n });
      } catch (e) {
        throw decodeAgentPadError(e) ?? e;
      }
    }
    let hash: Hex;
    try {
      hash = await signer.sendTransaction(tx);
    } catch (e) {
      throw decodeAgentPadError(e) ?? e;
    }
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: this.confirmations });
    if (receipt.status !== "success") {
      // Re-run as eth_call at the parent block to recover the revert reason.
      try {
        await this.publicClient.call({ account: from, to: tx.to, data: tx.data, value: tx.value ?? 0n, blockNumber: receipt.blockNumber - 1n });
      } catch (e) {
        throw decodeAgentPadError(e) ?? e;
      }
      throw new Error(`transaction ${hash} reverted`);
    }
    return { hash, receipt };
  }

  /** Build the raw transaction for any SDK action without sending (for external signers / `baw contract-call`). */
  encode = {
    register: (s: RegistrationSignatureReady, registry: Address): TxRequest => ({
      to: registry,
      data: encodeFunctionData({
        abi: AgentRegistryAbi,
        functionName: "register",
        args: [s.agentId, s.wallet, s.xHandleHash, s.canLaunch, s.canTrade, BigInt(s.expiry), BigInt(s.deadline), s.signature],
      }),
      description: `AgentRegistry.register(${s.agentId})`,
    }),
    launch: (factory: Address, name: string, symbol: string, baseURI: string): TxRequest => ({
      to: factory,
      data: encodeFunctionData({ abi: LaunchFactoryAbi, functionName: "launch", args: [name, symbol, baseURI] }),
      description: `LaunchFactory.launch(${name}, ${symbol})`,
    }),
    mint: (project: Address, count: bigint, value: bigint): TxRequest => ({
      to: project,
      data: encodeFunctionData({ abi: BondingNFTAbi, functionName: "mint", args: [count] }),
      value,
      description: `mint ${count} NFT(s), max spend ${value} wei`,
    }),
    /** BondingNFT v2 `sell` — the recommended exit; passes Binance Agentic Wallet previews (no outgoing NFT log). */
    sell: (project: Address, tokenIds: bigint[], minOut: bigint): TxRequest => ({
      to: project,
      data: encodeFunctionData({ abi: BondingNFTAbi, functionName: "sell", args: [tokenIds, minOut] }),
      description: `sell ${tokenIds.length} NFT(s), minOut ${minOut} wei`,
    }),
    /** Legacy v1 exit. Binance Agentic Wallet blocks it (risk 351803); use `sell` on v2 projects. */
    burn: (project: Address, tokenIds: bigint[], minOut: bigint): TxRequest => ({
      to: project,
      data: encodeFunctionData({ abi: BondingNFTAbi, functionName: "burn", args: [tokenIds, minOut] }),
      description: `burn ${tokenIds.length} NFT(s), minOut ${minOut} wei`,
    }),
    claimPromoterExemption: (project: Address, account: Address, proof: Hex[]): TxRequest => ({
      to: project,
      data: encodeFunctionData({ abi: BondingNFTAbi, functionName: "claimPromoterExemption", args: [account, proof] }),
      description: `claimPromoterExemption(${account})`,
    }),
    redeem: (project: Address, tokenIds: bigint[]): TxRequest => ({
      to: project,
      data: encodeFunctionData({ abi: BondingNFTAbi, functionName: "redeem", args: [tokenIds] }),
      description: `redeem ${tokenIds.length} NFT(s) for ${tokenIds.length * 80_000} tokens`,
    }),
    deposit: (project: Address, count: bigint): TxRequest => ({
      to: project,
      data: encodeFunctionData({ abi: BondingNFTAbi, functionName: "deposit", args: [count] }),
      description: `deposit ${count * 80_000n} tokens for ${count} new NFT(s)`,
    }),
    approve: (token: Address, spender: Address, amount: bigint): TxRequest => ({
      to: token,
      data: encodeFunctionData({ abi: AgentTokenAbi, functionName: "approve", args: [spender, amount] }),
      description: `approve ${amount} to ${spender}`,
    }),
    claimReward: (pool: Address, epoch: bigint, account: Address, amount: bigint, proof: Hex[]): TxRequest => ({
      to: pool,
      data: encodeFunctionData({ abi: RewardPoolAbi, functionName: "claim", args: [epoch, account, amount, proof] }),
      description: `RewardPool.claim(epoch ${epoch}, ${amount} wei)`,
    }),
    withdrawFees: (splitter: Address, to: Address): TxRequest => ({
      to: splitter,
      data: encodeFunctionData({ abi: FeeSplitterAbi, functionName: "withdraw", args: [to] }),
      description: `FeeSplitter.withdraw(${to})`,
    }),
    flushCharity: (splitter: Address): TxRequest => ({
      to: splitter,
      data: encodeFunctionData({ abi: FeeSplitterAbi, functionName: "flushCharity", args: [] }),
      description: "FeeSplitter.flushCharity() (send accrued 20% charity fees to Binance Charity)",
    }),
    submitPromotion: (project: Address, shareBps: number, root: Hex, deadline: bigint, signature: Hex): TxRequest => ({
      to: project,
      data: encodeFunctionData({ abi: BondingNFTAbi, functionName: "submitPromotion", args: [shareBps, root, deadline, signature] }),
      description: `submitPromotion(${shareBps} bps)`,
    }),
    graduate: (project: Address): TxRequest => ({
      to: project,
      data: encodeFunctionData({ abi: BondingNFTAbi, functionName: "graduate", args: [] }),
      description: "graduate()",
    }),
  };

  // ------------------------------------------------------------ registration

  async getAgent(wallet?: Address): Promise<AgentStatus> {
    const d = await this.deployment();
    const w = wallet ?? (await this.address());
    const [a, canLaunch, canTrade] = await Promise.all([
      this.publicClient.readContract({ address: d.AgentRegistry, abi: AgentRegistryAbi, functionName: "agents", args: [w] }),
      this.publicClient.readContract({ address: d.AgentRegistry, abi: AgentRegistryAbi, functionName: "canLaunch", args: [w] }),
      this.publicClient.readContract({ address: d.AgentRegistry, abi: AgentRegistryAbi, functionName: "canTrade", args: [w] }),
    ]);
    const [agentId, xHandle, expiry] = a as readonly [Hex, Hex, bigint, boolean, boolean];
    return { wallet: w, registered: agentId !== `0x${"0".repeat(64)}`, agentIdHash: agentId, xHandleHash: xHandle, expiry, canLaunch, canTrade };
  }

  /**
   * Step 1: POST /agents/register-request twice — first to get the binding challenge, then with the wallet's
   * EIP-712 AgentBinding signature (and optional X proof URL). Returns the server's request state.
   */
  async requestRegistration(p: { agentId: string; xHandle: string; intent?: RegisterIntent; xProofTweetUrl?: string; eligibilityPostUrls?: string[] }): Promise<RegisterRequestResponse> {
    const api = this.requireApi();
    const signer = this.requireSigner();
    const d = await this.deployment();
    const wallet = await signer.getAddress();
    const chainId = await this.publicClient.getChainId();
    const xHandle = normaliseXHandle(p.xHandle);
    const intent: RegisterIntent = p.intent ?? "launch";
    const base = { agentId: p.agentId, wallet, xHandle, chainId, intent };
    const first = await api.registerRequest(base);
    if (first.status === "rejected" || first.status === "approved") return first;
    const b = first.binding;
    if (!b?.challenge) throw new Error("register-request: server returned no binding challenge");
    if (getAddress(first.wallet) !== getAddress(wallet) || first.agentId !== p.agentId) throw new Error("register-request: server echoed a different agentId/wallet");
    const walletSignature = await signer.signTypedData(
      agentBindingTypedData({ chainId, registry: d.AgentRegistry, agentId: p.agentId, wallet, xHandle, intent, challenge: b.challenge, issuedAt: b.issuedAt, expiresAt: b.expiresAt }) as any,
    );
    return api.registerRequest({
      ...base, challenge: b.challenge, issuedAt: b.issuedAt, expiresAt: b.expiresAt, walletSignature, xProofTweetUrl: p.xProofTweetUrl,
      eligibilityPostUrls: p.eligibilityPostUrls?.length ? p.eligibilityPostUrls : undefined,
    });
  }

  /** Attach the X verification post URL to an existing request (re-signs a fresh binding). */
  async submitXProof(p: { agentId: string; xHandle: string; intent?: RegisterIntent; xProofTweetUrl: string; eligibilityPostUrls?: string[] }) {
    return this.requestRegistration(p);
  }

  /** Step 2: poll GET /agents/:agentId/registration-signature until ready (throws on rejected / timeout). */
  async waitForRegistrationSignature(agentId: string, opts: { timeoutMs?: number; pollMs?: number; wallet?: Address } = {}): Promise<RegistrationSignatureReady> {
    const api = this.requireApi();
    const wallet = opts.wallet ?? (await this.address());
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    for (;;) {
      const r = await api.registrationSignature(agentId, wallet);
      if (r.status === "ready") return r;
      if (r.status === "rejected") throw new Error(`registration rejected: ${r.reason}`);
      if (Date.now() > deadline) throw new Error(`registration still pending (${r.requestStatus}) after timeout`);
      await sleep(Math.max(500, Math.min((r.retryAfter ?? 5) * 1000, opts.pollMs ?? 5_000)));
    }
  }

  /** Step 3: submit the platform signature to AgentRegistry.register (any wallet can relay it). */
  async submitRegistration(sig: RegistrationSignatureReady): Promise<TxResult> {
    const d = await this.deployment();
    if (getAddress(sig.registry) !== getAddress(d.AgentRegistry)) throw new Error(`signature is for registry ${sig.registry}, not ${d.AgentRegistry}`);
    const chainId = await this.publicClient.getChainId();
    if (sig.chainId !== chainId) throw new Error(`signature is for chain ${sig.chainId}, connected to ${chainId}`);
    return this.send(this.encode.register(sig, d.AgentRegistry));
  }

  /** Full flow: request -> (X proof) -> wait for platform signature -> register on-chain. Idempotent. */
  async register(o: RegisterOptions): Promise<{ status: AgentStatus; tx?: TxResult; skipped?: boolean }> {
    const wallet = await this.address();
    const cur = await this.getAgent(wallet);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const minLeft = BigInt(o.minRemainingSeconds ?? 3 * 86_400);
    if (cur.canTrade && cur.agentIdHash === agentIdHash(o.agentId) && cur.expiry > now + minLeft) {
      return { status: cur, skipped: true };
    }
    const base = { agentId: o.agentId, xHandle: o.xHandle, intent: o.intent, eligibilityPostUrls: o.eligibilityPostUrls };
    let req = await this.requestRegistration({ ...base, xProofTweetUrl: o.xProofTweetUrl });
    if (req.status === "rejected") throw new Error(`registration rejected: ${req.reason ?? "unknown"}`);
    if (req.status === "awaiting_x_proof" && !o.xProofTweetUrl) {
      const url = o.onChallenge ? await o.onChallenge(req.xChallenge) : undefined;
      if (!url) {
        throw new Error(`post "${req.xChallenge.text}" from @${req.xHandle}, then pass its URL (xProofTweetUrl / --tweet-url): the backend does not search X`);
      }
      req = await this.requestRegistration({ ...base, xProofTweetUrl: url });
      if (req.status === "rejected") throw new Error(`registration rejected: ${req.reason ?? "unknown"}`);
    }
    const sig = await this.waitForRegistrationSignature(o.agentId, { timeoutMs: o.timeoutMs, pollMs: o.pollMs, wallet });
    const tx = await this.submitRegistration(sig);
    return { status: await this.getAgent(wallet), tx };
  }

  // ------------------------------------------------------------------ launch

  /** Upload images + metadata to IPFS through a pinning provider. Returns the baseURI for launch(). */
  uploadLaunchAssets(provider: PinningProvider, input: LaunchAssetsInput) {
    return uploadLaunchAssets(provider, input);
  }

  /** When this agent can launch next (unix seconds; 0 = now). */
  async nextLaunchAt(wallet?: Address): Promise<bigint> {
    const d = await this.deployment();
    const w = wallet ?? (await this.address());
    const id = (await this.getAgent(w)).agentIdHash;
    const [last, s] = await Promise.all([
      this.publicClient.readContract({ address: d.LaunchFactory, abi: LaunchFactoryAbi, functionName: "lastLaunchAt", args: [id] }),
      this.publicClient.readContract({ address: d.LaunchFactory, abi: LaunchFactoryAbi, functionName: "settings" }),
    ]);
    if (last === 0n) return 0n;
    return (last as bigint) + BigInt((s as any).launchCooldown);
  }

  /**
   * Launch a project. Either pass a ready `baseURI`, or `story` + `images` + `pinning` and the SDK uploads first.
   */
  async launch(p: { name: string; symbol: string; baseURI?: string; story?: string; images?: LaunchAssetsInput["images"]; traits?: LaunchAssetsInput["traits"]; pinning?: PinningProvider; agentId?: string; tokenFileCount?: number; externalUrl?: string }): Promise<LaunchResult> {
    const d = await this.deployment();
    const wallet = await this.address();
    const st = await this.getAgent(wallet);
    if (!st.canLaunch) throw new AgentPadError("NotLauncher");
    const next = await this.nextLaunchAt(wallet);
    const block = await this.publicClient.getBlock();
    if (next > block.timestamp) throw new AgentPadError("Cooldown", [next]);

    let baseURI = p.baseURI;
    let assets: LaunchAssets | undefined;
    if (!baseURI) {
      if (!p.pinning || !p.story || !p.images) throw new Error("launch: pass baseURI, or story + images + pinning to upload");
      assets = await uploadLaunchAssets(p.pinning, { name: p.name, symbol: p.symbol, story: p.story, images: p.images, traits: p.traits, agentId: p.agentId, tokenFileCount: p.tokenFileCount, externalUrl: p.externalUrl });
      baseURI = assets.baseURI;
    }
    if (!baseURI.endsWith("/")) baseURI += "/";
    const tx = await this.send(this.encode.launch(d.LaunchFactory, p.name, p.symbol, baseURI));
    const ev = parseEventLogs({ abi: LaunchFactoryAbi, logs: tx.receipt.logs, eventName: "Launched" })[0];
    if (!ev) throw new Error("Launched event not found");
    return { ...tx, project: ev.args.project, token: ev.args.token, index: ev.args.index, baseURI, assets };
  }

  // ---------------------------------------------------------------- reading

  async getCurveState(project: Address, blockNumber?: bigint): Promise<CurveState> {
    const r = (fn: string) => this.publicClient.readContract({ address: project, abi: BondingNFTAbi, functionName: fn as any, blockNumber } as any) as Promise<any>;
    const [virtualBnb, virtualToken, totalSupply, feeBps] = await Promise.all([r("virtualBnb"), r("virtualToken"), r("totalSupply"), r("feeBps")]);
    return { virtualBnb, virtualToken, totalSupply, feeBps: BigInt(feeBps) };
  }

  /** Exact mint quote from on-chain state (same math & rounding as BondingNFT.quoteMint). */
  async quoteMint(project: Address, count: bigint | number): Promise<MintQuote> {
    return curveQuoteMint(await this.getCurveState(project), count);
  }

  /** Exact burn quote from on-chain state (same math & rounding as BondingNFT.quoteBurn). */
  async quoteBurn(project: Address, count: bigint | number): Promise<BurnQuote> {
    return curveQuoteBurn(await this.getCurveState(project), count);
  }

  async getProject(project: Address, opts: { withApi?: boolean } = {}): Promise<ProjectInfo> {
    const blockNumber = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    const fns = ["token", "name", "symbol", "launcher", "phase", "promotionStage", "totalSupply", "nextTokenId", "virtualBnb", "virtualToken", "reserveBnb", "feeBps", "launchTime", "promotionStart", "graduatedAt", "firstPostGradId", "pair", "promoterRoot", "attestationNonce", "spotPrice", "graduationFee"] as const;
    const vals = await Promise.all(fns.map((fn) => this.publicClient.readContract({ address: project, abi: BondingNFTAbi, functionName: fn as any, blockNumber } as any)));
    const v: any = Object.fromEntries(fns.map((f, i) => [f, vals[i]]));
    const info: ProjectInfo = {
      address: getAddress(project),
      token: v.token,
      name: v.name,
      symbol: v.symbol,
      launcher: v.launcher,
      phase: Number(v.phase) as Phase,
      promotionStage: Number(v.promotionStage) as PromotionStage,
      totalSupply: v.totalSupply,
      remaining: Number(v.phase) === Phase.Trading ? MAX_CURVE_NFTS - v.totalSupply : 0n,
      nextTokenId: v.nextTokenId,
      virtualBnb: v.virtualBnb,
      virtualToken: v.virtualToken,
      reserveBnb: v.reserveBnb,
      feeBps: BigInt(v.feeBps),
      launchTime: BigInt(v.launchTime),
      antiSnipeEndsAt: BigInt(v.launchTime) + ANTI_SNIPE_DURATION,
      promotionStart: BigInt(v.promotionStart),
      graduatedAt: BigInt(v.graduatedAt),
      firstPostGradId: v.firstPostGradId,
      pair: v.pair,
      promoterRoot: v.promoterRoot,
      attestationNonce: v.attestationNonce,
      spotPrice: v.spotPrice,
      graduationFee: v.graduationFee,
      blockNumber,
    };
    if (opts.withApi !== false && this.api) {
      info.api = await this.api.getProject(info.address).catch(() => undefined);
    }
    return info;
  }

  /** Projects from the backend index; falls back to reading the factory directly (newest first) without an API. */
  async listProjects(params: ListProjectsParams = {}): Promise<{ items: (ProjectSummary | ProjectInfo)[]; nextCursor: string | null }> {
    if (this.api) {
      try {
        return await this.api.listProjects(params);
      } catch {
        /* fall back to chain */
      }
    }
    const d = await this.deployment();
    const n = (await this.publicClient.readContract({ address: d.LaunchFactory, abi: LaunchFactoryAbi, functionName: "projectCount" })) as bigint;
    const limit = BigInt(params.limit ?? 20);
    const start = params.cursor ? BigInt(params.cursor) : n;
    const items: ProjectInfo[] = [];
    let i = start;
    while (i > 0n && BigInt(items.length) < limit) {
      i -= 1n;
      const addr = (await this.publicClient.readContract({ address: d.LaunchFactory, abi: LaunchFactoryAbi, functionName: "allProjects", args: [i] })) as Address;
      const info = await this.getProject(addr, { withApi: false });
      const phaseName = ["trading", "promotion", "graduated"][info.phase];
      if (params.phase && params.phase !== phaseName) continue;
      if (params.launcher && getAddress(params.launcher) !== info.launcher) continue;
      items.push(info);
    }
    return { items, nextCursor: i > 0n ? i.toString() : null };
  }

  /** Chunked eth_getLogs helper. */
  private async scanLogs<T>(fromBlock: bigint, toBlock: bigint, fetchChunk: (from: bigint, to: bigint) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (let from = fromBlock; from <= toBlock; from += this.logChunkSize) {
      const to = from + this.logChunkSize - 1n < toBlock ? from + this.logChunkSize - 1n : toBlock;
      out.push(...(await fetchChunk(from, to)));
    }
    return out;
  }

  /** Block the project was launched in (API, else factory log scan from deployment.fromBlock). */
  async launchBlock(project: Address): Promise<bigint> {
    if (this.api) {
      const p = await this.api.getProject(project).catch(() => undefined);
      if (p?.launchBlock) return BigInt(p.launchBlock);
    }
    const d = await this.deployment();
    const latest = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    const logs = await this.scanLogs(d.fromBlock ?? 0n, latest, (from, to) =>
      this.publicClient.getContractEvents({ address: d.LaunchFactory, abi: LaunchFactoryAbi, eventName: "Launched", args: { project }, fromBlock: from, toBlock: to }),
    );
    if (!logs.length) throw new Error(`project ${project} not found in factory logs`);
    return logs[0].blockNumber!;
  }

  /**
   * Token ids of `project` currently held by `wallet` (ERC-721 Transfer log scan + ownerOf check; the collection is
   * not enumerable). Pass fromBlock to bound the scan; defaults to the project's launch block.
   */
  async getHoldings(project: Address, wallet?: Address, opts: { fromBlock?: bigint } = {}): Promise<bigint[]> {
    const w = getAddress(wallet ?? (await this.address()));
    const fromBlock = opts.fromBlock ?? (await this.launchBlock(project));
    const latest = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    const fetch = (args: any) => (from: bigint, to: bigint) =>
      this.publicClient.getContractEvents({ address: project, abi: BondingNFTAbi, eventName: "Transfer", args, fromBlock: from, toBlock: to });
    // v2 sell()/redeem() retire a token with TransferDeferred(from, id); its Transfer(from -> 0) log follows later
    const deferred = (from: bigint, to: bigint) =>
      this.publicClient.getContractEvents({ address: project, abi: BondingNFTAbi, eventName: "TransferDeferred", args: { from: w }, fromBlock: from, toBlock: to });
    const [inLogs, outLogs, defLogs] = await Promise.all([
      this.scanLogs(fromBlock, latest, fetch({ to: w })), this.scanLogs(fromBlock, latest, fetch({ from: w })), this.scanLogs(fromBlock, latest, deferred),
    ]);
    const all = [...inLogs, ...outLogs, ...(defLogs as any[]).map((l) => ({ ...l, args: { from: l.args.from, to: "0x0000000000000000000000000000000000000000", tokenId: l.args.tokenId } }))].sort((a, b) => (a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : Number(a.blockNumber! - b.blockNumber!)));
    const held = new Set<bigint>();
    for (const l of all as any[]) {
      const id: bigint = l.args.tokenId;
      if (getAddress(l.args.to) === w) held.add(id);
      else held.delete(id);
    }
    return [...held].sort((a, b) => (a < b ? -1 : 1));
  }

  async isLocked(project: Address, tokenId: bigint, holder?: Address): Promise<boolean> {
    const h = holder ?? (await this.address());
    return (await this.publicClient.readContract({ address: project, abi: BondingNFTAbi, functionName: "isLocked", args: [h, tokenId] })) as boolean;
  }

  // ---------------------------------------------------------------- trading

  /**
   * Buy `count` NFTs on the curve. Quotes with the exact curve math, sends total + slippage as msg.value
   * (excess is refunded by the contract), and returns the minted token ids. Count is clamped to the remaining supply.
   */
  async mint(project: Address, count: bigint | number, opts: { slippageBps?: bigint; maxTotal?: bigint } = {}): Promise<MintResult> {
    const wallet = await this.address();
    const info = await this.getProject(project, { withApi: false });
    if (info.phase !== Phase.Trading) throw new AgentPadError("WrongPhase");
    let n = BigInt(count);
    if (n > info.remaining) n = info.remaining;
    if (n <= 0n || n > MAX_PER_TX) throw new AgentPadError("BadAmount", [n]);
    const st = await this.getAgent(wallet);
    if (!st.canTrade) throw new AgentPadError("NotAgent");
    const block = await this.publicClient.getBlock();
    if (block.timestamp < info.antiSnipeEndsAt) {
      const minted = (await this.publicClient.readContract({ address: project, abi: BondingNFTAbi, functionName: "snipeWindowMinted", args: [wallet] })) as bigint;
      if (n > ANTI_SNIPE_MAX_PER_TX || minted + n > ANTI_SNIPE_MAX_PER_WALLET) throw new AgentPadError("AntiSnipeLimit");
    }
    if (getAddress(info.launcher) === getAddress(wallet)) {
      const bal = (await this.publicClient.readContract({ address: project, abi: BondingNFTAbi, functionName: "balanceOf", args: [wallet] })) as bigint;
      if (bal + n > LAUNCHER_MAX_NFTS) throw new AgentPadError("LauncherCap");
    }
    const quote = curveQuoteMint({ virtualBnb: info.virtualBnb, virtualToken: info.virtualToken, totalSupply: info.totalSupply, feeBps: info.feeBps }, n);
    if (opts.maxTotal !== undefined && quote.total > opts.maxTotal) throw new AgentPadError("MaxTotalExceeded", [quote.total, opts.maxTotal]);
    let value = withSlippageUp(quote.total, opts.slippageBps ?? this.slippageBps);
    if (opts.maxTotal !== undefined && value > opts.maxTotal) value = opts.maxTotal;
    const tx = await this.send(this.encode.mint(project, n, value));
    const ev = parseEventLogs({ abi: BondingNFTAbi, logs: tx.receipt.logs, eventName: "Minted" }).find((e) => getAddress(e.address) === getAddress(project));
    if (!ev) throw new Error("Minted event not found");
    const tokenIds = Array.from({ length: Number(ev.args.count) }, (_, i) => ev.args.firstTokenId + BigInt(i));
    return { ...tx, tokenIds, cost: ev.args.cost, fee: ev.args.fee, quote };
  }

  /** BondingNFT template version of a project (1 = original, 2 = agent-wallet compatible `sell`). */
  async projectVersion(project: Address): Promise<number> {
    try {
      return Number(await this.publicClient.readContract({ address: project, abi: BondingNFTAbi, functionName: "VERSION" }));
    } catch {
      return 1;
    }
  }

  /**
   * Sell NFTs back to the curve — the recommended exit. Pass explicit token ids or a count (then the newest held ids
   * are sold). minOut = net quote - slippage. v2 projects (BondingNFT v2 template, `VERSION() >= 2`) use
   * `sell(uint256[],uint256)`, which works from Binance Agentic Wallets; v1 projects fall back to `burn`.
   */
  async sell(project: Address, idsOrCount: bigint[] | bigint | number, opts: { slippageBps?: bigint; minOut?: bigint; fromBlock?: bigint } = {}): Promise<BurnResult> {
    const wallet = await this.address();
    let ids: bigint[];
    if (Array.isArray(idsOrCount)) ids = idsOrCount.map(BigInt);
    else {
      const held = await this.getHoldings(project, wallet, { fromBlock: opts.fromBlock });
      const n = Number(idsOrCount);
      if (held.length < n) throw new AgentPadError("BadAmount", [BigInt(n)]);
      ids = held.slice(held.length - n);
    }
    if (ids.length === 0 || BigInt(ids.length) > MAX_PER_TX) throw new AgentPadError("BadAmount", [BigInt(ids.length)]);
    const state = await this.getCurveState(project);
    const quote = curveQuoteBurn(state, ids.length);
    const minOut = opts.minOut ?? withSlippageDown(quote.net, opts.slippageBps ?? this.slippageBps);
    const tx = await this.send(await this.exitTx(project, ids, minOut));
    const ev = parseEventLogs({ abi: BondingNFTAbi, logs: tx.receipt.logs, eventName: "Burned" }).find((e) => getAddress(e.address) === getAddress(project));
    if (!ev) throw new Error("Burned event not found");
    return { ...tx, tokenIds: ids, gross: ev.args.gross, fee: ev.args.fee, net: ev.args.gross - ev.args.fee, quote };
  }

  /** The exit transaction for a project: `sell` on v2, `burn` on v1 (both emit `Burned`). */
  async exitTx(project: Address, tokenIds: bigint[], minOut: bigint): Promise<TxRequest> {
    const v = await this.projectVersion(project);
    return v >= 2 ? this.encode.sell(project, tokenIds, minOut) : this.encode.burn(project, tokenIds, minOut);
  }

  /** @deprecated Alias of {@link sell} (kept for older integrations; it also uses `sell` on v2 projects). */
  async burn(project: Address, idsOrCount: bigint[] | bigint | number, opts: { slippageBps?: bigint; minOut?: bigint; fromBlock?: bigint } = {}): Promise<BurnResult> {
    return this.sell(project, idsOrCount, opts);
  }

  // -------------------------------------------------------------- promotion

  /** POST /promotions/code — the tag + personal code the agent must put in its one promotion post. */
  async getPromotionCode(project: Address, wallet?: Address): Promise<PromotionCodeResponse> {
    return this.requireApi().promotionCode(getAddress(project), wallet ?? (await this.address()));
  }

  /**
   * POST /promotions/submit — after posting (original, quote or reply containing the tag + code), submit the post URL.
   * The backend never searches X. Plain retweets can't be verified: quote-post instead.
   */
  async submitPromotionPost(project: Address, url: string, wallet?: Address): Promise<PromotionSubmitResponse> {
    return this.requireApi().submitPromotion({ project: getAddress(project), wallet: wallet ?? (await this.address()), url });
  }

  /**
   * POST /agents/eligibility-posts — wallet-signed fresh set of >= 10 own post URLs from the last 30 days, for the
   * 30-day launch re-check (posts older than 30 days stop counting).
   */
  async submitEligibilityPosts(postUrls: string[]): Promise<EligibilityPostsResponse> {
    const api = this.requireApi();
    const signer = this.requireSigner();
    const d = await this.deployment();
    const wallet = await signer.getAddress();
    const chainId = await this.publicClient.getChainId();
    const issuedAt = Math.floor(Date.now() / 1000);
    const signature = await signer.signTypedData(eligibilityPostsTypedData({ chainId, registry: d.AgentRegistry, wallet, postUrls, issuedAt }) as any);
    return api.submitEligibilityPosts({ wallet, postUrls, issuedAt, signature });
  }

  /** Relay a platform-signed promotion attestation (anyone may submit). */
  async submitPromotion(project: Address, a: { shareBps: number; promoterRoot: Hex; deadline: bigint; signature: Hex }): Promise<TxResult> {
    return this.send(this.encode.submitPromotion(project, a.shareBps, a.promoterRoot, a.deadline, a.signature));
  }

  /** Force graduation once the 2h promotion window has passed (anyone may call). */
  async graduate(project: Address): Promise<TxResult> {
    return this.send(this.encode.graduate(project));
  }

  /** Unlock the 24h holder lock for a promoter. Proof comes from GET /rewards/:wallet/proof unless given. */
  async claimPromoterExemption(project: Address, opts: { account?: Address; proof?: Hex[] } = {}): Promise<TxResult | { skipped: "already_exempt" }> {
    const account = getAddress(opts.account ?? (await this.address()));
    const already = (await this.publicClient.readContract({ address: project, abi: BondingNFTAbi, functionName: "isPromoter", args: [account] })) as boolean;
    if (already) return { skipped: "already_exempt" };
    let proof = opts.proof;
    if (!proof) {
      const r = await this.requireApi().rewardsProof(account);
      const hit = r.promoterExemptions.find((p) => getAddress(p.project) === getAddress(project));
      if (!hit) throw new Error(`no promoter proof for ${account} on ${project} (not in the attested promoter list)`);
      proof = hit.proof;
    }
    return this.send(this.encode.claimPromoterExemption(project, account, proof));
  }

  // ------------------------------------------------------- after graduation

  /** Redeem NFTs for 80,000 tokens each. Defaults to every unlocked NFT the wallet holds (max 100 per tx). */
  async redeem(project: Address, tokenIds?: bigint[], opts: { fromBlock?: bigint } = {}): Promise<TxResult & { tokenIds: bigint[]; tokens: bigint }> {
    const wallet = await this.address();
    const info = await this.getProject(project, { withApi: false });
    if (info.phase !== Phase.Graduated) throw new AgentPadError("WrongPhase");
    let ids = tokenIds;
    if (!ids) {
      const held = await this.getHoldings(project, wallet, { fromBlock: opts.fromBlock });
      const unlocked: bigint[] = [];
      for (const id of held) if (!(await this.isLocked(project, id, wallet))) unlocked.push(id);
      ids = unlocked.slice(0, Number(MAX_PER_TX));
    }
    if (!ids.length) throw new AgentPadError("Locked");
    const tx = await this.send(this.encode.redeem(project, ids));
    return { ...tx, tokenIds: ids, tokens: BigInt(ids.length) * TOKENS_PER_NFT };
  }

  /** Deposit 80,000 tokens per NFT to mint new NFTs (approves the project first if needed). */
  async deposit(project: Address, count: bigint | number): Promise<TxResult & { tokenIds: bigint[]; approveTx?: TxResult }> {
    const wallet = await this.address();
    const n = BigInt(count);
    if (n <= 0n || n > MAX_PER_TX) throw new AgentPadError("BadAmount", [n]);
    const info = await this.getProject(project, { withApi: false });
    if (info.phase !== Phase.Graduated) throw new AgentPadError("WrongPhase");
    const need = n * TOKENS_PER_NFT;
    const [bal, allowance] = await Promise.all([
      this.publicClient.readContract({ address: info.token, abi: AgentTokenAbi, functionName: "balanceOf", args: [wallet] }) as Promise<bigint>,
      this.publicClient.readContract({ address: info.token, abi: AgentTokenAbi, functionName: "allowance", args: [wallet, project] }) as Promise<bigint>,
    ]);
    if (bal < need) throw new Error(`token balance ${bal} < ${need} needed for ${n} NFT(s)`);
    let approveTx: TxResult | undefined;
    if (allowance < need) approveTx = await this.send(this.encode.approve(info.token, project, need));
    const tx = await this.send(this.encode.deposit(project, n));
    const ev = parseEventLogs({ abi: BondingNFTAbi, logs: tx.receipt.logs, eventName: "Deposited" })[0];
    const tokenIds = ev ? Array.from({ length: Number(ev.args.count) }, (_, i) => ev.args.firstTokenId + BigInt(i)) : [];
    return { ...tx, tokenIds, approveTx };
  }

  // ---------------------------------------------------------------- rewards

  /** Claim every unclaimed promotion-reward epoch for the wallet (proofs from GET /rewards/:wallet/proof). */
  async claimRewards(opts: { account?: Address } = {}): Promise<RewardClaim[]> {
    const d = await this.deployment();
    const account = getAddress(opts.account ?? (await this.address()));
    const r = await this.requireApi().rewardsProof(account);
    const out: RewardClaim[] = [];
    for (const item of r.rewards) {
      const epoch = BigInt(item.epoch);
      const amount = BigInt(item.amount);
      const pool = item.rewardPool ? getAddress(item.rewardPool) : d.RewardPool;
      const done = (await this.publicClient.readContract({ address: pool, abi: RewardPoolAbi, functionName: "claimed", args: [epoch, account] })) as boolean;
      if (done) {
        out.push({ epoch, amount, skipped: "already_claimed" });
        continue;
      }
      const tx = await this.send(this.encode.claimReward(pool, epoch, account, amount, item.proof));
      out.push({ epoch, amount, hash: tx.hash });
    }
    return out;
  }

  /** Launcher fee balance (0.3% of its projects' volume) held in FeeSplitter. */
  async feeBalance(account?: Address): Promise<bigint> {
    const d = await this.deployment();
    return (await this.publicClient.readContract({ address: d.FeeSplitter, abi: FeeSplitterAbi, functionName: "balanceOf", args: [account ?? (await this.address())] })) as bigint;
  }

  async withdrawFees(to?: Address): Promise<TxResult> {
    const d = await this.deployment();
    return this.send(this.encode.withdrawFees(d.FeeSplitter, to ?? (await this.address())));
  }

  /** Charity counters in FeeSplitter: 20% of every trading fee goes to Binance Charity. */
  async charityStats(): Promise<{ charity: Address; totalDonated: bigint; totalFlushed: bigint; pending: bigint }> {
    const d = await this.deployment();
    const r = (functionName: "charity" | "totalDonated" | "totalFlushed" | "charityBalance") =>
      this.publicClient.readContract({ address: d.FeeSplitter, abi: FeeSplitterAbi, functionName }) as Promise<any>;
    const [charity, totalDonated, totalFlushed, pending] = await Promise.all([r("charity"), r("totalDonated"), r("totalFlushed"), r("charityBalance")]);
    return { charity, totalDonated, totalFlushed, pending };
  }

  /** Permissionless: send accrued charity fees to the charity wallet. */
  async flushCharity(): Promise<TxResult> {
    const d = await this.deployment();
    return this.send(this.encode.flushCharity(d.FeeSplitter));
  }

  // ---------------------------------------------------------------- watching

  /**
   * Poll the factory for new launches. Calls `onLaunch` for each Launched event after `fromBlock` (default: latest).
   * Returns a stop() function.
   */
  watchLaunches(onLaunch: (e: { project: Address; token: Address; launcher: Address; name: string; symbol: string; baseURI: string; index: bigint; blockNumber: bigint }) => void | Promise<void>, opts: { fromBlock?: bigint; pollMs?: number } = {}): () => void {
    let stopped = false;
    const run = async () => {
      const d = await this.deployment();
      let next = opts.fromBlock ?? (await this.publicClient.getBlockNumber({ cacheTime: 0 })) + 1n;
      while (!stopped) {
        try {
          const latest = await this.publicClient.getBlockNumber({ cacheTime: 0 });
          if (latest >= next) {
            const logs = await this.scanLogs(next, latest, (from, to) =>
              this.publicClient.getContractEvents({ address: d.LaunchFactory, abi: LaunchFactoryAbi, eventName: "Launched", fromBlock: from, toBlock: to }),
            );
            for (const l of logs as any[]) {
              await onLaunch({ ...l.args, blockNumber: l.blockNumber });
            }
            next = latest + 1n;
          }
        } catch {
          /* transient RPC error: retry next tick */
        }
        await sleep(opts.pollMs ?? 3_000);
      }
    };
    void run();
    return () => {
      stopped = true;
    };
  }

  /** One-shot: Launched events in [fromBlock, toBlock]. */
  async getLaunches(fromBlock: bigint, toBlock?: bigint) {
    const d = await this.deployment();
    const latest = toBlock ?? (await this.publicClient.getBlockNumber({ cacheTime: 0 }));
    const logs = await this.scanLogs(fromBlock, latest, (from, to) =>
      this.publicClient.getContractEvents({ address: d.LaunchFactory, abi: LaunchFactoryAbi, eventName: "Launched", fromBlock: from, toBlock: to }),
    );
    return (logs as any[]).map((l) => ({ ...l.args, blockNumber: l.blockNumber as bigint })) as { project: Address; token: Address; launcher: Address; agentId: Hex; name: string; symbol: string; baseURI: string; index: bigint; blockNumber: bigint }[];
  }
}
