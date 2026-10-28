import io
import json

import pytest

from agentpad import AgentPadApi, build_airdrop_claim

W = "0x" + "ab" * 20


class _Res(io.BytesIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _opener(seen):
    def op(req, timeout=None):
        seen.append((req.get_method(), req.full_url, req.data))
        return _Res(json.dumps({"ok": True}).encode())
    return op


def test_build_airdrop_claim_normalises_and_validates():
    b = build_airdrop_claim("@Alice_1", W, "Bob.AI", "https://x.com/Alice_1/status/123456789", " c.ai ")
    assert b == {"xHandle": "Alice_1", "wallet": W, "agentName": "bob.ai",
                 "repostUrl": "https://x.com/Alice_1/status/123456789", "ref": "c.ai"}
    with pytest.raises(ValueError):
        build_airdrop_claim("a", "0x12", "b.ai", "https://x.com/a/status/123456789")
    with pytest.raises(ValueError):
        build_airdrop_claim("a", W, "b.eth", "https://x.com/a/status/123456789")
    with pytest.raises(ValueError):
        build_airdrop_claim("a", W, "b.ai", "123456789")


def test_flow_paths():
    seen = []
    api = AgentPadApi(opener=_opener(seen))
    api.config(); api.agent_flow(W); api.airdrop_status(W); api.mint_voucher(W); api.mining(W)
    api.mining_stats(); api.mining_leaderboard(); api.invites(W)
    api.airdrop_claim("@a", W, "b.ai", "https://x.com/a/status/123456789")
    paths = [u.replace("https://agentpad-api.onrender.com/v1", "") for _, u, _ in seen]
    assert paths == ["/config", f"/agent/flow?wallet={W}", f"/airdrop/status?wallet={W}", f"/airdrop/voucher?wallet={W}",
                     f"/mining/{W}", "/mining/stats", "/mining/leaderboard", f"/airdrop/invites/{W}", "/airdrop/claim"]
    assert seen[-1][0] == "POST" and json.loads(seen[-1][2])["xHandle"] == "a"
