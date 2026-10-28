/** Template constants of BondingNFT (fixed for every project launched from the v1 template). */
export const TOKENS_PER_NFT = 80_000n * 10n ** 18n;
export const MAX_CURVE_NFTS = 10_000n;
export const CURVE_TOKENS = TOKENS_PER_NFT * MAX_CURVE_NFTS;
export const LP_TOKENS = 200_000_000n * 10n ** 18n;
export const VIRTUAL_BNB0 = 7_142_857_142_857_142_857n;
export const VIRTUAL_TOKEN0 = 1_085_714_285_714n * 10n ** 15n;
export const BPS = 10_000n;
export const MAX_PER_TX = 100n;
export const LAUNCHER_MAX_NFTS = 500n;
export const ANTI_SNIPE_DURATION = 300n;
export const ANTI_SNIPE_MAX_PER_TX = 20n;
export const ANTI_SNIPE_MAX_PER_WALLET = 50n;
export const PROMOTION_WINDOW = 3600n;
export const PROMOTION_MAX = 7200n;
export const PROMOTION_THRESHOLD_BPS = 5000;
export const HOLDER_LOCK = 86_400n;
export const LAUNCHER_LOCK = 7n * 86_400n;
export const DEAD = "0x000000000000000000000000000000000000dEaD" as const;

/** Trading fee (curve mint/burn) and its split, in bps of the fee (frozen per project at launch). */
export const FEE_BPS = 100n; // 1%
export const LAUNCHER_SHARE_BPS = 3000n; // 30% of fee = 0.3% of volume
export const REWARD_SHARE_BPS = 2000n; // 20% -> promotion RewardPool
export const CHARITY_SHARE_BPS = 2000n; // 20% -> Binance Charity (LaunchFactory.CHARITY_SHARE_BPS)
export const PLATFORM_SHARE_BPS = BPS - LAUNCHER_SHARE_BPS - REWARD_SHARE_BPS - CHARITY_SHARE_BPS; // 30% treasury
/** Binance Charity main wallet on BSC (immutable FeeSplitter.charity on mainnet). */
export const BINANCE_CHARITY = "0x8B99F3660622e21f2910ECCA7fBe51d654a1517D" as const;

/** Split one trading fee exactly like BondingNFT._distributeFee (floor per share, remainder to the platform). */
export function splitFee(fee: bigint, s: { launcherShareBps?: bigint; rewardShareBps?: bigint; charityShareBps?: bigint } = {}) {
  const launcher = (fee * (s.launcherShareBps ?? LAUNCHER_SHARE_BPS)) / BPS;
  const reward = (fee * (s.rewardShareBps ?? REWARD_SHARE_BPS)) / BPS;
  const charity = (fee * (s.charityShareBps ?? CHARITY_SHARE_BPS)) / BPS;
  return { launcher, reward, charity, platform: fee - launcher - reward - charity };
}

/** Default slippage tolerance for mint (extra msg.value, refunded) and burn (minOut), in bps. */
export const DEFAULT_SLIPPAGE_BPS = 50n;

export enum Phase {
  Trading = 0,
  Promotion = 1,
  Graduated = 2,
}

/** BondingNFT.promotionStage(): 0 trading, 1 first hour, 2 extension hour, 3 graduation can be forced, 4 graduated. */
export enum PromotionStage {
  Trading = 0,
  FirstHour = 1,
  ExtensionHour = 2,
  Forceable = 3,
  Graduated = 4,
}

/** Known deployments. Filled in after mainnet/testnet deploy (contracts/deployments/<network>.json). */
export interface Deployment {
  chainId: number;
  AgentRegistry: `0x${string}`;
  LaunchFactory: `0x${string}`;
  FeeSplitter: `0x${string}`;
  RewardPool: `0x${string}`;
  TraitRandomness?: `0x${string}`;
  /** Block the factory was deployed in (lower bound for log scans). */
  fromBlock?: bigint;
}

/** BNB Smart Chain mainnet (chainId 56), deployed 2026-10-27 via CREATE2; sources verified (exact match) on Sourcify. */
export const BSC_MAINNET: Deployment = {
  chainId: 56,
  AgentRegistry: "0x9cfCb9fAa10A09f632d83C28a5DDaF044455c650",
  LaunchFactory: "0x1CaC41417B38388e72Dc02430f47e6dF96810702",
  FeeSplitter: "0xeb41B157e8D832B0338F28d496ecFc088308C368",
  RewardPool: "0x323C8F0FAD41dBc1B66E964d45dED28a88243E95",
  TraitRandomness: "0xe2811cb8Ec035B62EB0161738EADB07750B47cDf",
  fromBlock: 130114130n,
};

/**
 * BondingNFT templates on BSC mainnet. Projects launched after the factory switch (2026-10-29) are clones of v2,
 * whose `sell(uint256[],uint256)` exit passes Binance Agentic Wallet risk checks; v1 projects only have `burn`.
 * The SDK picks the path from the project's on-chain `VERSION()` (v1 has none → 1).
 */
export const BONDING_NFT_TEMPLATES = {
  v1: "0x21247fE7781D1e44C11aD67fdDd792162dD952b9",
  v2: "0xDbAaF18C1Dc7945840Bb84D7360564876594d971",
} as const;

export const DEPLOYMENTS: Record<number, Deployment | undefined> = {
  56: BSC_MAINNET,
  // 97: testnet not deployed
};
