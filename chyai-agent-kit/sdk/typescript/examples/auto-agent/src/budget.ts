import { parseEther } from "viem";

export interface BudgetLimits {
  /** Max BNB ever deployed into one project (cost basis of held NFTs). */
  maxPerProjectWei: bigint;
  /** Max BNB deployed across all projects. */
  maxTotalWei: bigint;
  /** Max BNB spent in one loop iteration. */
  maxPerTickWei: bigint;
  /** Keep at least this much BNB in the wallet for gas. */
  gasReserveWei: bigint;
}

export function budgetFromEnv(env = process.env): BudgetLimits {
  return {
    maxPerProjectWei: parseEther(env.AGENT_MAX_BNB_PER_PROJECT ?? "0.05"),
    maxTotalWei: parseEther(env.AGENT_MAX_BNB_TOTAL ?? "0.3"),
    maxPerTickWei: parseEther(env.AGENT_MAX_BNB_PER_TICK ?? "0.05"),
    gasReserveWei: parseEther(env.AGENT_GAS_RESERVE_BNB ?? "0.01"),
  };
}

/** Tracks spend; `allowance()` returns how much may be spent on a project right now. */
export class Budget {
  private tickSpent = 0n;
  constructor(readonly limits: BudgetLimits) {}

  startTick() {
    this.tickSpent = 0n;
  }

  allowance(p: { projectDeployedWei: bigint; totalDeployedWei: bigint; walletBalanceWei: bigint }): bigint {
    const l = this.limits;
    const caps = [
      l.maxPerProjectWei - p.projectDeployedWei,
      l.maxTotalWei - p.totalDeployedWei,
      l.maxPerTickWei - this.tickSpent,
      p.walletBalanceWei - l.gasReserveWei,
    ];
    const m = caps.reduce((a, b) => (b < a ? b : a));
    return m > 0n ? m : 0n;
  }

  record(spentWei: bigint) {
    this.tickSpent += spentWei;
  }
}
