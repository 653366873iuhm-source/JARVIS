import { BPS, MAX_CURVE_NFTS, TOKENS_PER_NFT, VIRTUAL_BNB0, VIRTUAL_TOKEN0 } from "./constants.js";

/** Curve state needed to quote: virtual reserves, live NFT supply and the project's frozen fee rate. */
export interface CurveState {
  virtualBnb: bigint; // x
  virtualToken: bigint; // y
  totalSupply: bigint; // live NFTs on the curve
  feeBps: bigint; // e.g. 100n = 1%
}

export interface MintQuote {
  count: bigint;
  cost: bigint; // BNB into the curve
  fee: bigint; // 1% on top
  total: bigint; // cost + fee = exact msg.value needed
  newVirtualBnb: bigint;
  /** Average price per NFT including fee. */
  avgPerNft: bigint;
}

export interface BurnQuote {
  count: bigint;
  gross: bigint; // BNB out of the curve
  fee: bigint; // 1% deducted
  net: bigint; // gross - fee = what the seller receives
  newVirtualBnb: bigint;
  avgPerNft: bigint;
}

export class CurveError extends Error {}

/** ceil(a * b / d) — identical to OpenZeppelin Math.mulDiv(a, b, d, Rounding.Ceil). */
export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new CurveError("division by zero");
  const p = a * b;
  return p / d + (p % d === 0n ? 0n : 1n);
}

export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b) / d;
}

export function initialCurveState(feeBps: bigint = 100n): CurveState {
  return { virtualBnb: VIRTUAL_BNB0, virtualToken: VIRTUAL_TOKEN0, totalSupply: 0n, feeBps };
}

/**
 * Exact replica of BondingNFT._quoteBuy / quoteMint:
 *   newX = ceil(x*y / (y - n*80k)), cost = newX - x, fee = ceil(cost*feeBps/1e4).
 * Throws like the contract's quoteMint when count is 0 or exceeds the remaining supply.
 */
export function quoteMint(state: CurveState, count: bigint | number): MintQuote {
  const n = BigInt(count);
  if (n <= 0n || n > MAX_CURVE_NFTS - state.totalSupply) throw new CurveError(`BadAmount: count ${n} (remaining ${MAX_CURVE_NFTS - state.totalSupply})`);
  const x = state.virtualBnb;
  const y = state.virtualToken;
  const newX = mulDivCeil(x, y, y - n * TOKENS_PER_NFT);
  const cost = newX - x;
  const fee = mulDivCeil(cost, state.feeBps, BPS);
  const total = cost + fee;
  return { count: n, cost, fee, total, newVirtualBnb: newX, avgPerNft: total / n };
}

/**
 * Exact replica of BondingNFT._quoteSell / quoteBurn:
 *   newX = ceil(x*y / (y + n*80k)), gross = x - newX, fee = ceil(gross*feeBps/1e4), net = gross - fee.
 */
export function quoteBurn(state: CurveState, count: bigint | number): BurnQuote {
  const n = BigInt(count);
  if (n <= 0n || n > state.totalSupply) throw new CurveError(`BadAmount: count ${n} (supply ${state.totalSupply})`);
  const x = state.virtualBnb;
  const y = state.virtualToken;
  const newX = mulDivCeil(x, y, y + n * TOKENS_PER_NFT);
  const gross = x - newX;
  const fee = mulDivCeil(gross, state.feeBps, BPS);
  const net = gross - fee;
  return { count: n, gross, fee, net, newVirtualBnb: newX, avgPerNft: net / n };
}

/** State after a mint, exactly as the contract updates it. */
export function applyMint(state: CurveState, q: MintQuote): CurveState {
  return { ...state, virtualBnb: q.newVirtualBnb, virtualToken: state.virtualToken - q.count * TOKENS_PER_NFT, totalSupply: state.totalSupply + q.count };
}

export function applyBurn(state: CurveState, q: BurnQuote): CurveState {
  return { ...state, virtualBnb: q.newVirtualBnb, virtualToken: state.virtualToken + q.count * TOKENS_PER_NFT, totalSupply: state.totalSupply - q.count };
}

/** Spot price in wei per whole token (1e18 units) — BondingNFT.spotPrice(). */
export function spotPrice(state: CurveState): bigint {
  return mulDivFloor(state.virtualBnb, 10n ** 18n, state.virtualToken);
}

/** Spot price of one NFT (80,000 tokens) in wei, excluding fees. Informational (marginal price). */
export function spotPricePerNft(state: CurveState): bigint {
  return mulDivFloor(state.virtualBnb, TOKENS_PER_NFT, state.virtualToken);
}

/** Real BNB raised so far (== BondingNFT.reserveBnb while trading). */
export function raised(state: CurveState): bigint {
  return state.virtualBnb - VIRTUAL_BNB0;
}

/** Progress towards sell-out in bps (10,000 = sold out). */
export function progressBps(state: CurveState): number {
  return Number((state.totalSupply * BPS) / MAX_CURVE_NFTS);
}

/** Largest n such that quoteMint(n).total <= budget (binary search; respects remaining supply and maxN). */
export function maxMintForBudget(state: CurveState, budgetWei: bigint, maxN: bigint = MAX_CURVE_NFTS): bigint {
  let hi = MAX_CURVE_NFTS - state.totalSupply;
  if (maxN < hi) hi = maxN;
  let lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (quoteMint(state, mid).total <= budgetWei) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** Add slippage tolerance (bps) to an amount, rounding up. */
export function withSlippageUp(amount: bigint, bps: bigint): bigint {
  return mulDivCeil(amount, BPS + bps, BPS);
}

/** Subtract slippage tolerance (bps) from an amount, rounding down. */
export function withSlippageDown(amount: bigint, bps: bigint): bigint {
  return mulDivFloor(amount, BPS - bps, BPS);
}
