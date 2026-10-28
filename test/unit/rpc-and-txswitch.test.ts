import { describe, expect, it } from "vitest";
import { makeChain, makeTransport, rpcUrls } from "../../src/chain/client.js";
import { ConfigSchema } from "../../src/config.js";

describe("RPC fallback list", () => {
  it("splits comma-separated RPC_URL and builds a fallback transport", () => {
    expect(rpcUrls(" https://a.example , https://b.example,,")).toEqual(["https://a.example", "https://b.example"]);
    const t = makeTransport("https://a.example,https://b.example")({ chain: makeChain({ CHAIN_ID: 56, RPC_URL: "https://a.example,https://b.example" }) });
    expect(t.config.type).toBe("fallback");
    const one = makeTransport("https://a.example")({});
    expect(one.config.type).toBe("http");
    expect(makeChain({ CHAIN_ID: 56, RPC_URL: "https://a.example,https://b.example" }).rpcUrls.default.http).toEqual(["https://a.example", "https://b.example"]);
  });
});

describe("TX_SEND_ENABLED", () => {
  it("defaults to true and parses false", () => {
    expect(ConfigSchema.parse({}).TX_SEND_ENABLED).toBe(true);
    expect(ConfigSchema.parse({ TX_SEND_ENABLED: "false" }).TX_SEND_ENABLED).toBe(false);
  });
});
