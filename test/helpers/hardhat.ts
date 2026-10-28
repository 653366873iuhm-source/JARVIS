import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { CONTRACTS_DIR } from "../../scripts/lib/deploy.js";

export async function startHardhatNode(port: number): Promise<{ url: string; stop: () => Promise<void> }> {
  const bin = path.join(CONTRACTS_DIR, "node_modules/.bin/hardhat");
  const proc: ChildProcess = spawn(bin, ["node", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: CONTRACTS_DIR, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout!.on("data", (d) => (log += d.toString()).length > 20000 && (log = log.slice(-5000)));
  proc.stderr!.on("data", (d) => (log += d.toString()));
  const url = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (proc.exitCode !== null) throw new Error(`hardhat node exited: ${log}`);
    if (Date.now() - started > 90_000) throw new Error(`hardhat node did not start: ${log}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    url,
    stop: async () => {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
    },
  };
}

export async function rpc(url: string, method: string, params: unknown[] = []) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

export async function increaseTime(url: string, seconds: number) {
  await rpc(url, "evm_increaseTime", [seconds]);
  await rpc(url, "evm_mine", []);
}
