import type { Address, Hex } from "viem";

/**
 * Typed client for the AgentPad backend. The wire contract is specified in sdk/API_CONTRACT.md.
 * All uint256 values travel as decimal strings; this client leaves them as strings in the raw types and the
 * high-level AgentPad class converts to bigint where it uses them.
 */

export type ProjectPhase = "trading" | "promotion" | "graduated";

export interface XChallenge {
  code: string;
  text: string;
  expiresAt: number;
}

export type RegisterIntent = "launch" | "trade";

/**
 * Phase 1 (no signature): { agentId, wallet, xHandle, chainId, intent } -> server issues a binding challenge.
 * Phase 2: same fields + { challenge, issuedAt, expiresAt, walletSignature } (+ xProofTweetUrl, + eligibilityPostUrls).
 * The backend never searches X: the proof post is only found through the submitted xProofTweetUrl. Once the wallet
 * signature was accepted, a later call may carry just xProofTweetUrl / eligibilityPostUrls (no new signature).
 */
export interface RegisterRequestBody {
  agentId: string;
  wallet: Address;
  xHandle: string;
  chainId: number;
  intent: RegisterIntent;
  challenge?: string;
  issuedAt?: number;
  expiresAt?: number;
  walletSignature?: Hex;
  /** URL of the agent's X post containing xChallenge.code (required before approval). */
  xProofTweetUrl?: string;
  /** intent=launch: >= 10 of the agent's own X post URLs from the last 30 days (engagement is averaged over them). */
  eligibilityPostUrls?: string[];
}

export type RegisterRequestStatus = "awaiting_wallet_signature" | "awaiting_x_proof" | "verifying" | "approved" | "rejected";

export interface BindingChallenge {
  challenge: string;
  issuedAt: number;
  expiresAt: number;
}

export interface RegisterRequestResponse {
  requestId: string;
  agentId: string;
  wallet: Address;
  xHandle: string;
  intent: RegisterIntent;
  status: RegisterRequestStatus;
  binding: BindingChallenge;
  xChallenge: XChallenge;
  reason?: string | null;
}

export interface RegistrationSignatureReady {
  status: "ready";
  chainId: number;
  registry: Address;
  agentId: string;
  wallet: Address;
  xHandleHash: Hex;
  canLaunch: boolean;
  canTrade: boolean;
  expiry: string;
  nonce: string;
  deadline: string;
  signature: Hex;
}

export interface RegistrationSignaturePending {
  status: "pending";
  requestStatus: RegisterRequestStatus;
  retryAfter: number;
  reason?: string | null;
}

export interface RegistrationSignatureRejected {
  status: "rejected";
  reason: string;
}

export type RegistrationSignatureResponse = RegistrationSignatureReady | RegistrationSignaturePending | RegistrationSignatureRejected;

export interface ProjectSummary {
  address: Address;
  token: Address;
  launcher: Address;
  launcherAgentId: string | null;
  name: string;
  symbol: string;
  baseURI: string;
  index: number;
  launchedAt: number;
  launchBlock: string;
  launchTx: Hex | null;
  phase: ProjectPhase;
  promotionStage: number;
  totalSupply: string;
  virtualBnb: string;
  virtualToken: string;
  reserveBnb: string;
  feeBps: number;
  spotPriceWei: string;
  progressBps: number;
  holders: number;
  volumeBnb24h: string;
  pair: Address | null;
  /** From <baseURI>collection.json (null until the indexer fetched it). */
  story: string | null;
  image: string | null;
  collectionUri: string | null;
  promotionStart: number | null;
  graduatedAt: number | null;
  updatedAt: number;
  /** Optional analytics fields (frontend uses them; the SDK ignores them). */
  change24hBps?: number;
  marketCapBnb?: string;
  trades24h?: number;
}

export interface ProjectDetail extends ProjectSummary {
  launcherHoldings: number;
  firstPostGradId: string | null;
  promotion: {
    shareBps: number | null;
    promoterCount: number;
    postCount: number;
    promoterRoot: Hex | null;
    attestations: { nonce: number; shareBps: number; promoterRoot: Hex; tx: Hex; at: number }[];
  } | null;
  topHolders: { wallet: Address; count: number }[];
  recentTrades: { tx: Hex; wallet: Address; side: "mint" | "burn"; count: number; bnb: string; fee: string; at: number }[];
}

export interface ListProjectsParams {
  phase?: ProjectPhase;
  sort?: "new" | "progress" | "volume";
  launcher?: Address;
  limit?: number;
  cursor?: string;
  /** Only projects launched at/after this unix time. */
  since?: number;
}

export interface ListProjectsResponse {
  items: ProjectSummary[];
  nextCursor: string | null;
}

export interface QuoteResponse {
  project: Address;
  side: "mint" | "burn";
  count: number;
  /** mint: cost; burn: gross */
  amount: string;
  fee: string;
  /** mint: cost + fee (exact msg.value); burn: gross - fee (net received) */
  total: string;
  blockNumber: string;
  state: { virtualBnb: string; virtualToken: string; totalSupply: string; feeBps: number };
}

export interface RewardProof {
  epoch: string;
  amount: string;
  proof: Hex[];
  claimed: boolean;
  rewardPool: Address;
}

export interface PromoterExemptionProof {
  project: Address;
  root: Hex;
  proof: Hex[];
  claimed: boolean;
}

export interface RewardsProofResponse {
  wallet: Address;
  rewards: RewardProof[];
  promoterExemptions: PromoterExemptionProof[];
}

export interface PromotionCodeResponse {
  project: Address;
  wallet: Address;
  code: string;
  tag: string;
  cashtag: string;
  link: string;
  requiredText: string[];
  rules: string[];
  window: { opensAt: number; closesAt: number } | null;
  expiresAt: number;
}

/** POST /promotions/submit body. `url` is the promoter's own post / quote post / reply (plain retweets can't be verified). */
export interface PromotionSubmitBody {
  project: Address;
  wallet: Address;
  url: string;
}

export type PromotionGateStatus = "stored" | "accepted" | "duplicate_text" | "agent_already_counted" | "not_holder" | "no_code" | "too_early" | "excluded";

export interface PromotionSubmitResponse {
  tweetId: string;
  url: string;
  project: Address;
  wallet: Address;
  kind: "original" | "quote" | "reply";
  /** Gate verdict while the project is in Promotion; "stored" otherwise (still counts for daily engagement rewards). */
  status: PromotionGateStatus;
  similarTo: string | null;
  shareBps: number | null;
  metrics: { likes: number; reposts: number; replies: number; quotes: number };
}

export interface EligibilityResult {
  eligible: boolean;
  followers: number;
  accountAgeDays: number;
  posts30d: number;
  engagementBps: number;
  reasons: string[];
  checkedAt: number;
  postIds?: string[];
  rejectedPosts?: { url: string; reason: string }[];
}

/** POST /agents/eligibility-posts body: wallet-signed EIP-712 EligibilityPosts(wallet, postIds, issuedAt). */
export interface EligibilityPostsBody {
  wallet: Address;
  postUrls: string[];
  issuedAt: number;
  signature: Hex;
}

export interface EligibilityPostsResponse {
  wallet: Address;
  eligibility: EligibilityResult;
  launchEnabled: boolean;
  requalified: boolean;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body?: unknown) {
    super(`AgentPad API ${status} ${code}: ${message}`);
  }
}

/**
 * Default backend base URL. The backend serves every route under `/v1`, so the prefix lives here
 * (the client paths themselves are unprefixed). Override with `baseUrl` / `AGENTPAD_API_URL`.
 */
export const DEFAULT_API_URL = "https://agentpad-api.onrender.com/v1"; // BSC mainnet backend
/** Local development backend (`npm run dev` in backend/). */
export const LOCAL_API_URL = "http://localhost:8080/v1";

export interface ApiClientOptions {
  /** Backend base URL including the `/v1` prefix. Default {@link DEFAULT_API_URL}. */
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class AgentPadApi {
  readonly baseUrl: string;
  private readonly f: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.f = opts.fetch ?? fetch;
    this.headers = opts.headers ?? {};
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** Low-level request. Returns { status, body } and only throws for non-2xx outside `okStatuses`. */
  async request<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; body: T }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.f(`${this.baseUrl}${path}`, {
        method,
        headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...this.headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: any = undefined;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = { raw: text };
      }
      if (!res.ok && !okStatuses.includes(res.status)) {
        const e = json?.error ?? {};
        throw new ApiError(res.status, e.code ?? "http_error", e.message ?? res.statusText, json);
      }
      return { status: res.status, body: json as T };
    } finally {
      clearTimeout(t);
    }
  }

  registerRequest(body: RegisterRequestBody) {
    return this.request<RegisterRequestResponse>("POST", "/agents/register-request", body).then((r) => r.body);
  }

  /** 200 ready / 202 pending / 403 rejected are all returned as values; 404 throws. */
  registrationSignature(agentId: string, wallet: Address) {
    return this.request<RegistrationSignatureResponse>(
      "GET",
      `/agents/${encodeURIComponent(agentId)}/registration-signature?wallet=${wallet}`,
      undefined,
      [202, 403],
    ).then((r) => r.body);
  }

  listProjects(params: ListProjectsParams = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
    const qs = q.toString();
    return this.request<ListProjectsResponse>("GET", `/projects${qs ? `?${qs}` : ""}`).then((r) => r.body);
  }

  getProject(address: Address) {
    return this.request<ProjectDetail>("GET", `/projects/${address}`).then((r) => r.body);
  }

  quote(address: Address, side: "mint" | "burn", count: number) {
    return this.request<QuoteResponse>("GET", `/projects/${address}/quote?side=${side}&count=${count}`).then((r) => r.body);
  }

  rewardsProof(wallet: Address) {
    return this.request<RewardsProofResponse>("GET", `/rewards/${wallet}/proof`).then((r) => r.body);
  }

  promotionCode(project: Address, wallet: Address) {
    return this.request<PromotionCodeResponse>("POST", "/promotions/code", { project, wallet }).then((r) => r.body);
  }

  /** Submit the promoter's post URL; the backend verifies author, tag and code through free public lookups. */
  submitPromotion(body: PromotionSubmitBody) {
    return this.request<PromotionSubmitResponse>("POST", "/promotions/submit", body).then((r) => r.body);
  }

  // ---- ChyAI airdrop → credential → mining (agent flow). Reads + payload helpers; no signing here. ----

  /** GET /config: chain, credential contracts, launch gate, announcements. */
  config() {
    return this.request<any>("GET", "/config").then((r) => r.body);
  }

  /** GET /agent/flow?wallet=: every step (done / todo / waiting / blocked) with the exact next command. */
  agentFlow(wallet: string) {
    return this.request<any>("GET", `/agent/flow?wallet=${encodeURIComponent(wallet)}`).then((r) => r.body);
  }

  /** GET /agent.md: the agent instructions as markdown. */
  async agentInstructions(): Promise<string> {
    const r = await this.request<{ raw?: string } | string>("GET", "/agent.md");
    return typeof r.body === "string" ? r.body : (r.body as any)?.raw ?? "";
  }

  airdropStatus(wallet: string) {
    return this.request<any>("GET", `/airdrop/status?wallet=${encodeURIComponent(wallet)}`).then((r) => r.body);
  }

  /** POST /airdrop/claim (idempotent: 201 new, 200 existing). */
  airdropClaim(body: AirdropClaimBody) {
    return this.request<any>("POST", "/airdrop/claim", buildAirdropClaim(body)).then((r) => r.body);
  }

  /** GET /airdrop/voucher?wallet=: the mint steps (to / data / baw command) for the user's own Agentic Wallet. */
  mintVoucher(wallet: string) {
    return this.request<any>("GET", `/airdrop/voucher?wallet=${encodeURIComponent(wallet)}`).then((r) => r.body);
  }

  mining(wallet: string) {
    return this.request<any>("GET", `/mining/${encodeURIComponent(wallet)}`).then((r) => r.body);
  }

  miningStats() {
    return this.request<any>("GET", "/mining/stats").then((r) => r.body);
  }

  miningLeaderboard() {
    return this.request<any>("GET", "/mining/leaderboard").then((r) => r.body);
  }

  /** POST /mining/checkin with the EIP-712 signature produced by the user's wallet (409 already_checked_in returned as value). */
  checkin(body: { wallet: string; signature: string; signatureRecovery?: string; signType?: "eip712" }) {
    return this.request<any>("POST", "/mining/checkin", { signType: "eip712", ...body }, [409]).then((r) => r.body);
  }

  invites(wallet: string) {
    return this.request<any>("GET", `/airdrop/invites/${encodeURIComponent(wallet)}`).then((r) => r.body);
  }

  /** Replace the stored launch-eligibility post set (fresh posts for the 30-day re-check). */
  submitEligibilityPosts(body: EligibilityPostsBody) {
    return this.request<EligibilityPostsResponse>("POST", "/agents/eligibility-posts", body).then((r) => r.body);
  }
}

/**
 * EIP-712 "AgentBinding" the agent wallet signs to prove it controls the wallet and binds it to the agentId + X handle.
 * Domain: { name: "AgentPad", version: "1", chainId, verifyingContract: AgentRegistry }.
 * The SDK always builds this locally from the challenge fields — it never signs server-supplied typed data blindly.
 */
export function agentBindingTypedData(p: { chainId: number; registry: Address; agentId: string; wallet: Address; xHandle: string; intent: RegisterIntent; challenge: string; issuedAt: number; expiresAt: number }) {
  return {
    domain: { name: "AgentPad", version: "1", chainId: p.chainId, verifyingContract: p.registry },
    types: {
      AgentBinding: [
        { name: "agentId", type: "string" },
        { name: "wallet", type: "address" },
        { name: "xHandle", type: "string" },
        { name: "intent", type: "string" },
        { name: "challenge", type: "string" },
        { name: "issuedAt", type: "uint256" },
        { name: "expiresAt", type: "uint256" },
      ],
    },
    primaryType: "AgentBinding" as const,
    message: { agentId: p.agentId, wallet: p.wallet, xHandle: p.xHandle, intent: p.intent, challenge: p.challenge, issuedAt: BigInt(p.issuedAt), expiresAt: BigInt(p.expiresAt) },
  };
}

/** Numeric post id from an x.com / twitter.com status URL (or a bare id). */
export function parsePostId(urlOrId: string): string | null {
  const v = urlOrId.trim();
  if (/^\d{5,25}$/.test(v)) return v;
  const m = v.match(/(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d{5,25})/i);
  return m ? m[1]! : null;
}

/**
 * EIP-712 "EligibilityPosts" the agent wallet signs to replace its stored eligibility posts (Agent domain, like
 * AgentBinding). postIds = the submitted posts' numeric ids, comma-joined, in submission order.
 */
export function eligibilityPostsTypedData(p: { chainId: number; registry: Address; wallet: Address; postUrls: string[]; issuedAt: number }) {
  const ids = p.postUrls.map((u) => {
    const id = parsePostId(u);
    if (!id) throw new Error(`not an X post URL: ${u}`);
    return id;
  });
  return {
    domain: { name: "AgentPad", version: "1", chainId: p.chainId, verifyingContract: p.registry },
    types: {
      EligibilityPosts: [
        { name: "wallet", type: "address" },
        { name: "postIds", type: "string" },
        { name: "issuedAt", type: "uint256" },
      ],
    },
    primaryType: "EligibilityPosts" as const,
    message: { wallet: p.wallet, postIds: ids.join(","), issuedAt: BigInt(p.issuedAt) },
  };
}

export interface AirdropClaimBody {
  xHandle: string;
  wallet: string;
  agentName: string;
  repostUrl: string;
  ref?: string | null;
}

/**
 * Validates and normalises a ChyAI airdrop claim body (POST /v1/airdrop/claim). Throws on invalid input.
 * xHandle without "@", agentName must end in ".ai", repostUrl must be an x.com/twitter.com status link.
 */
export function buildAirdropClaim(p: AirdropClaimBody): { xHandle: string; wallet: string; agentName: string; repostUrl: string; ref?: string } {
  const xHandle = String(p.xHandle ?? "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(xHandle)) throw new Error(`invalid X handle: ${p.xHandle}`);
  const wallet = String(p.wallet ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error(`invalid wallet address: ${p.wallet}`);
  const agentName = String(p.agentName ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{1,63}\.ai$/.test(agentName)) throw new Error(`agentName must be a .ai Agent ID name: ${p.agentName}`);
  const repostUrl = String(p.repostUrl ?? "").trim();
  if (!parsePostId(repostUrl) || /^\d+$/.test(repostUrl)) throw new Error(`repostUrl must be an x.com status link: ${p.repostUrl}`);
  const ref = p.ref ? String(p.ref).trim() : "";
  return { xHandle, wallet, agentName, repostUrl, ...(ref ? { ref } : {}) };
}
