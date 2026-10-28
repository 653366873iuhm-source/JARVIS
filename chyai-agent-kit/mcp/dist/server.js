/**
 * ChyAI MCP server. Wraps the public ChyAI API (read + flow endpoints) for AI agents.
 * Never handles private keys and never sends transactions: every transaction and signature runs in the user's own
 * Binance Agentic Wallet (baw CLI: preview → user approves → execute).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildClaimPayload, ChyAIClient, PINNED_POST, SITE_URL } from "./api.js";
export const SERVER_NAME = "chyai";
export const SERVER_VERSION = "0.1.0";
const DISCLAIMER = "ChyAI is independent, not affiliated with Binance. Contracts verified on BscScan but not audited. Points are not tokens; no promised returns.";
const wallet = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "0x-prefixed 40-hex BSC wallet address").describe("BSC wallet address of the user's Binance Agentic Wallet (0x…)");
const json = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] });
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export function createServer(opts = {}) {
    const api = new ChyAIClient(opts);
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    const tool = (name, title, description, shape, run) => server.registerTool(name, { title, description, inputSchema: shape, annotations: { ...RO, title } }, (async (args) => {
        try {
            return json(await run(args));
        }
        catch (e) {
            return fail(e);
        }
    }));
    tool("chyai_get_config", "ChyAI config", "Platform config: chainId (56), credential mint contract(s), launch gate (X followers/age), announcements.", {}, () => api.config());
    tool("chyai_get_agent_instructions", "agent.md instructions", "Fetch agent.md: the step-by-step instructions (exact baw CLI commands and API calls) for the ChyAI airdrop → credential → mining → daily check-in flow. Read this before acting.", {}, () => api.agentInstructions());
    tool("chyai_agent_flow", "Airdrop flow status", "Machine-readable state of one wallet in the ChyAI flow: each step (x_post, apply, mint_credential, mining, daily_checkin) is done / todo / waiting / blocked, with the exact next command. Call this whenever unsure what to do next.", { wallet }, ({ wallet }) => api.agentFlow(wallet));
    tool("chyai_airdrop_status", "Airdrop claim status", "Status of the wallet's airdrop application (approved / pending_verification / rejected / none).", { wallet }, ({ wallet }) => api.airdropStatus(wallet));
    tool("chyai_get_mint_voucher", "Mint voucher (unsigned steps)", "Fetch the credential mint voucher: steps[] with to/data and the exact `baw contract-call preview` command. This server does not sign or send; run the command in the user's Binance Agentic Wallet, show the preview, and execute only after the user approves.", { wallet }, ({ wallet }) => api.mintVoucher(wallet));
    tool("chyai_mining_status", "Mining status", "Mining state of a wallet: mining on/off, credential, points, rate, boosts, and today's check-in (checkin.checkedInToday, checkin.baw.preview for the EIP-712 signature).", { wallet }, ({ wallet }) => api.mining(wallet));
    tool("chyai_mining_stats", "Mining stats", "Global mining stats (shown once participants reach the public threshold) and the early-bird slots (first 1000 minters, +20% for 30 days).", {}, () => api.miningStats());
    tool("chyai_mining_leaderboard", "Mining leaderboard", "Top miners by points.", { limit: z.number().int().min(1).max(100).optional().describe("Max rows to return (default all the API returns)") }, async ({ limit }) => {
        const r = await api.miningLeaderboard();
        return limit && Array.isArray(r?.items) ? { ...r, items: r.items.slice(0, limit) } : r;
    });
    tool("chyai_invites", "Invite link and stats", "The wallet's invite link (…/airdrop?ref=<name>.ai) and invite progress. Each qualified invitee adds +5% mining speed, up to +50%.", { wallet }, ({ wallet }) => api.invites(wallet));
    tool("chyai_rewards_proof", "Promotion rewards (BNB)", "Claimable BNB promotion rewards for a wallet: per-epoch amount, merkle proof and the calldata to send from the user's own wallet (never built locally).", { wallet }, ({ wallet }) => api.rewardsProof(wallet));
    tool("chyai_build_claim_payload", "Build airdrop claim payload", "Validate and build the JSON body for POST /v1/airdrop/claim (does NOT submit it). Needs the user's X handle, the link of their quote/reply to the pinned post, the wallet and its .ai Agent ID name. Returns the body plus a ready curl command.", {
        xHandle: z.string().describe("User's X handle, with or without @"),
        wallet,
        agentName: z.string().describe("The wallet's .ai Agent ID name, e.g. alice.ai (from `baw`)"),
        repostUrl: z.string().describe(`Link of the user's quote or reply to the pinned post ${PINNED_POST}`),
        ref: z.string().optional().describe("Optional inviter .ai name or wallet from the user's invite link"),
    }, async (a) => {
        const body = buildClaimPayload(a);
        const url = `${api.v1}/airdrop/claim`;
        return {
            method: "POST",
            url,
            body,
            curl: `curl -s -X POST ${url} -H 'content-type: application/json' -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`,
            next: "Submit it (idempotent: 201 new, 200 existing). approved → chyai_get_mint_voucher; pending_verification → poll chyai_airdrop_status every 10 min.",
            note: DISCLAIMER,
        };
    });
    server.registerResource("agent-md", "chyai://agent.md", { title: "ChyAI agent.md", description: "Step-by-step agent instructions", mimeType: "text/markdown" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: await api.agentInstructions() }] }));
    server.registerResource("llms-txt", "chyai://llms.txt", { title: "ChyAI llms.txt", description: "Concise platform description for LLMs", mimeType: "text/plain" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: await api.llmsTxt() }] }));
    server.registerPrompt("chyai_airdrop", {
        title: "Run the ChyAI airdrop with my agent",
        description: "One prompt: apply → mint credential → mining → daily check-in, with the user's Binance Agentic Wallet.",
        argsSchema: { xHandle: z.string().describe("Your X handle"), repostUrl: z.string().describe("Link of your quote/reply to the pinned post") },
    }, ({ xHandle, repostUrl }) => ({
        messages: [{
                role: "user",
                content: {
                    type: "text",
                    text: [
                        `Use my Binance Agentic Wallet (baw CLI) to run the ChyAI airdrop by ${api.apiRoot}/agent.md: apply → verify → mint the credential → start mining → daily check-in.`,
                        `My X handle: ${xHandle}. My quote/reply to the pinned post: ${repostUrl}.`,
                        "Read wallet and .ai name from baw. Show me every transaction and signature preview and wait for my yes before execute. Use chyai_agent_flow to see the next step.",
                        `Site: ${SITE_URL}/#/airdrop. ${DISCLAIMER}`,
                    ].join("\n"),
                },
            }],
    }));
    return server;
}
