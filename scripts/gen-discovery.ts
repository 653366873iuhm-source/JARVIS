/** Writes the static discovery files (llms.txt, agent.md, .well-known/agent.json + agent-card.json) into the given dirs.
 *  Contract addresses for agent.md come from CHYAI_SALE / CHYAI_TOKEN / CHYAI_AIRDROP (placeholders until deployed). */
import fs from "node:fs";
import path from "node:path";
import { chyaiAgentCard as agentCard, chyaiLlmsTxt, chyaiAgentMarkdown, CHYAI_SITE } from "../src/api/routes/chyai.js";
import { PUBLIC_API } from "../src/api/routes/discovery.js";
const llmsTxt = () => chyaiLlmsTxt(PUBLIC_API, CHYAI_SITE);
const addr = (k: string) => (/^0x[0-9a-fA-F]{40}$/.test(process.env[k] ?? "") ? process.env[k]! : null);

const dirs = process.argv.slice(2);
if (!dirs.length) throw new Error("usage: tsx scripts/gen-discovery.ts <outDir> [...]");
for (const d of dirs) {
  fs.mkdirSync(path.join(d, ".well-known"), { recursive: true });
  fs.writeFileSync(path.join(d, "llms.txt"), llmsTxt());
  fs.writeFileSync(
    path.join(d, "agent.md"),
    chyaiAgentMarkdown(PUBLIC_API, 56, { sale: addr("CHYAI_SALE"), token: addr("CHYAI_TOKEN"), airdrop: addr("CHYAI_AIRDROP") }),
  );
  const card = JSON.stringify(agentCard(PUBLIC_API), null, 2) + "\n";
  fs.writeFileSync(path.join(d, ".well-known", "agent.json"), card);
  fs.writeFileSync(path.join(d, ".well-known", "agent-card.json"), card);
  console.log("wrote", d);
}
