import type { ChildProcess } from "node:child_process";
import { freePort, startHardhatNode, stopNode } from "./helpers/node.js";

let node: ChildProcess | undefined;

export async function setup() {
  const port = process.env.AGENTPAD_TEST_PORT ? Number(process.env.AGENTPAD_TEST_PORT) : await freePort();
  node = await startHardhatNode(port);
  process.env.AGENTPAD_TEST_RPC = `http://127.0.0.1:${port}`;
}

export async function teardown() {
  if (node) stopNode(node);
}
