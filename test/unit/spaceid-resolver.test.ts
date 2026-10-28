/** SPACE ID Agent ID (.ai) on-chain resolver: label normalisation, zero owner = not found, address type, read errors. */
import { describe, expect, it } from "vitest";
import { AgentIdResolveError, SpaceIdOnchainResolver, agentIdLabel } from "../../src/providers/agentid/index.js";

const OWNER = "0x49E6fb3812fdfD67eDfE17259f03CcbE59f39BCE";
const fakePc = (owners: Record<string, string>, code = "0x", fail = false) => {
  const calls: unknown[] = [];
  return {
    calls,
    async readContract(a: any) {
      calls.push(a);
      if (fail) throw new Error("rpc down");
      if (a.functionName === "ownerOfHandle") return owners[a.args[0]] ?? "0x0000000000000000000000000000000000000000";
      if (a.functionName === "handleOf") return Object.entries(owners).find(([, w]) => w.toLowerCase() === String(a.args[0]).toLowerCase())?.[0] ?? "";
      throw new Error("unexpected");
    },
    async getCode() {
      return code;
    },
  };
};

describe("SpaceIdOnchainResolver", () => {
  it("agentIdLabel strips .ai and lowercases", () => {
    expect(agentIdLabel("AllIn168.ai")).toBe("allin168");
    expect(agentIdLabel("allin168")).toBe("allin168");
    expect(agentIdLabel("bad-name.ai")).toBeNull();
  });
  it("resolves via ownerOfHandle(label) on the registry", async () => {
    const pc = fakePc({ allin168: OWNER });
    const r = new SpaceIdOnchainResolver(pc as any);
    expect(await r.resolve("allin168.ai")).toEqual({ address: OWNER, addressType: "EOA", isFallback: false });
    expect((pc.calls[0] as any).address).toBe("0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F");
    expect((pc.calls[0] as any).args).toEqual(["allin168"]);
    expect(await r.resolve("nobody.ai")).toBeNull();
    expect(await r.nameOf(OWNER as any)).toBe("allin168.ai");
  });
  it("marks smart wallets as CONTRACT and surfaces RPC failures as AgentIdResolveError", async () => {
    expect((await new SpaceIdOnchainResolver(fakePc({ x123: OWNER }, "0x6080") as any).resolve("x123.ai"))?.addressType).toBe("CONTRACT");
    await expect(new SpaceIdOnchainResolver(fakePc({}, "0x", true) as any).resolve("x123.ai")).rejects.toBeInstanceOf(AgentIdResolveError);
  });
});
