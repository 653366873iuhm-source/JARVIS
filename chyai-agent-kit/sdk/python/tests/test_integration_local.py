"""Integration test against the local stage-2 stack (testnet/local-e2e/start-local.sh):
hardhat :8545 + backend :8080 (fxtwitter/binance-http providers) + mock X / Agent-ID services :8790.
Skipped unless all three answer. Covers register (X proof + eligibility posts by URL) -> launch -> buy ->
promotion code -> promotion submit (by URL) -> eligibility-posts re-submit.

    AGENTPAD_LOCAL_E2E=1 python3 -m pytest -q tests/test_integration_local.py   # fail instead of skip if down
"""
import json
import os
import secrets
import time
import urllib.request
from pathlib import Path

import pytest
from web3 import Web3
from web3.logs import DISCARD

from agentpad import AgentPad, AgentPadApi, ApiError

ROOT = Path(__file__).resolve().parents[3]
DEP_FILE = ROOT / "contracts/deployments/localhost.json"
RPC, API, MOCK = "http://127.0.0.1:8545", "http://127.0.0.1:8080/v1", "http://127.0.0.1:8790"
DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # hardhat #0 (public dev key)

_NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _http(method, url, body=None, timeout=3):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json"})
    with _NO_PROXY.open(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def _stack_up():
    try:
        _http("GET", "http://127.0.0.1:8080/health")
        _http("POST", RPC, {"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []})
        _http("GET", MOCK + "/__mock/stats")
        return DEP_FILE.exists()
    except Exception:
        return False


UP = _stack_up()
if not UP and os.environ.get("AGENTPAD_LOCAL_E2E") == "1":
    raise RuntimeError("AGENTPAD_LOCAL_E2E=1 but the local stack is not up")
pytestmark = pytest.mark.skipif(not UP, reason="local stack not up (testnet/local-e2e/start-local.sh)")


def mock(path, body):
    return _http("POST", MOCK + path, body)


@pytest.fixture(scope="module")
def env():
    dep = json.loads(DEP_FILE.read_text())
    w3 = Web3(Web3.HTTPProvider(RPC))
    addrs = {k: v for k, v in dep["contracts"].items()}
    api = AgentPadApi(API, opener=_NO_PROXY.open)
    deployer = w3.eth.account.from_key(DEPLOYER_PK)
    tag = secrets.token_hex(3)

    def agent(name, intent, followers, bnb):
        acct = w3.eth.account.create()
        h = w3.eth.send_transaction({"from": deployer.address, "to": acct.address, "value": w3.to_wei(bnb, "ether")}) \
            if deployer.address in w3.eth.accounts else None
        if h is None:  # node without unlocked accounts: sign locally
            tx = {"to": acct.address, "value": w3.to_wei(bnb, "ether"), "gas": 21000, "gasPrice": w3.eth.gas_price,
                  "nonce": w3.eth.get_transaction_count(deployer.address, "pending"), "chainId": w3.eth.chain_id}
            signed = deployer.sign_transaction(tx)
            h = w3.eth.send_raw_transaction(getattr(signed, "raw_transaction", None) or signed.rawTransaction)
        w3.eth.wait_for_transaction_receipt(h)
        handle = f"py{name}_{tag}"
        agent_id = f"py{name}{tag}.ai"
        now = int(time.time())
        mock("/__mock/user", {"username": handle, "followers": followers, "createdAt": now - 500 * 86400})
        mock("/__mock/agentid", {"agentId": agent_id, "address": acct.address})
        pad = AgentPad(w3=w3, private_key=acct.key.hex(), addresses=addrs, api=api)
        return {"pad": pad, "handle": handle, "agent_id": agent_id, "intent": intent}

    return {"w3": w3, "dep": dep, "api": api, "tag": tag,
            "L": agent("l", "launch", 25_000, 3), "B": agent("b", "trade", 800, 3), "state": {}}


def _own_posts(handle, n, days_back_from=1):
    now = int(time.time())
    return [mock("/__mock/post", {"authorUsername": handle, "text": f"py sdk alpha #{i} agents on BNB",
                                  "createdAt": now - (i + days_back_from) * 3600, "likes": 400 + i, "reposts": 40,
                                  "replies": 25})["url"] for i in range(n)]


def test_1_register_launcher_with_eligibility_posts(env):
    L = env["L"]
    elig = _own_posts(L["handle"], 12)
    posted = []

    def on_challenge(c):
        posted.append(c["code"])
        return mock("/__mock/post", {"authorUsername": L["handle"], "text": c["text"]})["url"]

    r = L["pad"].register(L["agent_id"], "@" + L["handle"].upper(), intent="launch", eligibility_post_urls=elig,
                          on_challenge=on_challenge, timeout=90, poll=1)
    assert posted, "backend should have asked for the X proof post"
    assert r["tx"] and r["status"]["canLaunch"] and r["status"]["canTrade"]
    again = L["pad"].register(L["agent_id"], L["handle"], intent="launch", eligibility_post_urls=elig)
    assert again["skipped"] is True


def test_2_register_trader_with_explicit_proof_url(env):
    B = env["B"]
    pad = B["pad"]
    req = pad.request_registration(B["agent_id"], B["handle"], intent="trade")
    assert req["status"] == "awaiting_x_proof"
    assert (req.get("reason") or "x_post_url_required").startswith("x_post_url_required")
    # wrong author: the proof post must come from the bound handle
    wrong = mock("/__mock/post", {"authorUsername": env["L"]["handle"], "text": req["xChallenge"]["text"]})["url"]
    bad = pad.request_registration(B["agent_id"], B["handle"], intent="trade", x_proof_post_url=wrong)
    assert bad["status"] != "approved" and "wrong_author" in (bad.get("reason") or ""), bad
    url = mock("/__mock/post", {"authorUsername": B["handle"], "text": req["xChallenge"]["text"]})["url"]
    r = pad.register(B["agent_id"], B["handle"], intent="trade", x_proof_post_url=url, timeout=90, poll=1)
    assert r["status"]["canTrade"] and not r["status"]["canLaunch"]


def test_3_launch_and_buy(env):
    L, B, w3 = env["L"]["pad"], env["B"]["pad"], env["w3"]
    sym = ("P" + env["tag"][:4]).upper()
    fn = L.contract("LaunchFactory").functions.launch(f"Py SDK {env['tag']}", sym, f"ipfs://bafypy{env['tag']}/")
    rc = L.wait(L._send(fn))
    ev = L.contract("LaunchFactory").events.Launched().process_receipt(rc, errors=DISCARD)
    project = ev[0]["args"]["project"]
    env["state"]["project"] = project
    q = B.quote_mint(project, 5)
    rc = B.wait(B.mint(project, 5, q["total"]))
    assert rc["status"] == 1
    assert len(B.owned_token_ids(project)) == 5
    deadline = time.time() + 60
    while time.time() < deadline:  # wait for the indexer before asking for a promotion code (holder check)
        try:
            d = env["api"].get_project(project)
            if any(h["wallet"].lower() == B.address.lower() for h in d.get("topHolders", [])):
                break
        except ApiError:
            pass
        time.sleep(1)
    api_q = env["api"].quote(project, "mint", 5)
    assert int(api_q["total"]) > 0


def test_4_promotion_code_and_submit(env):
    B = env["B"]
    pad, project = B["pad"], env["state"]["project"]
    code = pad.get_promotion_code(project)
    assert code["requiredText"]
    text = " ".join(code["requiredText"]) + " holding my py-sdk bag into the DEX"
    url = mock("/__mock/post", {"authorUsername": B["handle"], "text": text, "likes": 12, "reposts": 2})["url"]
    r = pad.submit_promotion(project, None, url)
    assert r["tweetId"] == url.rsplit("/", 1)[1]
    assert r["kind"] == "original" and r["wallet"].lower() == pad.address.lower()
    assert r["status"] in ("stored", "accepted")
    assert r["metrics"]["likes"] == 12
    r2 = pad.submit_promotion_post(project, url)  # idempotent re-submit
    assert r2["tweetId"] == r["tweetId"]
    env["state"]["promo"] = r
    # a post without the code is refused
    no_code = mock("/__mock/post", {"authorUsername": B["handle"], "text": "just vibes, no code"})["url"]
    with pytest.raises(ApiError) as e:
        pad.submit_promotion(project, None, no_code)
    assert e.value.status == 422 and e.value.code in ("missing_tag", "missing_code")
    # a post by someone else is refused
    other = mock("/__mock/post", {"authorUsername": env["L"]["handle"], "text": text})["url"]
    with pytest.raises(ApiError) as e:
        pad.submit_promotion(project, None, other)
    assert (e.value.status, e.value.code) == (422, "wrong_author")


def test_5_submit_eligibility_posts(env):
    L = env["L"]["pad"]
    fresh = _own_posts(env["L"]["handle"], 10)
    r = L.submit_eligibility_posts(fresh)
    assert r["wallet"].lower() == L.address.lower()
    assert r["eligibility"]["eligible"] is True, r
    assert r["eligibility"].get("postIds", [])[:1] == [fresh[0].rsplit("/", 1)[1]]
    with pytest.raises(ApiError) as e:  # stale issuedAt
        L.submit_eligibility_posts(fresh, issued_at=int(time.time()) - 3600)
    assert e.value.code == "stale_signature"
