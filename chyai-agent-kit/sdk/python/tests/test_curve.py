import json
from pathlib import Path

import pytest

from agentpad import CurveError, CurveState, initial_curve_state, load_abi, quote_burn, quote_mint, spot_price
from agentpad.curve import MAX_CURVE_NFTS, VIRTUAL_BNB0

FIXTURE = Path(__file__).resolve().parents[3] / "frontend/src/lib/__fixtures__/contract-quotes.json"
CASES = json.loads(FIXTURE.read_text())


def _state(c):
    s = c["state"]
    return CurveState(int(s["virtualBnb"]), int(s["virtualToken"]), int(s["totalSupply"]), int(s["feeBps"]))


MINT = [(c["label"], c, int(n), q) for c in CASES for n, q in c["quotes"]["mint"].items()]
BURN = [(c["label"], c, int(n), q) for c in CASES for n, q in c["quotes"]["burn"].items()]


@pytest.mark.parametrize("label,case,n,q", MINT, ids=[f"{m[0]}-mint{m[2]}" for m in MINT])
def test_mint_matches_contract(label, case, n, q):
    r = quote_mint(n, _state(case))
    assert (r.cost, r.fee, r.total) == (int(q["cost"]), int(q["fee"]), int(q["total"]))


@pytest.mark.parametrize("label,case,n,q", BURN, ids=[f"{b[0]}-burn{b[2]}" for b in BURN])
def test_burn_matches_contract(label, case, n, q):
    r = quote_burn(n, _state(case))
    assert (r.gross, r.fee, r.net) == (int(q["gross"]), int(q["fee"]), int(q["net"]))


@pytest.mark.parametrize("case", CASES, ids=[c["label"] for c in CASES])
def test_spot_and_reserve(case):
    s = _state(case)
    assert spot_price(s) == int(case["spotPrice"])
    assert s.virtual_bnb - VIRTUAL_BNB0 == int(case["reserveBnb"])


def test_bad_amounts():
    s = initial_curve_state()
    with pytest.raises(CurveError):
        quote_mint(0, s)
    with pytest.raises(CurveError):
        quote_mint(MAX_CURVE_NFTS + 1, s)
    with pytest.raises(CurveError):
        quote_burn(1, s)


def test_abi_function_names():
    names = {f["name"] for f in load_abi("BondingNFT") if f.get("type") == "function"}
    assert {"mint", "burn", "quoteMint", "quoteBurn", "virtualBnb", "virtualToken", "totalSupply", "feeBps"} <= names


def test_fee_split_includes_charity():
    from agentpad.curve import BINANCE_CHARITY, CHARITY_SHARE_BPS, PLATFORM_SHARE_BPS, split_fee
    assert CHARITY_SHARE_BPS == 2000 and PLATFORM_SHARE_BPS == 3000
    assert BINANCE_CHARITY == "0x8B99F3660622e21f2910ECCA7fBe51d654a1517D"
    assert split_fee(1_000_003) == {"launcher": 300_000, "reward": 200_000, "charity": 200_000, "platform": 300_003}


def test_fee_splitter_abi_has_charity():
    names = {e.get("name") for e in load_abi("FeeSplitter")}
    assert {"charity", "totalDonated", "totalFlushed", "charityBalance", "flushCharity", "CharityCredited", "CharityFlushed"} <= names
