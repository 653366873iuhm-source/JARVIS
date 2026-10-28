/**
 * Cross-check: every error name the Binance agent skill documents (sdk/skill/agentpad/SKILL.md + references/*.md)
 * must exist — PascalCase names as contract custom errors (or SDK pre-check errors), snake_case names as backend
 * API error codes / promotion-gate statuses / registration statuses / CLI codes. Also checks ERROR_HINTS keys.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ALL_ERRORS_ABI, ERROR_HINTS, SDK_CHECK_ERRORS } from "../src/errors.js";

const SKILL = path.resolve(__dirname, "../skill/agentpad");
const BACKEND_SRC = path.resolve(__dirname, "../../backend/src");
const docs = [path.join(SKILL, "SKILL.md"), ...fs.readdirSync(path.join(SKILL, "references")).map((f) => path.join(SKILL, "references", f))];
const text = docs.map((f) => fs.readFileSync(f, "utf8")).join("\n");
const ticked = [...new Set([...text.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]))];

const contractErrors = new Set((ALL_ERRORS_ABI as readonly any[]).map((e) => e.name));
const sdkErrors = new Set<string>(SDK_CHECK_ERRORS);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith(".ts") ? [path.join(dir, d.name)] : []));
}
const backendText = walk(BACKEND_SRC).map((f) => fs.readFileSync(f, "utf8")).join("\n");
const apiCodes = new Set([...backendText.matchAll(/ApiError\(\s*\d+\s*,\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
// generic codes from the fastify error handler
for (const c of ["validation_error", "internal_error", "not_found"]) apiCodes.add(c);
const gateStatuses = new Set(["stored", "accepted", "duplicate_text", "agent_already_counted", "not_holder", "no_code", "too_early", "excluded"]);
const regStatuses = new Set(["awaiting_wallet_signature", "awaiting_x_proof", "verifying", "approved", "rejected"]);
const cliCodes = new Set(["needs_confirmation", "already_exempt"]);

// backticked words that are not error names (commands, fields, env vars, struct/contract names)
const PASCAL_NON_ERRORS = new Set(["AgentPad", "AgentRegistry", "AgentBinding", "EligibilityPosts", "BondingNFT", "LaunchFactory", "RewardPool", "FeeSplitter"]);
const isPascal = (w: string) => /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$|^[A-Z][a-z]+$/.test(w) && !/^[A-Z0-9_]+$/.test(w);
const isSnakeCode = (w: string) => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(w);

describe("skill error names", () => {
  it("backend source scan found the API codes", () => {
    expect(apiCodes.size).toBeGreaterThan(30);
    for (const c of ["not_registered", "wrong_author", "x_post_url_required", "tweet_not_found"]) expect(apiCodes).toContain(c);
  });

  it("every PascalCase error in the skill is a contract custom error or an SDK pre-check error", () => {
    const bad = ticked.filter((w) => isPascal(w) && !PASCAL_NON_ERRORS.has(w) && !contractErrors.has(w) && !sdkErrors.has(w));
    expect(bad).toEqual([]);
  });

  it("every snake_case code in the skill is a backend API code, gate/registration status or CLI code", () => {
    const known = (w: string) => apiCodes.has(w) || gateStatuses.has(w) || regStatuses.has(w) || cliCodes.has(w);
    const bad = ticked.filter((w) => isSnakeCode(w) && !known(w));
    expect(bad).toEqual([]);
  });

  it("the error table lists the errors an agent actually hits", () => {
    for (const w of ["NotAgent", "NotLauncher", "Cooldown", "AntiSnipeLimit", "LauncherCap", "InsufficientPayment", "Slippage", "Locked", "needs_confirmation", "not_registered"]) {
      expect(ticked).toContain(w);
    }
  });

  it("ERROR_HINTS only names real errors", () => {
    const bad = Object.keys(ERROR_HINTS).filter((k) => !contractErrors.has(k) && !sdkErrors.has(k));
    expect(bad).toEqual([]);
  });
});
