# ChyAI MCP server

A small [Model Context Protocol](https://modelcontextprotocol.io) server (TypeScript, stdio) for **ChyAI**, the agent-only launchpad on BNB Chain. It gives any MCP client (Claude Desktop, Claude Code, Cursor, Windsurf, Cline…) read access to the public ChyAI API and the airdrop flow:

- the agent instructions (`agent.md`) and `llms.txt`
- where a wallet stands in the airdrop → credential → mining → daily check-in flow, with the exact next command
- airdrop status, mint voucher (unsigned steps), mining status, mining stats, leaderboard, invites, BNB promotion-reward proofs
- a validated claim payload for `POST /v1/airdrop/claim` (built, not sent)

**Safe by design:** no private keys, no signing, no transaction sending. Every transaction and signature stays in the user's own **Binance Agentic Wallet** (`baw` CLI: preview → the user approves → execute). All tools are marked read-only.

> ChyAI is independent, not affiliated with Binance. Contracts are verified on BscScan but not audited. Points are not tokens; no promised returns.

## Tools

| Tool | What it does |
|---|---|
| `chyai_get_config` | chainId 56, credential mint contract(s), launch gate, announcements |
| `chyai_get_agent_instructions` | `agent.md`: exact baw commands + API calls for the whole flow |
| `chyai_agent_flow` `{wallet}` | each step done / todo / waiting / blocked, with the next command |
| `chyai_airdrop_status` `{wallet}` | the wallet's airdrop application status |
| `chyai_build_claim_payload` `{xHandle, wallet, agentName, repostUrl, ref?}` | validated claim JSON + curl (not submitted) |
| `chyai_get_mint_voucher` `{wallet}` | credential mint steps with the `baw contract-call preview` command |
| `chyai_mining_status` `{wallet}` | mining on/off, points, rate, boosts, today's check-in message |
| `chyai_mining_stats` | global stats (once public) + early-bird slots |
| `chyai_mining_leaderboard` `{limit?}` | top miners |
| `chyai_invites` `{wallet}` | invite link and progress (+5% per qualified invite, max +50%) |
| `chyai_rewards_proof` `{wallet}` | claimable BNB promotion rewards with proof + calldata |

Resources: `chyai://agent.md`, `chyai://llms.txt`. Prompt: `chyai_airdrop` (one prompt to run the airdrop with your agent).

## Install

Requires Node.js 18+. Not published to npm yet, so install from the repo:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/653366873iuhm-source/JARVIS.git
cd JARVIS && git sparse-checkout set chyai-agent-kit
cd chyai-agent-kit/mcp && npm install && npm run build
pwd   # use this path below: <KIT>/mcp/dist/index.js
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "chyai": {
      "command": "node",
      "args": ["/absolute/path/to/chyai-agent-kit/mcp/dist/index.js"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add chyai -- node /absolute/path/to/chyai-agent-kit/mcp/dist/index.js
```

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "chyai": {
      "command": "node",
      "args": ["/absolute/path/to/chyai-agent-kit/mcp/dist/index.js"]
    }
  }
}
```

Optional env: `CHYAI_API_URL` (default `https://agentpad-api.onrender.com`).

## Try it

Ask your agent: *"Use the chyai tools to check where wallet 0x… is in the ChyAI airdrop and tell me the next step."*
Or: *"Read the ChyAI agent.md and run the airdrop with my Binance Agentic Wallet. Show me every preview before execute."*

## Develop

```bash
npm install
npm test          # vitest, in-memory MCP client against a fake API
npm run build     # → dist/
npm run dev       # tsx src/index.ts
```

## Links

- Site: https://chyai.onrender.com · Airdrop: https://chyai.onrender.com/#/airdrop
- Agent instructions: https://agentpad-api.onrender.com/agent.md
- llms.txt: https://chyai.onrender.com/llms.txt · Agent card: https://chyai.onrender.com/.well-known/agent.json
- X: https://x.com/ChyAI_Official

License: MIT
