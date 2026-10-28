"""Exact integer port of sdk/src/curve.ts (BondingNFT bonding-curve math)."""
from __future__ import annotations

from dataclasses import dataclass, replace

TOKENS_PER_NFT = 80_000 * 10**18
MAX_CURVE_NFTS = 10_000
CURVE_TOKENS = TOKENS_PER_NFT * MAX_CURVE_NFTS
LP_TOKENS = 200_000_000 * 10**18
VIRTUAL_BNB0 = 7_142_857_142_857_142_857
VIRTUAL_TOKEN0 = 1_085_714_285_714 * 10**15
BPS = 10_000
MAX_PER_TX = 100
DEFAULT_SLIPPAGE_BPS = 50

# Trading-fee split (bps of the 1% fee), mirrors sdk/src/constants.ts and BondingNFT._distributeFee.
LAUNCHER_SHARE_BPS = 3000  # 30% -> launcher
REWARD_SHARE_BPS = 2000  # 20% -> promotion RewardPool
CHARITY_SHARE_BPS = 2000  # 20% -> Binance Charity (LaunchFactory.CHARITY_SHARE_BPS)
PLATFORM_SHARE_BPS = BPS - LAUNCHER_SHARE_BPS - REWARD_SHARE_BPS - CHARITY_SHARE_BPS  # 30% -> treasury
BINANCE_CHARITY = "0x8B99F3660622e21f2910ECCA7fBe51d654a1517D"


def split_fee(fee: int, launcher_bps: int = LAUNCHER_SHARE_BPS, reward_bps: int = REWARD_SHARE_BPS,
              charity_bps: int = CHARITY_SHARE_BPS) -> dict:
    """Split one trading fee exactly like the contract (floor per share, remainder to the platform)."""
    launcher = fee * launcher_bps // BPS
    reward = fee * reward_bps // BPS
    charity = fee * charity_bps // BPS
    return {"launcher": launcher, "reward": reward, "charity": charity, "platform": fee - launcher - reward - charity}


class CurveError(ValueError):
    pass


@dataclass(frozen=True)
class CurveState:
    virtual_bnb: int  # x
    virtual_token: int  # y
    total_supply: int  # live NFTs on the curve
    fee_bps: int = 100


@dataclass(frozen=True)
class MintQuote:
    count: int
    cost: int
    fee: int
    total: int  # exact msg.value needed
    new_virtual_bnb: int
    avg_per_nft: int


@dataclass(frozen=True)
class BurnQuote:
    count: int
    gross: int
    fee: int
    net: int
    new_virtual_bnb: int
    avg_per_nft: int


def mul_div_ceil(a: int, b: int, d: int) -> int:
    if d == 0:
        raise CurveError("division by zero")
    p = a * b
    return p // d + (0 if p % d == 0 else 1)


def mul_div_floor(a: int, b: int, d: int) -> int:
    return (a * b) // d


def initial_curve_state(fee_bps: int = 100) -> CurveState:
    return CurveState(VIRTUAL_BNB0, VIRTUAL_TOKEN0, 0, fee_bps)


def quote_mint(count: int, state: CurveState) -> MintQuote:
    n = int(count)
    remaining = MAX_CURVE_NFTS - state.total_supply
    if n <= 0 or n > remaining:
        raise CurveError(f"BadAmount: count {n} (remaining {remaining})")
    x, y = state.virtual_bnb, state.virtual_token
    new_x = mul_div_ceil(x, y, y - n * TOKENS_PER_NFT)
    cost = new_x - x
    fee = mul_div_ceil(cost, state.fee_bps, BPS)
    total = cost + fee
    return MintQuote(n, cost, fee, total, new_x, total // n)


def quote_burn(count: int, state: CurveState) -> BurnQuote:
    n = int(count)
    if n <= 0 or n > state.total_supply:
        raise CurveError(f"BadAmount: count {n} (supply {state.total_supply})")
    x, y = state.virtual_bnb, state.virtual_token
    new_x = mul_div_ceil(x, y, y + n * TOKENS_PER_NFT)
    gross = x - new_x
    fee = mul_div_ceil(gross, state.fee_bps, BPS)
    net = gross - fee
    return BurnQuote(n, gross, fee, net, new_x, net // n)


def apply_mint(state: CurveState, q: MintQuote) -> CurveState:
    return replace(state, virtual_bnb=q.new_virtual_bnb,
                   virtual_token=state.virtual_token - q.count * TOKENS_PER_NFT,
                   total_supply=state.total_supply + q.count)


def apply_burn(state: CurveState, q: BurnQuote) -> CurveState:
    return replace(state, virtual_bnb=q.new_virtual_bnb,
                   virtual_token=state.virtual_token + q.count * TOKENS_PER_NFT,
                   total_supply=state.total_supply - q.count)


def spot_price(state: CurveState) -> int:
    return mul_div_floor(state.virtual_bnb, 10**18, state.virtual_token)


def spot_price_per_nft(state: CurveState) -> int:
    return mul_div_floor(state.virtual_bnb, TOKENS_PER_NFT, state.virtual_token)


def raised(state: CurveState) -> int:
    return state.virtual_bnb - VIRTUAL_BNB0


def progress_bps(state: CurveState) -> int:
    return (state.total_supply * BPS) // MAX_CURVE_NFTS


def max_mint_for_budget(state: CurveState, budget_wei: int, max_n: int = MAX_CURVE_NFTS) -> int:
    hi = min(MAX_CURVE_NFTS - state.total_supply, max_n)
    lo = 0
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if quote_mint(mid, state).total <= budget_wei:
            lo = mid
        else:
            hi = mid - 1
    return lo


def with_slippage_up(amount: int, bps: int) -> int:
    return mul_div_ceil(amount, BPS + bps, BPS)


def with_slippage_down(amount: int, bps: int) -> int:
    return mul_div_floor(amount, BPS - bps, BPS)
