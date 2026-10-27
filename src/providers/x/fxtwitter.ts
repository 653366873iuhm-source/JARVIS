import { XRateLimitError, type XPost, type XProvider, type XUser } from "./types.js";

/**
 * Free public X lookups via FxTwitter (https://github.com/FixTweet/FxTwitter), no API key:
 *   GET {base}/<handle>          -> { code, message, user: { screen_name, id, followers, following, tweets, joined, protected, ... } }
 *   GET {base}/status/<id>       -> { code, message, tweet: { id, url, text, author: { screen_name, id, followers }, likes,
 *                                     retweets, replies, quotes, views, created_at, created_timestamp, quote?, replying_to_status?,
 *                                     reposted_by? } }
 * A missing user answers JSON {code:404}; a missing post answers an HTML page with HTTP 200 — both map to null.
 * There is no search / timeline: every post is submitted by URL (see DECISIONS.md D-X1).
 *
 * Politeness: one request at a time with at least `minIntervalMs` between request starts (~1 req/s), an in-memory
 * TTL cache, and retries with exponential backoff on 429 / 5xx / network errors (Retry-After honoured).
 */
export interface FxTwitterOptions {
  baseUrl?: string;
  minIntervalMs?: number; // default 1000
  cacheTtlSec?: number; // default 300 (0 disables)
  maxRetries?: number; // default 3
  backoffBaseMs?: number; // default 1000 (1s, 2s, 4s, ...)
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number; // ms clock
  timeoutMs?: number; // per request, default 10000
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const parseXDate = (s: unknown): number => {
  const ms = typeof s === "string" ? Date.parse(s) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
};

export function mapFxUser(u: any): XUser {
  return {
    id: String(u.id),
    username: String(u.screen_name),
    name: u.name,
    createdAt: parseXDate(u.joined),
    followers: Number(u.followers ?? 0),
    following: u.following !== undefined ? Number(u.following) : undefined,
    tweetCount: u.tweets !== undefined ? Number(u.tweets) : undefined,
    protected: !!u.protected,
  };
}

export function mapFxTweet(t: any): XPost {
  const createdAt = typeof t.created_timestamp === "number" ? t.created_timestamp : parseXDate(t.created_at);
  return {
    id: String(t.id),
    authorId: String(t.author?.id ?? ""),
    authorUsername: String(t.author?.screen_name ?? ""),
    authorFollowers: t.author?.followers !== undefined ? Number(t.author.followers) : undefined,
    text: String(t.text ?? t.raw_text?.text ?? ""),
    createdAt,
    likes: Number(t.likes ?? 0),
    reposts: Number(t.retweets ?? 0),
    replies: Number(t.replies ?? 0),
    quotes: Number(t.quotes ?? 0),
    impressions: typeof t.views === "number" ? t.views : undefined,
    isRepost: !!t.reposted_by,
    quoteOfId: t.quote?.id ? String(t.quote.id) : undefined,
    replyToId: t.replying_to_status ? String(t.replying_to_status) : undefined,
  };
}

class RetryableError extends Error {
  constructor(msg: string, readonly retryAfterMs?: number, readonly rateLimited = false) {
    super(msg);
  }
}

export class FxTwitterProvider implements XProvider {
  readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;
  /** Number of HTTP requests actually sent (tests/metrics). */
  requests = 0;

  constructor(o: FxTwitterOptions = {}) {
    this.baseUrl = (o.baseUrl ?? "https://api.fxtwitter.com").replace(/\/+$/, "");
    this.minIntervalMs = o.minIntervalMs ?? 1000;
    this.cacheTtlMs = (o.cacheTtlSec ?? 300) * 1000;
    this.maxRetries = o.maxRetries ?? 3;
    this.backoffBaseMs = o.backoffBaseMs ?? 1000;
    this.f = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? realSleep;
    this.now = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs ?? 10_000;
  }

  /** Drops cached entries (all, or one path). */
  clearCache(path?: string) {
    if (path) this.cache.delete(path);
    else this.cache.clear();
  }

  /** Serialises requests and spaces their starts by minIntervalMs. */
  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = this.lastStart + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
      return fn();
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async once(path: string): Promise<any | null> {
    this.requests++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.f(`${this.baseUrl}${path}`, { headers: { accept: "application/json", "user-agent": "agentpad-backend/1.0" }, signal: ctrl.signal });
    } catch (e: any) {
      throw new RetryableError(`fxtwitter ${path}: ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      throw new RetryableError(`fxtwitter ${path} HTTP ${res.status}`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined, res.status === 429);
    }
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      // FxTwitter answers an HTML "post doesn't exist" page for unknown statuses
      if (res.ok || res.status === 404) return null;
      throw new Error(`fxtwitter ${path} HTTP ${res.status}: non-JSON body`);
    }
    if (res.status === 404 || body?.code === 404 || body?.code === 401) return null;
    if (body?.code === 429 || (typeof body?.code === "number" && body.code >= 500)) throw new RetryableError(`fxtwitter ${path} code ${body.code}`, undefined, body.code === 429);
    if (!res.ok) throw new Error(`fxtwitter ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
    return body;
  }

  private async get(path: string): Promise<any | null> {
    const hit = this.cache.get(path);
    if (hit && this.cacheTtlMs > 0 && this.now() - hit.at < this.cacheTtlMs) return hit.value;
    let lastErr: RetryableError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const body = await this.schedule(() => this.once(path));
        if (this.cacheTtlMs > 0) this.cache.set(path, { at: this.now(), value: body });
        return body;
      } catch (e) {
        if (!(e instanceof RetryableError)) throw e;
        lastErr = e;
        if (attempt === this.maxRetries) break;
        await this.sleep(e.retryAfterMs ?? this.backoffBaseMs * 2 ** attempt);
      }
    }
    if (lastErr?.rateLimited) throw new XRateLimitError(Math.floor(this.now() / 1000) + 60);
    throw new Error(`${lastErr?.message ?? "fxtwitter request failed"} (after ${this.maxRetries + 1} attempts)`);
  }

  async getUserByUsername(username: string): Promise<XUser | null> {
    const h = username.trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
    const body = await this.get(`/${encodeURIComponent(h)}`);
    return body?.user?.screen_name ? mapFxUser(body.user) : null;
  }

  async getPost(id: string): Promise<XPost | null> {
    if (!/^\d{1,25}$/.test(id)) return null;
    const body = await this.get(`/status/${id}`);
    return body?.tweet?.id ? mapFxTweet(body.tweet) : null;
  }

  async getPosts(ids: string[]): Promise<XPost[]> {
    const out: XPost[] = [];
    for (const id of [...new Set(ids)]) {
      const p = await this.getPost(id);
      if (p) out.push(p);
    }
    return out;
  }
}
