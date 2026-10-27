import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { normHandle, nowSec, parseTweetId } from "../lib/util.js";
import type { XPost, XProvider, XUser } from "../providers/x/types.js";

export interface EligibilityThresholds {
  minFollowers: number;
  minAccountAgeDays: number;
  minPosts30d: number;
  minEngagementBps: number; // average engagement rate, basis points (50 = 0.5%)
}

export interface EligibilityResult {
  eligible: boolean;
  followers: number;
  accountAgeDays: number;
  posts30d: number; // verified submitted posts by the agent created in the last 30 days
  engagementBps: number; // average per-post (likes+reposts+replies)/followers, in bps (2 decimals)
  reasons: string[];
  checkedAt: number;
  /** Post ids the result was computed from. */
  postIds?: string[];
  /** Submitted URLs that did not count, with why. */
  rejectedPosts?: { url: string; reason: string }[];
}

const WINDOW = 30 * 86400;

/**
 * Launch eligibility (ARCHITECTURE.md), with no paid X API:
 *   followers >= 5000 and account age (joined) >= 90 days — from the FxTwitter user lookup;
 *   >= 10 posts in the last 30 days and average engagement >= 0.5% — over the post URLs the agent SUBMITS
 *   (its own original posts / quotes / replies, reposts excluded), each looked up by id. A post's rate is
 *   (likes + reposts + replies) / followers; the average is over the counted posts.
 * `posts` must already be verified as authored by `user` (see verifyEligibilityPosts).
 */
export function computeEligibility(user: XUser, posts: XPost[], now: number, th: EligibilityThresholds, rejected: { url: string; reason: string }[] = []): EligibilityResult {
  const reasons: string[] = [];
  const accountAgeDays = Math.floor((now - user.createdAt) / 86400);
  const seen = new Set<string>();
  const counted = posts.filter((p) => !p.isRepost && p.createdAt >= now - WINDOW && p.createdAt <= now + 300 && !seen.has(p.id) && seen.add(p.id));
  const followers = user.followers;
  let engagementBps = 0;
  if (counted.length > 0 && followers > 0) {
    const sum = counted.reduce((s, p) => s + (p.likes + p.reposts + p.replies) / followers, 0);
    engagementBps = Math.round((sum / counted.length) * 10_000 * 100) / 100;
  }
  if (user.protected) reasons.push("account_protected");
  if (followers < th.minFollowers) reasons.push(`followers ${followers} < ${th.minFollowers}`);
  if (accountAgeDays < th.minAccountAgeDays) reasons.push(`account age ${accountAgeDays}d < ${th.minAccountAgeDays}d`);
  if (counted.length < th.minPosts30d)
    reasons.push(`submitted posts from the last 30d ${counted.length} < ${th.minPosts30d} (submit >= ${th.minPosts30d} of your own post URLs from the last 30 days)`);
  if (engagementBps < th.minEngagementBps) reasons.push(`avg engagement ${(engagementBps / 100).toFixed(2)}% < ${(th.minEngagementBps / 100).toFixed(2)}%`);
  return {
    eligible: reasons.length === 0, followers, accountAgeDays, posts30d: counted.length, engagementBps, reasons, checkedAt: now,
    postIds: counted.map((p) => p.id), rejectedPosts: rejected.length ? rejected : undefined,
  };
}

/**
 * Looks up submitted post URLs/ids and keeps the ones authored by `user`, not plain reposts, created in the last
 * 30 days. Returns the counted posts plus a reason for every URL that didn't count.
 */
export async function verifyEligibilityPosts(x: XProvider, user: XUser, urls: string[], now: number, maxUrls = 50) {
  const rejected: { url: string; reason: string }[] = [];
  const ids: { url: string; id: string }[] = [];
  const seen = new Set<string>();
  for (const url of urls.slice(0, maxUrls)) {
    const id = parseTweetId(String(url));
    if (!id) rejected.push({ url, reason: "not_a_post_url" });
    else if (seen.has(id)) rejected.push({ url, reason: "duplicate" });
    else {
      seen.add(id);
      ids.push({ url, id });
    }
  }
  for (const url of urls.slice(maxUrls)) rejected.push({ url, reason: `over_limit (max ${maxUrls})` });
  const posts: XPost[] = [];
  for (const { url, id } of ids) {
    const p = await x.getPost(id);
    if (!p) rejected.push({ url, reason: "not_found" });
    else if (!isAuthor(p, user)) rejected.push({ url, reason: `wrong_author (@${p.authorUsername})` });
    else if (p.isRepost) rejected.push({ url, reason: "repost" });
    else if (p.createdAt < now - WINDOW) rejected.push({ url, reason: "older_than_30d" });
    else posts.push(p);
  }
  return { posts, rejected };
}

/** Author check: same X user id when both sides have one, otherwise same handle (case-insensitive). */
export function isAuthor(p: XPost, user: { id?: string | null; username: string }) {
  if (p.authorId && user.id) return p.authorId === user.id;
  return normHandle(p.authorUsername) === normHandle(user.username);
}

/** Re-fetches the given post ids and recomputes eligibility (used by registration and the 30-day re-check). */
export async function checkEligibility(x: XProvider, user: XUser, postRefs: string[], now: number, th: EligibilityThresholds, maxUrls = 50): Promise<EligibilityResult> {
  const { posts, rejected } = await verifyEligibilityPosts(x, user, postRefs, now, maxUrls);
  return computeEligibility(user, posts, now, th, rejected);
}

export const thresholdsFromConfig = (cfg: {
  ELIG_MIN_FOLLOWERS: number;
  ELIG_MIN_ACCOUNT_AGE_DAYS: number;
  ELIG_MIN_POSTS_30D: number;
  ELIG_MIN_ENGAGEMENT_BPS: number;
}): EligibilityThresholds => ({
  minFollowers: cfg.ELIG_MIN_FOLLOWERS,
  minAccountAgeDays: cfg.ELIG_MIN_ACCOUNT_AGE_DAYS,
  minPosts30d: cfg.ELIG_MIN_POSTS_30D,
  minEngagementBps: cfg.ELIG_MIN_ENGAGEMENT_BPS,
});

// ------------------------------------------------------------------ stored eligibility posts (kv, no schema change)

export const eligKey = (wallet: string) => `eligposts:${wallet.toLowerCase()}`;

export interface StoredEligibilityPosts {
  postIds: string[];
  submittedAt: number;
}

export async function loadEligibilityPosts(ctx: AppContext, wallet: string): Promise<StoredEligibilityPosts | null> {
  const { db, t } = ctx.database;
  const [row] = await db.select().from(t.kv).where(eq(t.kv.key, eligKey(wallet)));
  return row ? (JSON.parse(row.value) as StoredEligibilityPosts) : null;
}

export async function saveEligibilityPosts(ctx: AppContext, wallet: string, postIds: string[]) {
  const { db, t } = ctx.database;
  const value = JSON.stringify({ postIds, submittedAt: nowSec() } satisfies StoredEligibilityPosts);
  await db.insert(t.kv).values({ key: eligKey(wallet), value }).onConflictDoUpdate({ target: t.kv.key, set: { value } });
}
