/**
 * Regenerates eip712.json from the BACKEND's own typed-data definitions (backend/src/chain/eip712.ts +
 * services/registration.ts eligibilityPostsTypedData), so the Python tests pin the exact digests the server verifies.
 *   cd backend && ./node_modules/.bin/tsx ../sdk/python/tests/fixtures/gen_eip712.ts
 */
import fs from "node:fs";
import path from "node:path";
import { hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AgentBindingTypes, EligibilityPostsTypes, agentDomain } from "../../../../backend/src/chain/eip712.js";

const pk = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const; // hardhat #2 (public dev key)
const acct = privateKeyToAccount(pk);
const registry = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const cases: any[] = [];
for (const chainId of [31337, 97, 56]) {
  const postUrls = ["https://x.com/pancake_chef/status/1900000000000000001", "https://twitter.com/Pancake_Chef/statuses/1900000000000000002?s=20", "1900000000000000003"];
  const postIds = ["1900000000000000001", "1900000000000000002", "1900000000000000003"];
  const issuedAt = 1761560000 + chainId;
  const elig = { domain: agentDomain(chainId, registry), types: EligibilityPostsTypes, primaryType: "EligibilityPosts" as const,
    message: { wallet: acct.address, postIds: postIds.join(","), issuedAt: BigInt(issuedAt) } };
  cases.push({ kind: "EligibilityPosts", chainId, registry, wallet: acct.address, postUrls, postIds: postIds.join(","), issuedAt,
    digest: hashTypedData(elig), signature: await acct.signTypedData(elig) });
  const bind = { agentId: "pancakechef.ai", wallet: acct.address, xHandle: "pancake_chef", intent: "launch", challenge: "c0ffee-challenge", issuedAt: 1761560000n, expiresAt: 1761560900n };
  const b = { domain: agentDomain(chainId, registry), types: AgentBindingTypes, primaryType: "AgentBinding" as const, message: bind };
  cases.push({ kind: "AgentBinding", chainId, registry, ...bind, issuedAt: 1761560000, expiresAt: 1761560900, digest: hashTypedData(b), signature: await acct.signTypedData(b) });
}
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "eip712.json"), JSON.stringify({ privateKey: pk, cases }, null, 2) + "\n");
console.log(`wrote ${cases.length} cases`);
