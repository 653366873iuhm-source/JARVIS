/** Minimal read client for the public ChyAI API. No keys, no signing, no transaction sending. */

export const DEFAULT_API_ROOT = "https://agentpad-api.onrender.com";
export const SITE_URL = "https://chyai.onrender.com";
export const PINNED_POST = "https://x.com/ChyAI_Official/status/2115430735167607129";

export class ChyAIApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body?: unknown) {
    super(`${status} ${code}: ${message}`);
  }
}

export interface ChyAIClientOptions {
  /** API host without /v1 (default https://agentpad-api.onrender.com, env CHYAI_API_URL). */
  apiRoot?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ChyAIClient {
  readonly apiRoot: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ChyAIClientOptions = {}) {
    this.apiRoot = (opts.apiRoot ?? DEFAULT_API_ROOT).replace(/\/+$/, "").replace(/\/v1$/, "");
    this.f = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  get v1() {
    return `${this.apiRoot}/v1`;
  }

  /** GET a path under the API root. JSON bodies are parsed; text bodies returned as string. 4xx/5xx throw. */
  async get(path: string, okStatuses: number[] = []): Promise<unknown> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.f(`${this.apiRoot}${path}`, { method: "GET", headers: { accept: "application/json, text/markdown, text/plain" }, signal: ctrl.signal });
      const text = await res.text();
      let body: unknown = text;
      if ((res.headers.get("content-type") ?? "").includes("json") || /^\s*[{[]/.test(text)) {
        try {
          body = JSON.parse(text);
        } catch {
          /* keep text */
        }
      }
      if (!res.ok && !okStatuses.includes(res.status)) {
        const e = (body as any)?.error ?? {};
        throw new ChyAIApiError(res.status, e.code ?? "http_error", e.message ?? res.statusText, body);
      }
      return body;
    } finally {
      clearTimeout(t);
    }
  }

  config() {
    return this.get("/v1/config");
  }
  health() {
    return this.get("/v1/health");
  }
  agentFlow(wallet: string) {
    return this.get(`/v1/agent/flow?wallet=${encodeURIComponent(wallet)}`);
  }
  agentPrompt(ref?: string) {
    return this.get(`/v1/agent/prompt${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
  }
  async agentInstructions(): Promise<string> {
    return String(await this.get("/agent.md"));
  }
  async llmsTxt(): Promise<string> {
    return String(await this.get("/llms.txt"));
  }
  airdropStatus(wallet: string) {
    return this.get(`/v1/airdrop/status?wallet=${encodeURIComponent(wallet)}`);
  }
  mintVoucher(wallet: string) {
    return this.get(`/v1/airdrop/voucher?wallet=${encodeURIComponent(wallet)}`);
  }
  mining(wallet: string) {
    return this.get(`/v1/mining/${encodeURIComponent(wallet)}`);
  }
  miningStats() {
    return this.get("/v1/mining/stats");
  }
  miningLeaderboard() {
    return this.get("/v1/mining/leaderboard");
  }
  invites(wallet: string) {
    return this.get(`/v1/airdrop/invites/${encodeURIComponent(wallet)}`);
  }
  rewardsProof(wallet: string) {
    return this.get(`/v1/rewards/${encodeURIComponent(wallet)}/proof`);
  }
}

export interface ClaimInput {
  xHandle: string;
  wallet: string;
  agentName: string;
  repostUrl: string;
  ref?: string;
}

/** Validates and normalises a POST /v1/airdrop/claim body. Throws Error with a readable message on bad input. */
export function buildClaimPayload(p: ClaimInput) {
  const xHandle = String(p.xHandle ?? "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(xHandle)) throw new Error(`invalid X handle: "${p.xHandle}" (1-15 letters, digits or _)`);
  const wallet = String(p.wallet ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error(`invalid wallet address: "${p.wallet}" (0x + 40 hex)`);
  const agentName = String(p.agentName ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{1,63}\.ai$/.test(agentName)) throw new Error(`agentName must be the wallet's .ai Agent ID name, e.g. "alice.ai" (got "${p.agentName}")`);
  const repostUrl = String(p.repostUrl ?? "").trim();
  if (!/^https?:\/\/(www\.)?(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status(es)?\/\d{5,25}/i.test(repostUrl))
    throw new Error(`repostUrl must be the link of the quote/reply to the pinned post, e.g. https://x.com/<handle>/status/<id> (got "${p.repostUrl}")`);
  const ref = p.ref?.trim();
  return { xHandle, wallet, agentName, repostUrl, ...(ref ? { ref } : {}) };
}
