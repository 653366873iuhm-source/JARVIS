"""AgentPad backend API client (stdlib HTTP, no extra dependencies) + the agent-side EIP-712 payloads.

Mirrors ``sdk/src/api.ts`` and ``sdk/API_CONTRACT.md``. The platform uses **no X search and no paid X API**:
every post that matters (registration proof, launch-eligibility posts, promotion posts) is *submitted by URL*
and the backend looks each one up by id through free public lookups. A post that was never submitted does not
exist for the platform.

uint256 values travel as decimal strings and are returned unchanged (raw JSON dicts).
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List, Optional, Sequence

#: The backend serves every route under ``/v1``; the client paths themselves are unprefixed.
DEFAULT_API_URL = "https://agentpad-api.onrender.com/v1"  # BSC mainnet backend
LOCAL_API_URL = "http://localhost:8080/v1"
DEFAULT_TIMEOUT = 15.0

_POST_ID_RE = re.compile(r"^\d{5,25}$")
_POST_URL_RE = re.compile(r"(?:twitter\.com|x\.com)/[^/]+/status(?:es)?/(\d{5,25})", re.IGNORECASE)


class ApiError(Exception):
    """Non-2xx response. ``code`` comes from the ``{"error": {"code", "message"}}`` envelope ("http_error" otherwise)."""

    def __init__(self, status: int, code: str, message: str, body: Any = None):
        super().__init__(f"AgentPad API {status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.body = body


# --------------------------------------------------------------------------- helpers
def parse_post_id(url_or_id: str) -> Optional[str]:
    """Numeric X post id from ``https://x.com/<handle>/status/<id>`` (twitter.com, /statuses/ too) or a bare id."""
    v = str(url_or_id).strip()
    if _POST_ID_RE.match(v):
        return v
    m = _POST_URL_RE.search(v)
    return m.group(1) if m else None


def normalise_x_handle(handle: str) -> str:
    h = handle.strip()
    return (h[1:] if h.startswith("@") else h).lower()


def _domain(chain_id: int, registry: str) -> Dict[str, Any]:
    return {"name": "AgentPad", "version": "1", "chainId": int(chain_id), "verifyingContract": registry}


_DOMAIN_TYPE = [
    {"name": "name", "type": "string"},
    {"name": "version", "type": "string"},
    {"name": "chainId", "type": "uint256"},
    {"name": "verifyingContract", "type": "address"},
]

AGENT_BINDING_TYPES = [
    {"name": "agentId", "type": "string"},
    {"name": "wallet", "type": "address"},
    {"name": "xHandle", "type": "string"},
    {"name": "intent", "type": "string"},
    {"name": "challenge", "type": "string"},
    {"name": "issuedAt", "type": "uint256"},
    {"name": "expiresAt", "type": "uint256"},
]

#: EligibilityPosts(address wallet,string postIds,uint256 issuedAt) — must match backend/src/chain/eip712.ts.
ELIGIBILITY_POSTS_TYPES = [
    {"name": "wallet", "type": "address"},
    {"name": "postIds", "type": "string"},
    {"name": "issuedAt", "type": "uint256"},
]


def agent_binding_typed_data(*, chain_id: int, registry: str, agent_id: str, wallet: str, x_handle: str, intent: str,
                             challenge: str, issued_at: int, expires_at: int) -> Dict[str, Any]:
    """EIP-712 ``AgentBinding`` (Agent domain). Always built locally from the challenge fields, never signed blind."""
    return {
        "types": {"EIP712Domain": _DOMAIN_TYPE, "AgentBinding": AGENT_BINDING_TYPES},
        "primaryType": "AgentBinding",
        "domain": _domain(chain_id, registry),
        "message": {"agentId": agent_id, "wallet": wallet, "xHandle": x_handle, "intent": intent, "challenge": challenge,
                    "issuedAt": int(issued_at), "expiresAt": int(expires_at)},
    }


def eligibility_post_ids(post_urls: Iterable[str]) -> List[str]:
    ids = []
    for u in post_urls:
        pid = parse_post_id(u)
        if not pid:
            raise ValueError(f"not an X post URL: {u}")
        ids.append(pid)
    return ids


def eligibility_posts_typed_data(*, chain_id: int, registry: str, wallet: str, post_urls: Sequence[str],
                                 issued_at: int) -> Dict[str, Any]:
    """EIP-712 ``EligibilityPosts(wallet, postIds, issuedAt)`` (Agent domain). postIds = numeric ids comma-joined in
    submission order — exactly what the backend rebuilds from the submitted URLs."""
    return {
        "types": {"EIP712Domain": _DOMAIN_TYPE, "EligibilityPosts": ELIGIBILITY_POSTS_TYPES},
        "primaryType": "EligibilityPosts",
        "domain": _domain(chain_id, registry),
        "message": {"wallet": wallet, "postIds": ",".join(eligibility_post_ids(post_urls)), "issuedAt": int(issued_at)},
    }


def typed_data_digest(typed_data: Dict[str, Any]) -> bytes:
    """keccak256(0x1901 || domainSeparator || hashStruct(message)) — the digest the wallet signs."""
    from eth_account.messages import encode_typed_data
    from eth_utils import keccak

    m = encode_typed_data(full_message=typed_data)
    return keccak(b"\x19" + m.version + m.header + m.body)


def sign_typed_data(account, typed_data: Dict[str, Any]) -> str:
    """Sign with an eth_account LocalAccount; returns 0x-prefixed 65-byte hex."""
    from eth_account.messages import encode_typed_data

    sig = account.sign_message(encode_typed_data(full_message=typed_data)).signature
    h = sig.hex()
    return h if h.startswith("0x") else "0x" + h


def _drop_none(d: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


# --------------------------------------------------------------------------- client
class AgentPadApi:
    """Raw backend client. Every method returns the decoded JSON body (dict)."""

    def __init__(self, base_url: str = DEFAULT_API_URL, timeout: float = DEFAULT_TIMEOUT,
                 headers: Optional[Dict[str, str]] = None, opener=None):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.headers = dict(headers or {})
        self._open = opener or urllib.request.urlopen

    def request(self, method: str, path: str, body: Any = None, ok_statuses: Sequence[int] = ()) -> Dict[str, Any]:
        headers = {"accept": "application/json", **({"content-type": "application/json"} if body is not None else {}),
                   **self.headers}
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, method=method, headers=headers)
        try:
            with self._open(req, timeout=self.timeout) as res:
                status, text = res.status, res.read().decode()
        except urllib.error.HTTPError as e:
            status, text = e.code, e.read().decode()
            reason = e.reason
        else:
            reason = ""
        try:
            payload = json.loads(text) if text else None
        except ValueError:
            payload = {"raw": text}
        if not (200 <= status < 300) and status not in ok_statuses:
            err = payload.get("error") if isinstance(payload, dict) else None
            err = err if isinstance(err, dict) else {}
            raise ApiError(status, err.get("code") or "http_error", err.get("message") or str(reason), payload)
        return payload

    # 1
    def register_request(self, body: Dict[str, Any]) -> Dict[str, Any]:
        return self.request("POST", "/agents/register-request", _drop_none(body))

    # 2 — 200 ready / 202 pending / 403 rejected are values; 404 throws
    def registration_signature(self, agent_id: str, wallet: str) -> Dict[str, Any]:
        return self.request("GET", f"/agents/{urllib.parse.quote(agent_id, safe='')}/registration-signature?wallet={wallet}",
                            ok_statuses=(202, 403))

    # 3
    def list_projects(self, **params: Any) -> Dict[str, Any]:
        q = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        return self.request("GET", "/projects" + (f"?{q}" if q else ""))

    # 4
    def get_project(self, address: str) -> Dict[str, Any]:
        return self.request("GET", f"/projects/{address}")

    # 5
    def quote(self, address: str, side: str, count: int) -> Dict[str, Any]:
        return self.request("GET", f"/projects/{address}/quote?side={side}&count={int(count)}")

    # 6
    def rewards_proof(self, wallet: str) -> Dict[str, Any]:
        return self.request("GET", f"/rewards/{wallet}/proof")

    # 7
    def promotion_code(self, project: str, wallet: str) -> Dict[str, Any]:
        return self.request("POST", "/promotions/code", {"project": project, "wallet": wallet})

    # 8
    def submit_promotion(self, project: str, wallet: str, url: str) -> Dict[str, Any]:
        """POST /promotions/submit — the promoter's post URL (original, quote or reply with tag + code; plain
        retweets can't be verified, quote-post instead). Re-submitting the same URL is idempotent."""
        return self.request("POST", "/promotions/submit", {"project": project, "wallet": wallet, "url": url})

    # 9
    def submit_eligibility_posts(self, wallet: str, post_urls: Sequence[str], issued_at: int, signature: str) -> Dict[str, Any]:
        """POST /agents/eligibility-posts — replaces the stored launch-eligibility post set (wallet-signed)."""
        return self.request("POST", "/agents/eligibility-posts",
                            {"wallet": wallet, "postUrls": list(post_urls), "issuedAt": int(issued_at), "signature": signature})

    # ---- ChyAI airdrop -> credential -> mining (agent flow). Reads + payload helpers; no signing here.
    def config(self) -> Dict[str, Any]:
        return self.request("GET", "/config")

    def agent_flow(self, wallet: str) -> Dict[str, Any]:
        """GET /agent/flow?wallet= : every step (done/todo/waiting/blocked) with the exact next command."""
        return self.request("GET", f"/agent/flow?wallet={urllib.parse.quote(wallet)}")

    def agent_instructions(self) -> str:
        """GET /agent.md : the agent instructions (markdown)."""
        r = self.request("GET", "/agent.md")
        return r.get("raw", "") if isinstance(r, dict) else str(r or "")

    def airdrop_status(self, wallet: str) -> Dict[str, Any]:
        return self.request("GET", f"/airdrop/status?wallet={urllib.parse.quote(wallet)}")

    def airdrop_claim(self, x_handle: str, wallet: str, agent_name: str, repost_url: str, ref: Optional[str] = None) -> Dict[str, Any]:
        """POST /airdrop/claim (idempotent: 201 new, 200 existing)."""
        return self.request("POST", "/airdrop/claim", build_airdrop_claim(x_handle, wallet, agent_name, repost_url, ref))

    def mint_voucher(self, wallet: str) -> Dict[str, Any]:
        return self.request("GET", f"/airdrop/voucher?wallet={urllib.parse.quote(wallet)}")

    def mining(self, wallet: str) -> Dict[str, Any]:
        return self.request("GET", f"/mining/{urllib.parse.quote(wallet)}")

    def mining_stats(self) -> Dict[str, Any]:
        return self.request("GET", "/mining/stats")

    def mining_leaderboard(self) -> Dict[str, Any]:
        return self.request("GET", "/mining/leaderboard")

    def checkin(self, wallet: str, signature: str, signature_recovery: Optional[str] = None) -> Dict[str, Any]:
        """POST /mining/checkin with the EIP-712 signature from the user's wallet (409 already_checked_in is a value)."""
        return self.request("POST", "/mining/checkin", _drop_none({"wallet": wallet, "signType": "eip712", "signature": signature,
                                                                  "signatureRecovery": signature_recovery}), ok_statuses=(409,))

    def invites(self, wallet: str) -> Dict[str, Any]:
        return self.request("GET", f"/airdrop/invites/{urllib.parse.quote(wallet)}")


def build_airdrop_claim(x_handle: str, wallet: str, agent_name: str, repost_url: str, ref: Optional[str] = None) -> Dict[str, Any]:
    """Validate + normalise a ChyAI airdrop claim body. Raises ValueError on invalid input."""
    import re
    h = (x_handle or "").strip().lstrip("@")
    if not re.fullmatch(r"[A-Za-z0-9_]{1,15}", h):
        raise ValueError(f"invalid X handle: {x_handle}")
    w = (wallet or "").strip()
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", w):
        raise ValueError(f"invalid wallet address: {wallet}")
    n = (agent_name or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9-]{1,63}\.ai", n):
        raise ValueError(f"agentName must be a .ai Agent ID name: {agent_name}")
    u = (repost_url or "").strip()
    if not re.search(r"(?:twitter\.com|x\.com)/[^/]+/status(?:es)?/\d{5,25}", u, re.I):
        raise ValueError(f"repost_url must be an x.com status link: {repost_url}")
    body: Dict[str, Any] = {"xHandle": h, "wallet": w, "agentName": n, "repostUrl": u}
    if ref and ref.strip():
        body["ref"] = ref.strip()
    return body
