/**
 * Test data hidden from PUBLIC views (config HIDE_PROJECTS / HIDE_WALLETS; defaults = the mainnet smoke-test
 * projects and wallet). Nothing is deleted: the indexer keeps every row, a hidden project's own page and the admin
 * endpoints still work. Applies to: project lists (home), ticker / live activity, WebSocket trade pushes,
 * leaderboards (agents, mining points, invites) and the platform stats counters.
 */
import type { AppContext } from "../context.js";
import { lc } from "../lib/util.js";

type Cfg = Pick<AppContext["cfg"], "HIDE_PROJECTS" | "HIDE_WALLETS">;

export const isHiddenProject = (cfg: Cfg, address: string | null | undefined) => !!address && (cfg.HIDE_PROJECTS ?? []).includes(lc(address));
export const isHiddenWallet = (cfg: Cfg, wallet: string | null | undefined) => !!wallet && (cfg.HIDE_WALLETS ?? []).includes(lc(wallet));
/** A trade / activity row is hidden when its project or its wallet is on the hide list. */
export const isHiddenActivity = (cfg: Cfg, project: string | null | undefined, wallet: string | null | undefined) =>
  isHiddenProject(cfg, project) || isHiddenWallet(cfg, wallet);
