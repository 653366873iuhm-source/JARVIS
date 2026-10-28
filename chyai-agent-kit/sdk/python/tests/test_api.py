"""Backend API client + agent-side EIP-712 payloads (free X verification flow: posts are submitted by URL)."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data
from web3 import Web3

from agentpad import (AgentPad, AgentPadApi, ApiError, RegistrationError, agent_binding_typed_data,
                      eligibility_posts_typed_data, normalise_x_handle, parse_post_id, sign_typed_data,
                      typed_data_digest)

FIX = json.loads((Path(__file__).parent / "fixtures/eip712.json").read_text())
ACCT = Account.from_key(FIX["privateKey"])
REGISTRY = "0x5FbDB2315678afecb367f032d93F642f64180aa3"


def _td(c):
    if c["kind"] == "EligibilityPosts":
        return eligibility_posts_typed_data(chain_id=c["chainId"], registry=c["registry"], wallet=c["wallet"],
                                            post_urls=c["postUrls"], issued_at=c["issuedAt"])
    return agent_binding_typed_data(chain_id=c["chainId"], registry=c["registry"], agent_id=c["agentId"], wallet=c["wallet"],
                                    x_handle=c["xHandle"], intent=c["intent"], challenge=c["challenge"],
                                    issued_at=c["issuedAt"], expires_at=c["expiresAt"])


IDS = [f'{c["kind"]}-{c["chainId"]}' for c in FIX["cases"]]


# ------------------------------------------------------------------ EIP-712 parity with backend/src/chain/eip712.ts
@pytest.mark.parametrize("case", FIX["cases"], ids=IDS)
def test_digest_matches_backend(case):
    assert "0x" + typed_data_digest(_td(case)).hex() == case["digest"]


@pytest.mark.parametrize("case", FIX["cases"], ids=IDS)
def test_signature_matches_backend_and_recovers(case):
    td = _td(case)
    sig = sign_typed_data(ACCT, td)
    assert sig == case["signature"]  # RFC6979: deterministic, byte-identical to viem
    assert Account.recover_message(encode_typed_data(full_message=td), signature=sig) == case["wallet"]


def test_eligibility_post_ids_order_and_join():
    case = next(c for c in FIX["cases"] if c["kind"] == "EligibilityPosts")
    assert _td(case)["message"]["postIds"] == case["postIds"]
    assert [t["name"] for t in _td(case)["types"]["EligibilityPosts"]] == ["wallet", "postIds", "issuedAt"]


def test_eligibility_rejects_non_post_url():
    with pytest.raises(ValueError, match="not an X post URL"):
        eligibility_posts_typed_data(chain_id=1, registry=REGISTRY, wallet=ACCT.address,
                                     post_urls=["https://x.com/someone"], issued_at=1)


@pytest.mark.parametrize("raw,want", [
    ("https://x.com/a_b/status/1900000000000000001", "1900000000000000001"),
    ("https://twitter.com/A/statuses/123456?s=20", "123456"),
    ("  1234567890 ", "1234567890"),
    ("https://x.com/a/status/12", None),
    ("https://x.com/home", None),
    ("1234", None),
])
def test_parse_post_id(raw, want):
    assert parse_post_id(raw) == want


def test_normalise_x_handle():
    assert normalise_x_handle("  @Pancake_Chef ") == "pancake_chef"
    assert normalise_x_handle("ABC") == "abc"


# ------------------------------------------------------------------ HTTP client against a stub backend
class Stub:
    def __init__(self):
        self.calls = []
        self.routes = {}  # (method, path-without-query) -> fn(body, query) -> (status, json)
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _go(self, method):
                n = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(n)) if n else None
                path, _, query = self.path.partition("?")
                stub.calls.append({"method": method, "path": path, "query": query, "body": body,
                                   "ctype": self.headers.get("content-type"), "accept": self.headers.get("accept")})
                fn = stub.routes.get((method, path))
                status, out = fn(body, query) if fn else (404, {"error": {"code": "not_found", "message": f"{method} {path}"}})
                raw = (out if isinstance(out, str) else json.dumps(out)).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                self._go("GET")

            def do_POST(self):
                self._go("POST")

        self.srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_port}/v1"


@pytest.fixture
def stub():
    s = Stub()
    yield s
    s.srv.shutdown()


PROJECT = "0x" + "ab" * 20


def test_submit_promotion_wire(stub):
    resp = {"tweetId": "1900000000000000009", "url": "https://x.com/a/status/1900000000000000009", "project": PROJECT,
            "wallet": ACCT.address, "kind": "quote", "status": "stored", "similarTo": None, "shareBps": None,
            "metrics": {"likes": 1, "reposts": 0, "replies": 0, "quotes": 0}}
    stub.routes[("POST", "/v1/promotions/submit")] = lambda b, q: (200, resp)
    r = AgentPadApi(stub.url).submit_promotion(PROJECT, ACCT.address, resp["url"])
    assert r == resp
    c = stub.calls[-1]
    assert c["body"] == {"project": PROJECT, "wallet": ACCT.address, "url": resp["url"]}
    assert c["ctype"] == "application/json" and c["accept"] == "application/json"


@pytest.mark.parametrize("code", ["wrong_author", "missing_tag", "missing_code", "repost_unverifiable", "not_an_agent"])
def test_submit_promotion_422_raises(stub, code):
    stub.routes[("POST", "/v1/promotions/submit")] = lambda b, q: (422, {"error": {"code": code, "message": "nope"}})
    with pytest.raises(ApiError) as e:
        AgentPadApi(stub.url).submit_promotion(PROJECT, ACCT.address, "https://x.com/a/status/123456")
    assert (e.value.status, e.value.code) == (422, code)


def test_flat_error_is_http_error(stub):
    stub.routes[("GET", "/v1/projects")] = lambda b, q: (500, {"error": "boom"})
    with pytest.raises(ApiError) as e:
        AgentPadApi(stub.url).list_projects(limit=1)
    assert e.value.code == "http_error" and stub.calls[-1]["query"] == "limit=1"


def test_registration_signature_values_and_encoding(stub):
    stub.routes[("GET", "/v1/agents/pancake%2Fchef.ai/registration-signature")] = lambda b, q: (202, {"status": "pending", "requestStatus": "verifying", "retryAfter": 1})
    stub.routes[("GET", "/v1/agents/x.ai/registration-signature")] = lambda b, q: (403, {"status": "rejected", "reason": "x_post_wrong_author"})
    api = AgentPadApi(stub.url)
    assert api.registration_signature("pancake/chef.ai", ACCT.address)["status"] == "pending"
    assert api.registration_signature("x.ai", ACCT.address)["reason"] == "x_post_wrong_author"
    with pytest.raises(ApiError) as e:
        api.registration_signature("missing.ai", ACCT.address)
    assert e.value.code == "not_found"


def _pad(stub, chain_id=31337):
    return AgentPad(w3=Web3(), private_key=FIX["privateKey"], addresses={"AgentRegistry": REGISTRY},
                    api=stub.url, chain_id=chain_id)


def test_submit_eligibility_posts_signs_backend_payload(stub):
    stub.routes[("POST", "/v1/agents/eligibility-posts")] = lambda b, q: (200, {"wallet": b["wallet"], "launchEnabled": True, "requalified": True,
                                                                                "eligibility": {"eligible": True, "reasons": []}})
    urls = [f"https://x.com/pancake_chef/status/{1900000000000000100 + i}" for i in range(10)]
    r = _pad(stub).submit_eligibility_posts(urls, issued_at=1761560000)
    assert r["requalified"] is True
    body = stub.calls[-1]["body"]
    assert body["wallet"] == ACCT.address and body["postUrls"] == urls and body["issuedAt"] == 1761560000
    # what backend/src/services/registration.ts rebuilds: ids parsed from the URLs, comma-joined, checksummed wallet
    td = {"types": {"EIP712Domain": [{"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                                     {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}],
                    "EligibilityPosts": [{"name": "wallet", "type": "address"}, {"name": "postIds", "type": "string"},
                                         {"name": "issuedAt", "type": "uint256"}]},
          "primaryType": "EligibilityPosts",
          "domain": {"name": "AgentPad", "version": "1", "chainId": 31337, "verifyingContract": REGISTRY},
          "message": {"wallet": ACCT.address, "postIds": ",".join(u.rsplit("/", 1)[1] for u in urls), "issuedAt": 1761560000}}
    assert Account.recover_message(encode_typed_data(full_message=td), signature=body["signature"]) == ACCT.address


def _register_routes(stub, state):
    def rr(b, q):
        state.append(b)
        status = "awaiting_wallet_signature" if "walletSignature" not in b else ("approved" if b.get("xProofTweetUrl") else "awaiting_x_proof")
        return 200, {"requestId": "r1", "agentId": b["agentId"], "wallet": b["wallet"], "xHandle": b["xHandle"], "intent": b["intent"],
                     "status": status, "binding": {"challenge": "chal-1", "issuedAt": 1761560000, "expiresAt": 1761560900},
                     "xChallenge": {"code": "AP-XYZ", "text": "Verifying my agent on @AgentPad AP-XYZ", "expiresAt": 1761560900}}
    stub.routes[("POST", "/v1/agents/register-request")] = rr


def test_register_requires_proof_post_url_no_x_search(stub, monkeypatch):
    seen = []
    _register_routes(stub, seen)
    pad = _pad(stub)
    monkeypatch.setattr(pad, "get_agent", lambda wallet=None: {"canTrade": False, "agentIdHash": "0x", "expiry": 0})
    with pytest.raises(RegistrationError, match="does not search X"):
        pad.register("pancakechef.ai", "@Pancake_Chef", intent="trade")


def test_register_flow_sends_proof_and_eligibility_urls(stub, monkeypatch):
    seen = []
    _register_routes(stub, seen)
    stub.routes[("GET", "/v1/agents/pancakechef.ai/registration-signature")] = lambda b, q: (200, {"status": "ready", "registry": REGISTRY, "chainId": 31337})
    pad = _pad(stub)
    monkeypatch.setattr(pad, "get_agent", lambda wallet=None: {"canTrade": False, "agentIdHash": "0x", "expiry": 0})
    monkeypatch.setattr(pad, "submit_registration", lambda sig: "0xtx")
    monkeypatch.setattr(pad, "wait", lambda h: None)
    elig = [f"https://x.com/pancake_chef/status/{1900000000000000200 + i}" for i in range(10)]
    posted = []
    r = pad.register("pancakechef.ai", "@Pancake_Chef", intent="launch", eligibility_post_urls=elig,
                     on_challenge=lambda c: posted.append(c["text"]) or "https://x.com/pancake_chef/status/1900000000000000999")
    assert r["tx"] == "0xtx" and posted == ["Verifying my agent on @AgentPad AP-XYZ"]
    final = seen[-1]
    assert final["xProofTweetUrl"] == "https://x.com/pancake_chef/status/1900000000000000999"
    assert final["eligibilityPostUrls"] == elig and final["xHandle"] == "pancake_chef" and final["chainId"] == 31337
    assert "xProofTweetUrl" not in seen[0] and "walletSignature" not in seen[0]  # phase 1 has no nulls on the wire
    td = agent_binding_typed_data(chain_id=31337, registry=REGISTRY, agent_id="pancakechef.ai", wallet=ACCT.address,
                                  x_handle="pancake_chef", intent="launch", challenge="chal-1", issued_at=1761560000,
                                  expires_at=1761560900)
    assert Account.recover_message(encode_typed_data(full_message=td), signature=final["walletSignature"]) == ACCT.address


def test_promotion_helpers_default_to_own_wallet(stub):
    stub.routes[("POST", "/v1/promotions/submit")] = lambda b, q: (200, {"status": "stored", **b})
    stub.routes[("POST", "/v1/promotions/code")] = lambda b, q: (200, {"requiredText": ["#AP_CHEF", "C0DE"], **b})
    pad = _pad(stub)
    assert pad.get_promotion_code(PROJECT)["wallet"] == ACCT.address
    assert pad.submit_promotion(PROJECT, None, "123456789")["wallet"] == ACCT.address
    assert pad.submit_promotion_post(PROJECT, "123456789")["project"] == Web3.to_checksum_address(PROJECT)


def test_no_x_search_or_paid_api_in_package():
    pkg = Path(__file__).resolve().parents[1] / "agentpad"
    src = "\n".join(p.read_text().lower() for p in pkg.glob("*.py"))
    for bad in ("api.twitter.com", "api.x.com", "/2/tweets/search", "search/recent", "bearer_token", "x_bearer"):
        assert bad not in src
