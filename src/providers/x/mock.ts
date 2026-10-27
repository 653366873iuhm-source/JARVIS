import type { XPost, XProvider, XUser } from "./types.js";

/** In-memory X used by tests and local dev (X_PROVIDER=mock). Lookups by handle / post id only, like FxTwitter. */
export class MockXProvider implements XProvider {
  users = new Map<string, XUser>(); // key: lowercase username
  posts = new Map<string, XPost>();
  /** Every getPost id requested (tests assert re-fetches). */
  fetched: string[] = [];
  private seq = 1_800_000_000_000_000_000n;

  addUser(u: Partial<XUser> & { username: string }): XUser {
    const user: XUser = {
      id: u.id ?? String(this.users.size + 1000),
      createdAt: u.createdAt ?? Math.floor(Date.now() / 1000) - 400 * 86400,
      followers: u.followers ?? 10_000,
      protected: false,
      ...u,
    };
    this.users.set(u.username.toLowerCase(), user);
    return user;
  }

  addPost(p: Partial<XPost> & { authorUsername: string; text: string }): XPost {
    const u = this.users.get(p.authorUsername.toLowerCase());
    if (!u) throw new Error(`mock X: unknown user ${p.authorUsername}`);
    const post: XPost = {
      id: p.id ?? String(this.seq++),
      authorId: u.id,
      createdAt: Math.floor(Date.now() / 1000),
      likes: 0,
      reposts: 0,
      replies: 0,
      quotes: 0,
      ...p,
      authorUsername: u.username,
      authorFollowers: u.followers,
    };
    this.posts.set(post.id, post);
    return post;
  }

  /** URL of a mock post, as an agent would submit it. */
  url(p: XPost) {
    return `https://x.com/${p.authorUsername}/status/${p.id}`;
  }

  /** Adds `n` ordinary posts in the last 30 days with given engagement per post; returns their URLs. */
  seedActivity(username: string, n: number, engagementPerPost: number, now = Math.floor(Date.now() / 1000)): string[] {
    const urls: string[] = [];
    for (let i = 0; i < n; i++) {
      const p = this.addPost({ authorUsername: username, text: `gm post ${i} from ${username}`, createdAt: now - (i + 1) * 86400, likes: engagementPerPost });
      urls.push(this.url(p));
    }
    return urls;
  }

  async getUserByUsername(username: string) {
    return this.users.get(username.toLowerCase()) ?? null;
  }
  async getPost(id: string) {
    this.fetched.push(id);
    const p = this.posts.get(id);
    if (!p) return null;
    const u = [...this.users.values()].find((x) => x.id === p.authorId);
    return { ...p, authorFollowers: u?.followers ?? p.authorFollowers };
  }
  async getPosts(ids: string[]) {
    const out: XPost[] = [];
    for (const i of ids) {
      const p = await this.getPost(i);
      if (p) out.push(p);
    }
    return out;
  }
}
