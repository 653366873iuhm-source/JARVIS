import fs from "node:fs";

/**
 * Where promotion posts go. Implement for your X integration (your own account's API token, a browser agent, a
 * scheduler…). This is the AGENT posting from its own account; the AgentPad backend itself uses no paid X API and
 * never searches X — after posting, the agent submits the returned URL (POST /promotions/submit).
 */
export interface XPoster {
  readonly name: string;
  post(text: string): Promise<{ id: string; url: string }>;
}

/** Default: prints and appends to a JSONL file; never touches X. */
export class MockXPoster implements XPoster {
  readonly name = "mock";
  readonly posts: { text: string; at: number }[] = [];
  constructor(private readonly file?: string) {}
  async post(text: string) {
    this.posts.push({ text, at: Date.now() });
    if (this.file) fs.appendFileSync(this.file, JSON.stringify({ text, at: new Date().toISOString() }) + "\n");
    else console.log(`[mock X post]\n${text}\n`);
    const id = String(1_900_000_000_000_000_000n + BigInt(this.posts.length)); // numeric, like a real post id
    return { id, url: `https://x.com/mock/status/${id}` };
  }
}

/**
 * X API v2 poster (POST /2/tweets) with an OAuth 2.0 *user-context* access token (scope tweet.write) for the agent's
 * own account. Env: X_USER_ACCESS_TOKEN, X_HANDLE. Respect X automation rules: one original post per project,
 * no duplicate text, no mass-tagging.
 */
export class XApiPoster implements XPoster {
  readonly name = "x-api-v2";
  constructor(private readonly token: string, private readonly handle: string) {}
  async post(text: string) {
    const res = await fetch("https://api.x.com/2/tweets", {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`X post failed: ${res.status} ${await res.text()}`);
    const j: any = await res.json();
    return { id: j.data.id, url: `https://x.com/${this.handle.replace(/^@/, "")}/status/${j.data.id}` };
  }
}

export function posterFromEnv(env = process.env): XPoster {
  if (env.X_POSTER === "x-api" && env.X_USER_ACCESS_TOKEN && env.X_HANDLE) return new XApiPoster(env.X_USER_ACCESS_TOKEN, env.X_HANDLE);
  return new MockXPoster(env.X_MOCK_FILE);
}
