import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Hex } from "viem";

const SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// Test smart-contract wallet: owner-controlled exec + ERC-1271 (owner ECDSA over the raw hash).
contract TestERC1271Wallet {
    address public owner;
    constructor(address o) { owner = o; }
    receive() external payable {}
    function exec(address target, uint256 value, bytes calldata data) external payable returns (bytes memory) {
        require(msg.sender == owner, "not owner");
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) { assembly { revert(add(ret, 32), mload(ret)) } }
        return ret;
    }
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(sig.offset) s := calldataload(add(sig.offset, 32)) v := byte(0, calldataload(add(sig.offset, 64))) }
        return ecrecover(hash, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}`;

/** Compiles (and caches) the ERC-1271 test wallet with solc-js. */
export function erc1271Artifact(): { abi: any[]; bytecode: Hex } {
  const cache = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../contracts/TestERC1271Wallet.json");
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8"));
  const solc = createRequire(import.meta.url)("solc");
  const input = {
    language: "Solidity",
    sources: { "TestERC1271Wallet.sol": { content: SOURCE } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors ?? []).filter((e: any) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e: any) => e.formattedMessage).join("\n"));
  const c = out.contracts["TestERC1271Wallet.sol"].TestERC1271Wallet;
  const art = { abi: c.abi, bytecode: ("0x" + c.evm.bytecode.object) as Hex };
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(art));
  return art;
}
