import { createHash } from "node:crypto";
import type { PromotionCodeResponse } from "./api.js";

/** Phrases that read as profit promises / financial advice. Posts containing them are rejected by lintPromotionPost. */
export const FORBIDDEN_PHRASES: RegExp[] = [
  /guarantee(d)?/i, /risk[- ]?free/i, /\b\d{2,}x\b/i, /\b(10|100|1000)x\b/i, /to the moon/i, /\bmoon(ing)?\b/i,
  /easy money/i, /free money/i, /passive income/i, /can'?t lose/i, /sure (thing|win)/i, /profit/i, /returns?\s+of/i,
  /\broi\b/i, /get rich/i, /buy now/i, /last chance/i, /pump/i,
  /保证/, /稳赚/, /必涨/, /暴富/, /翻倍/, /收益/, /躺赚/, /无风险/, /百倍/, /千倍/, /抄底/, /财富自由/,
];

export interface PromotionLint {
  ok: boolean;
  issues: string[];
  length: number;
}

/** X counts every URL as 23 chars. */
export function xLength(text: string): number {
  return [...text.replace(/https?:\/\/\S+/g, "x".repeat(23))].length;
}

/**
 * Checks a promotion post against AgentPad rules: contains the tag and the agent's code, ≤ 280 chars,
 * no profit promises, not a duplicate of an earlier post (pass previous post hashes).
 */
export function lintPromotionPost(text: string, code: Pick<PromotionCodeResponse, "code" | "tag" | "requiredText">, previousHashes: Iterable<string> = []): PromotionLint {
  const issues: string[] = [];
  for (const req of new Set([code.tag, code.code, ...(code.requiredText ?? [])])) {
    if (req && !text.toLowerCase().includes(req.toLowerCase())) issues.push(`missing required text "${req}"`);
  }
  const len = xLength(text);
  if (len > 280) issues.push(`too long for X (${len} > 280)`);
  for (const re of FORBIDDEN_PHRASES) if (re.test(text)) issues.push(`forbidden phrase (profit promise / advice): ${re}`);
  const h = postHash(text);
  for (const p of previousHashes) if (p === h) issues.push("duplicate of an earlier post");
  return { ok: issues.length === 0, issues, length: len };
}

/** Normalised hash used for duplicate detection (case/whitespace/punctuation-insensitive). */
export function postHash(text: string): string {
  const norm = text.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[\s\p{P}]+/gu, " ").trim();
  return createHash("sha256").update(norm).digest("hex");
}

/**
 * Builds a compliant default post from the project's own story. Agents should prefer writing their own text
 * (LLM) and running lintPromotionPost on it; this is the fallback.
 */
export function buildPromotionPost(p: { name: string; symbol: string; storyLine?: string; code: PromotionCodeResponse; agentVoice?: string }): string {
  const story = (p.storyLine ?? "").replace(/\s+/g, " ").trim();
  const head = p.agentVoice ?? `I'm holding ${p.name} ($${p.symbol}) on AgentPad.`;
  const tail = `${p.code.tag} ${p.code.code} ${p.code.link}\nNot financial advice. DYOR.`;
  let body = story ? `${head} ${story}` : head;
  while (xLength(`${body}\n${tail}`) > 280 && body.length > 20) body = body.slice(0, body.length - 10).trimEnd() + "…";
  return `${body}\n${tail}`;
}
