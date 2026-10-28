#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
const server = createServer({ apiRoot: process.env.CHYAI_API_URL || undefined });
await server.connect(new StdioServerTransport());
console.error("chyai-mcp running on stdio");
