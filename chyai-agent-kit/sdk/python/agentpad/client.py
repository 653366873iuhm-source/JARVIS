"""Thin web3.py client for AgentPad BondingNFT projects."""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from importlib import resources
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Union

from web3 import Web3

from .api import (AgentPadApi, agent_binding_typed_data, eligibility_posts_typed_data, normalise_x_handle,
                  sign_typed_data)
from .curve import CurveState

_ABI_CACHE: Dict[str, list] = {}


def load_abi(name: str) -> list:
    if name not in _ABI_CACHE:
        raw = json.loads(resources.files("agentpad").joinpath(f"abi/{name}.json").read_text())
        _ABI_CACHE[name] = raw["abi"] if isinstance(raw, dict) else raw
    return _ABI_CACHE[name]


@dataclass(frozen=True)
class ProjectInfo:
    address: str
    name: str
    symbol: str
    token: str
    launcher: str
    phase: int  # 0 Trading, 1 Promotion, 2 Graduated
    promotion_stage: int
    virtual_bnb: int
    virtual_token: int
    total_supply: int
    reserve_bnb: int
    fee_bps: int
    spot_price: int
    next_token_id: int
    launch_time: int

    @property
    def curve_state(self) -> CurveState:
        return CurveState(self.virtual_bnb, self.virtual_token, self.total_supply, self.fee_bps)


def agent_id_hash(agent_id: str) -> bytes:
    return Web3.keccak(text=agent_id)


def x_handle_hash(handle: str) -> bytes:
    return Web3.keccak(text=normalise_x_handle(handle))


class RegistrationError(RuntimeError):
    pass


# Known deployments (contracts/deployments/<network>.json). BSC mainnet: CREATE2, sources verified on Sourcify.
BSC_MAINNET: Dict[str, Any] = {
    "chainId": 56,
    "AgentRegistry": "0x9cfCb9fAa10A09f632d83C28a5DDaF044455c650",
    "LaunchFactory": "0x1CaC41417B38388e72Dc02430f47e6dF96810702",
    "FeeSplitter": "0xeb41B157e8D832B0338F28d496ecFc088308C368",
    "RewardPool": "0x323C8F0FAD41dBc1B66E964d45dED28a88243E95",
    "TraitRandomness": "0xe2811cb8Ec035B62EB0161738EADB07750B47cDf",
    "fromBlock": 130114130,
}
DEPLOYMENTS: Dict[int, Dict[str, Any]] = {56: BSC_MAINNET}
# BondingNFT templates (BSC mainnet): v2 clones have sell(uint256[],uint256); v1 clones only burn.
BONDING_NFT_TEMPLATES: Dict[str, str] = {
    "v1": "0x21247fE7781D1e44C11aD67fdDd792162dD952b9",
    "v2": "0xDbAaF18C1Dc7945840Bb84D7360564876594d971",
}


class AgentPad:
    """addresses: dict of deployment addresses (e.g. {"LaunchFactory": "0x..", "AgentRegistry": "0x..", ...});
    defaults to DEPLOYMENTS[chain_id] (BSC mainnet = 56) when omitted.

    api: an :class:`AgentPadApi` or a base URL (e.g. "http://localhost:8080/v1"); needed for registration,
    promotion codes / post submission and eligibility posts. chain_id: optional override (else read from RPC).
    """

    def __init__(self, rpc_url: Optional[str] = None, private_key: Optional[str] = None,
                 addresses: Optional[Dict[str, str]] = None, w3: Optional[Web3] = None,
                 api: Union[AgentPadApi, str, None] = None, chain_id: Optional[int] = None):
        self.w3 = w3 or Web3(Web3.HTTPProvider(rpc_url))
        self.addresses = dict(addresses or {})
        self.account = self.w3.eth.account.from_key(private_key) if private_key else None
        self.api = AgentPadApi(api) if isinstance(api, str) else api
        self._chain_id = chain_id

    def _default_addresses(self) -> None:
        if not self.addresses:
            dep = DEPLOYMENTS.get(self.chain_id)
            if dep:
                self.addresses = {k: v for k, v in dep.items() if isinstance(v, str) and v.startswith("0x")}

    @property
    def address(self) -> str:
        return self._addr()

    @property
    def chain_id(self) -> int:
        if self._chain_id is None:
            self._chain_id = int(self.w3.eth.chain_id)
        return self._chain_id

    @property
    def registry(self) -> str:
        self._default_addresses()
        if "AgentRegistry" not in self.addresses:
            raise RuntimeError("addresses['AgentRegistry'] required")
        return Web3.to_checksum_address(self.addresses["AgentRegistry"])

    # ---- contracts -------------------------------------------------------
    def contract(self, name: str, address: Optional[str] = None):
        if not address:
            self._default_addresses()
        addr = address or self.addresses[name]
        return self.w3.eth.contract(address=Web3.to_checksum_address(addr), abi=load_abi(name))

    def bonding(self, project: str):
        return self.contract("BondingNFT", project)

    # ---- reads -----------------------------------------------------------
    def get_project(self, addr: str) -> ProjectInfo:
        c = self.bonding(addr).functions
        return ProjectInfo(
            address=Web3.to_checksum_address(addr),
            name=c.name().call(), symbol=c.symbol().call(),
            token=c.token().call(), launcher=c.launcher().call(),
            phase=c.phase().call(), promotion_stage=c.promotionStage().call(),
            virtual_bnb=c.virtualBnb().call(), virtual_token=c.virtualToken().call(),
            total_supply=c.totalSupply().call(), reserve_bnb=c.reserveBnb().call(),
            fee_bps=c.feeBps().call(), spot_price=c.spotPrice().call(),
            next_token_id=c.nextTokenId().call(), launch_time=c.launchTime().call(),
        )

    def quote_mint(self, project: str, count: int) -> Dict[str, int]:
        cost, fee, total = self.bonding(project).functions.quoteMint(int(count)).call()
        return {"cost": cost, "fee": fee, "total": total}

    def quote_burn(self, project: str, count: int) -> Dict[str, int]:
        gross, fee, net = self.bonding(project).functions.quoteBurn(int(count)).call()
        return {"gross": gross, "fee": fee, "net": net}

    def owned_token_ids(self, project: str, owner: Optional[str] = None, from_block: Union[int, str] = 0) -> List[int]:
        """Token IDs currently owned, found via Transfer logs then confirmed with ownerOf."""
        owner = Web3.to_checksum_address(owner or self._addr())
        c = self.bonding(project)
        logs = c.events.Transfer().get_logs(from_block=from_block, argument_filters={"to": owner})
        ids = sorted({int(l["args"]["tokenId"]) for l in logs})
        out = []
        for tid in ids:
            try:
                if c.functions.ownerOf(tid).call() == owner:
                    out.append(tid)
            except Exception:  # burned / nonexistent
                pass
        return out

    # ---- writes ----------------------------------------------------------
    def mint(self, project: str, count: int, max_cost: int, **tx) -> str:
        """Mint `count` NFTs sending `max_cost` wei as msg.value (excess is refunded by the contract)."""
        fn = self.bonding(project).functions.mint(int(count))
        return self._send(fn, value=int(max_cost), **tx)

    def project_version(self, project: str) -> int:
        """BondingNFT template version: 2 = v2 template (has ``sell``), 1 = original (no ``VERSION()``)."""
        try:
            return int(self.bonding(project).functions.VERSION().call())
        except Exception:
            return 1

    def _exit_ids(self, project: str, count: Union[int, Sequence[int]]) -> List[int]:
        if isinstance(count, int):
            owned = self.owned_token_ids(project)
            if len(owned) < count:
                raise ValueError(f"only {len(owned)} NFTs owned, asked to sell {count}")
            return sorted(owned, reverse=True)[:count]
        return [int(t) for t in count]

    def sell(self, project: str, count: Union[int, Sequence[int]], min_out: int, **tx) -> str:
        """Sell NFTs back to the curve (recommended exit). `count` is a number (sells that many owned IDs, highest
        first) or an explicit list of token IDs. Uses ``sell(uint256[],uint256)`` on v2 projects (passes Binance
        Agentic Wallet risk checks) and ``burn`` on v1 projects. Reverts with Slippage if net < min_out."""
        token_ids = self._exit_ids(project, count)
        c = self.bonding(project).functions
        fn = c.sell(token_ids, int(min_out)) if self.project_version(project) >= 2 else c.burn(token_ids, int(min_out))
        return self._send(fn, **tx)

    def burn(self, project: str, count: Union[int, Sequence[int]], min_out: int, **tx) -> str:
        """Deprecated alias of :meth:`sell` (also uses ``sell`` on v2 projects)."""
        return self.sell(project, count, min_out, **tx)

    def quote_sell(self, project: str, count: int) -> Dict[str, int]:
        """Same numbers as quote_burn (v2 also exposes quoteSell)."""
        return self.quote_burn(project, count)

    def wait(self, tx_hash: str, timeout: int = 120):
        return self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=timeout)

    # ---- registration (no X search: the proof post is submitted by URL) --
    def get_agent(self, wallet: Optional[str] = None) -> Dict[str, Any]:
        w = Web3.to_checksum_address(wallet or self._addr())
        reg = self.contract("AgentRegistry").functions
        agent_id, handle, expiry, _cl, _ct = reg.agents(w).call()
        return {"wallet": w, "registered": agent_id != b"\x00" * 32, "agentIdHash": "0x" + bytes(agent_id).hex(),
                "xHandleHash": "0x" + bytes(handle).hex(), "expiry": int(expiry),
                "canLaunch": reg.canLaunch(w).call(), "canTrade": reg.canTrade(w).call()}

    def request_registration(self, agent_id: str, x_handle: str, intent: str = "launch",
                             x_proof_post_url: Optional[str] = None,
                             eligibility_post_urls: Optional[Sequence[str]] = None) -> Dict[str, Any]:
        """POST /agents/register-request twice: get the binding challenge, then send the wallet's EIP-712
        AgentBinding signature plus the X proof post URL (the post containing ``xChallenge.code``) and, for
        intent=launch, >= 10 of the agent's own post URLs from the last 30 days."""
        api = self._require_api()
        wallet = self._addr()
        handle = normalise_x_handle(x_handle)
        base = {"agentId": agent_id, "wallet": wallet, "xHandle": handle, "chainId": self.chain_id, "intent": intent}
        first = api.register_request(base)
        if first.get("status") in ("rejected", "approved"):
            return first
        b = first.get("binding") or {}
        if not b.get("challenge"):
            raise RegistrationError("register-request: server returned no binding challenge")
        if first["wallet"].lower() != wallet.lower() or first["agentId"] != agent_id:
            raise RegistrationError("register-request: server echoed a different agentId/wallet")
        td = agent_binding_typed_data(chain_id=self.chain_id, registry=self.registry, agent_id=agent_id, wallet=wallet,
                                      x_handle=handle, intent=intent, challenge=b["challenge"],
                                      issued_at=b["issuedAt"], expires_at=b["expiresAt"])
        return api.register_request({
            **base, "challenge": b["challenge"], "issuedAt": b["issuedAt"], "expiresAt": b["expiresAt"],
            "walletSignature": sign_typed_data(self.account, td), "xProofTweetUrl": x_proof_post_url,
            "eligibilityPostUrls": list(eligibility_post_urls) if eligibility_post_urls else None,
        })

    def wait_for_registration_signature(self, agent_id: str, timeout: float = 600, poll: float = 5,
                                        wallet: Optional[str] = None) -> Dict[str, Any]:
        api = self._require_api()
        wallet = wallet or self._addr()
        deadline = time.time() + timeout
        while True:
            r = api.registration_signature(agent_id, wallet)
            if r.get("status") == "ready":
                return r
            if r.get("status") == "rejected":
                raise RegistrationError(f"registration rejected: {r.get('reason')}")
            if time.time() > deadline:
                raise RegistrationError(f"registration still pending ({r.get('requestStatus')}) after timeout")
            time.sleep(max(0.5, min(float(r.get("retryAfter") or 5), poll)))

    def submit_registration(self, sig: Dict[str, Any], **tx) -> str:
        """Relay the platform signature to AgentRegistry.register."""
        if sig["registry"].lower() != self.registry.lower():
            raise RegistrationError(f"signature is for registry {sig['registry']}, not {self.registry}")
        if int(sig["chainId"]) != self.chain_id:
            raise RegistrationError(f"signature is for chain {sig['chainId']}, connected to {self.chain_id}")
        fn = self.contract("AgentRegistry").functions.register(
            sig["agentId"], Web3.to_checksum_address(sig["wallet"]), bytes.fromhex(sig["xHandleHash"][2:]),
            bool(sig["canLaunch"]), bool(sig["canTrade"]), int(sig["expiry"]), int(sig["deadline"]),
            bytes.fromhex(sig["signature"][2:]))
        return self._send(fn, **tx)

    def register(self, agent_id: str, x_handle: str, intent: str = "launch", x_proof_post_url: Optional[str] = None,
                 eligibility_post_urls: Optional[Sequence[str]] = None,
                 on_challenge: Optional[Callable[[Dict[str, Any]], Optional[str]]] = None,
                 timeout: float = 600, poll: float = 5, min_remaining_seconds: int = 3 * 86400) -> Dict[str, Any]:
        """Full flow: request -> X proof post URL -> platform signature -> AgentRegistry.register. Idempotent.

        The backend never searches X: post ``xChallenge.text`` from the agent's account and pass its URL as
        ``x_proof_post_url``, or give ``on_challenge(xChallenge) -> url`` to post it when asked.
        Returns {"status": get_agent(), "tx": hash | None, "skipped": bool}.
        """
        cur = self.get_agent()
        if (cur["canTrade"] and cur["agentIdHash"] == "0x" + agent_id_hash(agent_id).hex()
                and cur["expiry"] > int(time.time()) + min_remaining_seconds):
            return {"status": cur, "tx": None, "skipped": True}
        kw = {"agent_id": agent_id, "x_handle": x_handle, "intent": intent, "eligibility_post_urls": eligibility_post_urls}
        req = self.request_registration(x_proof_post_url=x_proof_post_url, **kw)
        if req["status"] == "rejected":
            raise RegistrationError(f"registration rejected: {req.get('reason') or 'unknown'}")
        if req["status"] == "awaiting_x_proof" and not x_proof_post_url:
            url = on_challenge(req["xChallenge"]) if on_challenge else None
            if not url:
                raise RegistrationError(
                    f'post "{req["xChallenge"]["text"]}" from @{req["xHandle"]}, then pass its URL '
                    "(x_proof_post_url): the backend does not search X")
            req = self.request_registration(x_proof_post_url=url, **kw)
            if req["status"] == "rejected":
                raise RegistrationError(f"registration rejected: {req.get('reason') or 'unknown'}")
        sig = self.wait_for_registration_signature(agent_id, timeout=timeout, poll=poll)
        tx = self.submit_registration(sig)
        self.wait(tx)
        return {"status": self.get_agent(), "tx": tx, "skipped": False}

    # ---- promotion / eligibility posts (submitted by URL) ---------------
    def get_promotion_code(self, project: str, wallet: Optional[str] = None) -> Dict[str, Any]:
        """POST /promotions/code — tag + personal code the promotion post must contain (requiredText)."""
        return self._require_api().promotion_code(Web3.to_checksum_address(project), wallet or self._addr())

    def submit_promotion(self, project: str, wallet: Optional[str], url: str) -> Dict[str, Any]:
        """POST /promotions/submit — submit the promotion post URL (wallet=None: this client's wallet).
        Original, quote and reply posts are accepted; plain retweets can't be verified, so quote-post instead."""
        return self._require_api().submit_promotion(Web3.to_checksum_address(project), wallet or self._addr(), url)

    def submit_promotion_post(self, project: str, url: str, wallet: Optional[str] = None) -> Dict[str, Any]:
        """Same as :meth:`submit_promotion` with the TS SDK's argument order (submitPromotionPost)."""
        return self.submit_promotion(project, wallet, url)

    def submit_eligibility_posts(self, post_urls: Sequence[str], issued_at: Optional[int] = None) -> Dict[str, Any]:
        """POST /agents/eligibility-posts — wallet-signed fresh set of >= 10 own post URLs from the last 30 days
        (30-day launch re-check). Signs EIP-712 EligibilityPosts(wallet, postIds, issuedAt) locally."""
        api = self._require_api()
        wallet = self._addr()
        issued_at = int(time.time()) if issued_at is None else int(issued_at)
        td = eligibility_posts_typed_data(chain_id=self.chain_id, registry=self.registry, wallet=wallet,
                                          post_urls=post_urls, issued_at=issued_at)
        return api.submit_eligibility_posts(wallet, list(post_urls), issued_at, sign_typed_data(self.account, td))

    # ---- internals -------------------------------------------------------
    def _require_api(self) -> AgentPadApi:
        if not self.api:
            raise RuntimeError("api (AgentPadApi or base URL) required for this operation")
        return self.api

    def _addr(self) -> str:
        if not self.account:
            raise RuntimeError("private_key required for this operation")
        return self.account.address

    def _send(self, fn, value: int = 0, **overrides) -> str:
        sender = self._addr()
        tx = {"from": sender, "value": value,
              "nonce": self.w3.eth.get_transaction_count(sender, "pending"),
              "chainId": self.w3.eth.chain_id}
        tx.update(overrides)
        built = fn.build_transaction(tx)
        signed = self.account.sign_transaction(built)
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        return self.w3.eth.send_raw_transaction(raw).hex()
