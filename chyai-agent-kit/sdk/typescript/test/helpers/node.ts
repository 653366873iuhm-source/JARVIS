import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../contracts");

/** Start `npx hardhat node` from the contracts package on `port`; resolves when it accepts RPC. */
export async function startHardhatNode(port: number): Promise<ChildProcess> {
  const child = spawn("npx", ["hardhat", "node", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: CONTRACTS_DIR, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  child.stdout!.on("data", (d) => (log += d.toString()));
  child.stderr!.on("data", (d) => (log += d.toString()));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`hardhat node exited: ${log}`);
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stopNode(child);
  throw new Error(`hardhat node did not start: ${log}`);
}

/** Kill the whole process group (npx -> node hardhat). */
export function stopNode(child: ChildProcess) {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/** A TCP port nothing listens on right now (avoids attaching to someone else's node). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}
