import type { Config } from "../config.js";

/**
 * CORS origin policy from CORS_ORIGINS (comma-separated). Entries: exact origins ("https://app.example.com"),
 * wildcard subdomains ("https://*.vercel.app"), or "*" (any). Unset: any origin outside production; in production
 * only PUBLIC_APP_URL's origin. Requests without an Origin header (curl, agents, server-to-server) are always allowed.
 */
export function parseCorsOrigins(cfg: Pick<Config, "CORS_ORIGINS" | "NODE_ENV" | "PUBLIC_APP_URL">): "*" | (string | RegExp)[] {
  const raw = cfg.CORS_ORIGINS?.trim();
  if (!raw) {
    if (cfg.NODE_ENV !== "production") return "*";
    try {
      return [new URL(cfg.PUBLIC_APP_URL).origin];
    } catch {
      return [];
    }
  }
  const parts = raw.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  if (parts.includes("*")) return "*";
  return parts.map((p) => (p.includes("*") ? new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+")}$`, "i") : p));
}

export function isOriginAllowed(origin: string | undefined, policy: "*" | (string | RegExp)[]): boolean {
  if (!origin || policy === "*") return true;
  return policy.some((p) => (typeof p === "string" ? p.toLowerCase() === origin.toLowerCase() : p.test(origin)));
}

/** @fastify/cors `origin` option. */
export function corsOrigin(cfg: Pick<Config, "CORS_ORIGINS" | "NODE_ENV" | "PUBLIC_APP_URL">) {
  const policy = parseCorsOrigins(cfg);
  if (policy === "*") return true;
  return (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => cb(null, isOriginAllowed(origin, policy));
}
