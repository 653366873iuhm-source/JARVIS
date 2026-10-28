import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { AgentPad } from "../src/client.js";
import { BONDING_NFT_TEMPLATES } from "../src/constants.js";
import { BondingNFTAbi } from "../src/abi/BondingNFT.js";

const P = "0x00000000000000000000000000000000000000b1" as const;
const padWithVersion = (v: number | null) =>
  new AgentPad({
    publicClient: { readContract: async () => (v === null ? Promise.reject(new Error("no VERSION")) : BigInt(v)) } as any,
    signer: undefined as any,
  });

describe("exit path: v2 sell(uint256[],uint256), v1 burn", () => {
  it("knows the mainnet templates", () => {
    expect(BONDING_NFT_TEMPLATES.v2).toBe("0xDbAaF18C1Dc7945840Bb84D7360564876594d971");
    expect(BONDING_NFT_TEMPLATES.v1).toBe("0x21247fE7781D1e44C11aD67fdDd792162dD952b9");
  });
  it("v2 project → sell calldata", async () => {
    const tx = await padWithVersion(2).exitTx(P, [1n, 2n], 5n);
    const d = decodeFunctionData({ abi: BondingNFTAbi, data: tx.data });
    expect(d.functionName).toBe("sell");
    expect(d.args).toEqual([[1n, 2n], 5n]);
    expect(tx.to).toBe(P);
  });
  it("v1 project (no VERSION) → burn calldata", async () => {
    const tx = await padWithVersion(null).exitTx(P, [3n], 0n);
    expect(decodeFunctionData({ abi: BondingNFTAbi, data: tx.data }).functionName).toBe("burn");
  });
});
