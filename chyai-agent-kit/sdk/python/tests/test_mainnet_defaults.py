from agentpad import BSC_MAINNET, DEFAULT_API_URL, DEPLOYMENTS, AgentPad


class _Eth:
    chain_id = 56


class _W3:
    eth = _Eth()


def test_mainnet_deployment_constants():
    assert DEPLOYMENTS[56] is BSC_MAINNET
    assert BSC_MAINNET["AgentRegistry"] == "0x9cfCb9fAa10A09f632d83C28a5DDaF044455c650"
    assert BSC_MAINNET["LaunchFactory"] == "0x1CaC41417B38388e72Dc02430f47e6dF96810702"
    assert BSC_MAINNET["fromBlock"] == 130114130
    assert DEFAULT_API_URL == "https://agentpad-api.onrender.com/v1"


def test_client_defaults_to_mainnet_addresses_on_chain_56():
    pad = AgentPad(w3=_W3(), chain_id=56)
    assert pad.registry == "0x9cfCb9fAa10A09f632d83C28a5DDaF044455c650"
    assert pad.addresses["FeeSplitter"] == "0xeb41B157e8D832B0338F28d496ecFc088308C368"


def test_explicit_addresses_win():
    pad = AgentPad(w3=_W3(), chain_id=56, addresses={"AgentRegistry": "0x0000000000000000000000000000000000000001"})
    assert pad.registry == "0x0000000000000000000000000000000000000001"


class _Call:
    def __init__(self, name, args, log, ret=None, err=None):
        self.name, self.args, self.log, self.ret, self.err = name, args, log, ret, err

    def call(self):
        if self.err:
            raise self.err
        return self.ret


class _Fns:
    def __init__(self, version, log):
        self.version, self.log = version, log

    def VERSION(self):
        return _Call("VERSION", (), self.log, ret=self.version, err=None if self.version else Exception("no VERSION on v1"))

    def sell(self, ids, min_out):
        return _Call("sell", (ids, min_out), self.log)

    def burn(self, ids, min_out):
        return _Call("burn", (ids, min_out), self.log)


class _Contract:
    def __init__(self, version, log):
        self.functions = _Fns(version, log)


def _pad_with(version):
    from agentpad import BONDING_NFT_TEMPLATES
    assert BONDING_NFT_TEMPLATES["v2"] == "0xDbAaF18C1Dc7945840Bb84D7360564876594d971"
    log = []
    pad = AgentPad(w3=_W3(), chain_id=56)
    pad.bonding = lambda project: _Contract(version, log)  # type: ignore[assignment]
    pad._send = lambda fn, **tx: log.append((fn.name, fn.args)) or "0xhash"  # type: ignore[assignment]
    return pad, log


def test_sell_uses_v2_sell_and_v1_burn():
    pad, log = _pad_with(2)
    assert pad.project_version("0x" + "1" * 40) == 2
    assert pad.sell("0x" + "1" * 40, [5, 7], 123) == "0xhash"
    assert pad.burn("0x" + "1" * 40, [9], 1) == "0xhash"  # deprecated alias → still sell on v2
    assert log == [("sell", ([5, 7], 123)), ("sell", ([9], 1))]
    pad1, log1 = _pad_with(None)
    assert pad1.project_version("0x" + "1" * 40) == 1
    pad1.sell("0x" + "1" * 40, [3], 0)
    assert log1 == [("burn", ([3], 0))]
