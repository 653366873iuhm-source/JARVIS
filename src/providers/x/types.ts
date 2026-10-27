export interface XUser {
  id: string;
  username: string; // as returned by X (case preserved)
  name?: string;
  createdAt: number; // unix seconds (account "joined")
  followers: number;
  following?: number;
  tweetCount?: number;
  protected?: boolean;
}

export interface XPost {
  id: string;
  authorId: string;
  authorUsername: string; // screen_name of the author (case preserved)
  authorFollowers?: number;
  text: string; // the post's own text (for a quote post: the quoting text, not the quoted one)
  createdAt: number; // unix seconds
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  impressions?: number;
  /** A plain repost (retweet) — carries no text of its own, so it can't carry a code. */
  isRepost?: boolean;
  /** Set when this post quotes another post. */
  quoteOfId?: string;
  /** Set when this post is a reply. */
  replyToId?: string;
}

export class XRateLimitError extends Error {
  constructor(readonly resetAt: number) {
    super(`X data source rate limited until ${new Date(resetAt * 1000).toISOString()}`);
  }
}

/**
 * Abstraction over public X data. Implementations: FxTwitterProvider (free public lookups, default) and an
 * in-memory mock. There is deliberately no search or timeline method: AgentPad uses no paid X API, so every post
 * that matters (registration proof, eligibility posts, promotion posts) is submitted by URL and looked up by id.
 */
export interface XProvider {
  getUserByUsername(username: string): Promise<XUser | null>;
  getPost(id: string): Promise<XPost | null>;
  /** Looks up several posts by id; missing/deleted posts are omitted. */
  getPosts(ids: string[]): Promise<XPost[]>;
}
