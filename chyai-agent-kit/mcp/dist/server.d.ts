/**
 * ChyAI MCP server. Wraps the public ChyAI API (read + flow endpoints) for AI agents.
 * Never handles private keys and never sends transactions: every transaction and signature runs in the user's own
 * Binance Agentic Wallet (baw CLI: preview → user approves → execute).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ChyAIClientOptions } from "./api.js";
export declare const SERVER_NAME = "chyai";
export declare const SERVER_VERSION = "0.1.0";
export declare function createServer(opts?: ChyAIClientOptions): McpServer;
