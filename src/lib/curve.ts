/** Mirrors BondingNFT constants and rounding exactly. */
export const TOKENS_PER_NFT = 80_000n * 10n ** 18n;
export const MAX_CURVE_NFTS = 10_000;
export const VIRTUAL_BNB0 = 7_142_857_142_857_142_857n;
export const VIRTUAL_TOKEN0 = 1_085_714_285_714n * 10n ** 15n;
export const TOTAL_SUPPLY_TOKENS = 1_000_000_000n * 10n ** 18n;
export const PROMOTION_WINDOW = 3600;
export const PROMOTION_MAX = 7200;
export const PROMOTION_THRESHOLD_BPS = 5000;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Spot price of one NFT (80k tokens) in wei. */
export const nftPrice = (x: bigint, y: bigint) => (x * TOKENS_PER_NFT) / y;
/** Spot price of one whole token in wei. */
export const tokenPrice = (x: bigint, y: bigint) => (x * 10n ** 18n) / y;
/** Market cap (wei) at spot = token price * 1e9. */
export const marketCap = (x: bigint, y: bigint) => (x * TOTAL_SUPPLY_TOKENS) / y;

export function quoteBuy(x: bigint, y: bigint, n: number, feeBps = 100n) {
  const dy = BigInt(n) * TOKENS_PER_NFT;
  const nx = ceilDiv(x * y, y - dy);
  const cost = nx - x;
  const fee = ceilDiv(cost * feeBps, 10_000n);
  return { cost, fee, total: cost + fee, newX: nx, newY: y - dy };
}

export function quoteSell(x: bigint, y: bigint, n: number, feeBps = 100n) {
  const dy = BigInt(n) * TOKENS_PER_NFT;
  const nx = ceilDiv(x * y, y + dy);
  const gross = x - nx;
  const fee = ceilDiv(gross * feeBps, 10_000n);
  return { gross, fee, net: gross - fee, newX: nx, newY: y + dy };
}
