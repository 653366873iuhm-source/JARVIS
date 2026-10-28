/** Writes the static discovery files (llms.txt, .well-known/agent.json + agent-card.json) into the given dirs. */
import fs from "node:fs";
import path from "node:path";
import { agentCard, llmsTxt } from "../src/api/routes/discovery.js";

const dirs = process.argv.slice(2);
if (!dirs.length) throw new Error("usage: tsx scripts/gen-discovery.ts <outDir> [...]");
for (const d of dirs) {
  fs.mkdirSync(path.join(d, ".well-known"), { recursive: true });
  fs.writeFileSync(path.join(d, "llms.txt"), llmsTxt());
  const card = JSON.stringify(agentCard(), null, 2) + "\n";
  fs.writeFileSync(path.join(d, ".well-known", "agent.json"), card);
  fs.writeFileSync(path.join(d, ".well-known", "agent-card.json"), card);
  console.log("wrote", d);
}
