import { execFile } from "node:child_process";
import type { Address, Hex, PublicClient, TypedDataDefinition } from "viem";
import type { AgentSigner, TxRequest } from "./types.js";

/**
 * Binance Agentic Wallet adapter. Shells out to the `baw` CLI (>= 1.11.0) and follows the official
 * external-sign flow from the binance-agentic-wallet skill:
 *
 *   1. `baw wallet settings --json`  -> require devMode.enabled (Developer Mode is switched on in the Binance App)
 *   2. `baw contract-call preview --binanceChainId 56 --from <wallet> --to <contract> --value <wei> --inputData <hex> --json`
 *   3. inspect simulation + risks, ask `confirm(preview)` (or `autoApprove` when the user explicitly authorised it)
 *   4. `baw contract-call execute --requestId <id> --json`  -> txHash (BROADCASTED) or PENDING_CONFIRMATION
 *
 * Arguments are passed as an argv array (execFile, no shell), so untrusted strings can't inject commands.
 */

export interface BawPreview {
  requestId: string;
  parsedTx?: unknown;
  simulationResult?: { simulationCode?: string; simulationErrorDetail?: unknown; [k: string]: unknown };
  risks?: { riskDetails?: { code: string; title: string; description: string; riskType: string }[]; addresses?: Record<string, any>; riskBehaviors?: unknown[] };
  requireConfirmation?: boolean;
  expiresAt?: number;
  [k: string]: unknown;
}

export interface BawExecuteResult {
  orderId: string;
  status: "BROADCASTED" | "PENDING_CONFIRMATION" | string;
  txHash: Hex | null;
  message: string | null;
}

export type BawRunner = (args: string[]) => Promise<string>;

export interface BawSignerOptions {
  /** Path to the baw binary (default "baw" on PATH, or env BAW_BIN). */
  bin?: string;
  /** Binance chain id (default "56" = BSC mainnet). */
  binanceChainId?: string;
  /** Agent wallet address; resolved with `baw wallet address` when omitted. */
  address?: Address;
  /**
   * Called with every preview before execution. Return true to execute. Show the user parsedTx/risks here.
   * Required unless `autoApprove` is true.
   */
  confirm?: (preview: BawPreview, tx: TxRequest) => boolean | Promise<boolean>;
  /** Execute without asking. Only set this when the wallet owner explicitly authorised autonomous trading. */
  autoApprove?: boolean;
  /** Refuse to execute when the preview carries RISK-level findings (default true; CAUTION is allowed). */
  blockOnRisk?: boolean;
  /** What to do on PENDING_CONFIRMATION (App approval needed): throw (default) or poll tx history until mined. */
  pending?: "throw" | "poll";
  /** Needed for pending="poll" (to verify the candidate tx really carries our calldata). */
  publicClient?: PublicClient;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  timeoutMs?: number;
  /** Custom runner (tests / sandboxes). Receives argv without the binary. */
  runner?: BawRunner;
  /** Skip the devMode check (tests). */
  skipDevModeCheck?: boolean;
}

export class BawError extends Error {
  constructor(public code: number | string, public errName: string, message: string, public data?: unknown) {
    super(`baw error ${code}${errName ? ` ${errName}` : ""}: ${message}`);
  }
}

export class BawRejectedError extends Error {
  constructor(public preview: BawPreview, reason: string) {
    super(`baw contract call not executed: ${reason}`);
  }
}

export class BawPendingConfirmationError extends Error {
  constructor(public orderId: string, public preview: BawPreview, message: string | null) {
    super(`baw order ${orderId} needs approval in the Binance App${message ? `: ${message}` : ""}`);
  }
}

function defaultRunner(bin: string, timeoutMs: number): BawRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
        // baw prints JSON errors on stdout with a non-zero exit code; prefer parsing stdout.
        if (stdout && stdout.trim().startsWith("{")) return resolve(stdout);
        if (err) return reject(new Error(`baw ${args.slice(0, 2).join(" ")} failed: ${stderr || err.message}`));
        resolve(stdout);
      });
    });
}

function jsonReplacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}

/** Build the EIP712Domain type list from the domain fields present (needed by eth_signTypedData_v4 JSON). */
function domainTypes(domain: Record<string, unknown>) {
  const all = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
    { name: "salt", type: "bytes32" },
  ];
  return all.filter((f) => domain[f.name] !== undefined);
}

/** baw may return r||s (64 bytes) plus a separate recovery byte; normalise to a 65-byte 0x signature. */
export function normaliseBawSignature(signature: string, recovery?: string | null): Hex {
  let s = signature.startsWith("0x") ? signature.slice(2) : signature;
  if (s.length === 130) return `0x${s}` as Hex;
  if (s.length === 128) {
    let v = recovery ? parseInt(recovery, 16) : 0;
    if (v < 27) v += 27;
    return `0x${s}${v.toString(16).padStart(2, "0")}` as Hex;
  }
  return `0x${s}` as Hex; // ERC-1271 / other formats: pass through
}

export class BawSigner implements AgentSigner {
  readonly kind = "baw";
  readonly chainId: string;
  private address?: Address;
  private devModeOk = false;
  private readonly run: BawRunner;

  constructor(private readonly opts: BawSignerOptions = {}) {
    this.chainId = opts.binanceChainId ?? "56";
    this.address = opts.address;
    this.run = opts.runner ?? defaultRunner(opts.bin ?? process.env.BAW_BIN ?? "baw", opts.timeoutMs ?? 120_000);
    if (!opts.confirm && !opts.autoApprove) {
      // Not an error at construction: read-only use (getAddress) is fine. sendTransaction will refuse.
    }
  }

  /** Runs `baw <args> --json` and returns `data`, throwing BawError on `success:false`. */
  async call<T = any>(args: string[]): Promise<T> {
    const out = await this.run([...args, "--json"]);
    let parsed: any;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new BawError("parse", "", `non-JSON output from baw: ${out.slice(0, 300)}`);
    }
    if (!parsed.success) {
      const e = parsed.error ?? {};
      throw new BawError(e.code ?? "unknown", e.name ?? "", e.message ?? "unknown error", e.data);
    }
    return parsed.data as T;
  }

  async getAddress(): Promise<Address> {
    if (this.address) return this.address;
    const data = await this.call<{ addresses: { binanceChainId: string; address: string }[] }>(["wallet", "address"]);
    const hit = data.addresses.find((a) => String(a.binanceChainId) === this.chainId);
    if (!hit) throw new BawError("no_address", "", `no agentic wallet address for binanceChainId ${this.chainId}`);
    this.address = hit.address as Address;
    return this.address;
  }

  async ensureDevMode(): Promise<void> {
    if (this.devModeOk || this.opts.skipDevModeCheck) return;
    const s = await this.call<{ devMode?: { enabled?: boolean } }>(["wallet", "settings"]);
    if (!s?.devMode?.enabled) {
      throw new BawError("dev_mode_disabled", "", "Developer Mode is off. Enable it in the Binance App (Agentic Wallet settings) before contract calls.");
    }
    this.devModeOk = true;
  }

  async preview(tx: TxRequest): Promise<BawPreview> {
    await this.ensureDevMode();
    const from = await this.getAddress();
    return this.call<BawPreview>([
      "contract-call", "preview",
      "--binanceChainId", this.chainId,
      "--from", from,
      "--to", tx.to,
      "--value", (tx.value ?? 0n).toString(),
      "--inputData", tx.data,
    ]);
  }

  async execute(requestId: string): Promise<BawExecuteResult> {
    return this.call<BawExecuteResult>(["contract-call", "execute", "--requestId", requestId]);
  }

  /** Returns the reason a preview must not be executed, or null when it is safe to proceed. */
  static reviewPreview(p: BawPreview, blockOnRisk = true): string | null {
    if (!p.requestId) return "preview returned no requestId (intercepted)";
    const sim = p.simulationResult;
    if (sim && sim.simulationCode && sim.simulationCode !== "000000000") {
      return `simulation failed (${sim.simulationCode}): ${JSON.stringify(sim.simulationErrorDetail ?? null)}`;
    }
    if (blockOnRisk) {
      const risky = (p.risks?.riskDetails ?? []).filter((r) => r.riskType === "RISK");
      if (risky.length) return `risk findings: ${risky.map((r) => `${r.title} — ${r.description}`).join("; ")}`;
      for (const [addr, info] of Object.entries(p.risks?.addresses ?? {})) {
        const r = (info?.riskDetails ?? []).filter((d: any) => d.riskType === "RISK");
        if (r.length) return `address ${addr} flagged: ${r.map((d: any) => d.title).join("; ")}`;
      }
    }
    return null;
  }

  async sendTransaction(tx: TxRequest): Promise<Hex> {
    if (!this.opts.confirm && !this.opts.autoApprove) {
      throw new Error("BawSigner: pass confirm(preview) or autoApprove:true (only with the owner's explicit authorisation) to send transactions");
    }
    const preview = await this.preview(tx);
    const reason = BawSigner.reviewPreview(preview, this.opts.blockOnRisk ?? true);
    if (reason) throw new BawRejectedError(preview, reason);
    if (this.opts.confirm) {
      const ok = await this.opts.confirm(preview, tx);
      if (!ok) throw new BawRejectedError(preview, "declined by confirm()");
    }
    const startedAt = Date.now();
    let res: BawExecuteResult;
    try {
      res = await this.execute(preview.requestId);
    } catch (e) {
      // Preview cache can expire between preview and execute: preview once more, then execute.
      if (e instanceof BawError && /expire/i.test(e.message)) {
        const again = await this.preview(tx);
        const r2 = BawSigner.reviewPreview(again, this.opts.blockOnRisk ?? true);
        if (r2) throw new BawRejectedError(again, r2);
        res = await this.execute(again.requestId);
      } else throw e;
    }
    if (res.status === "BROADCASTED" && res.txHash) return res.txHash;
    if (res.status === "PENDING_CONFIRMATION") {
      if (this.opts.pending === "poll") return this.pollForTx(tx, startedAt, res.orderId, preview);
      throw new BawPendingConfirmationError(res.orderId, preview, res.message);
    }
    throw new BawError("execute", res.status, res.message ?? "unexpected execute result", res);
  }

  /** After App approval, find the tx in history and verify it carries our calldata before returning its hash. */
  private async pollForTx(tx: TxRequest, since: number, orderId: string, preview: BawPreview): Promise<Hex> {
    const pc = this.opts.publicClient;
    if (!pc) throw new BawPendingConfirmationError(orderId, preview, "pending=poll needs publicClient");
    const deadline = Date.now() + (this.opts.pollTimeoutMs ?? 10 * 60_000);
    const seen = new Set<string>();
    const needle = tx.data.slice(2).toLowerCase();
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.opts.pollIntervalMs ?? 5_000));
      const h = await this.call<{ transactions: { txHash: string; txTime: string }[] }>([
        "wallet", "tx-history", "--binanceChainId", this.chainId, "--startTime", String(since - 60_000), "--size", "20",
      ]).catch(() => ({ transactions: [] }));
      for (const t of h.transactions ?? []) {
        if (!t.txHash || seen.has(t.txHash)) continue;
        seen.add(t.txHash);
        try {
          const onchain = await pc.getTransaction({ hash: t.txHash as Hex });
          const input = onchain.input.toLowerCase();
          const toMatches = onchain.to?.toLowerCase() === tx.to.toLowerCase();
          if ((toMatches && input === tx.data.toLowerCase()) || input.includes(needle)) return t.txHash as Hex;
        } catch {
          /* not yet visible */
        }
      }
    }
    throw new BawPendingConfirmationError(orderId, preview, "timed out waiting for App approval");
  }

  async signTypedData(typedData: TypedDataDefinition<any, any>): Promise<Hex> {
    await this.ensureDevMode();
    const from = await this.getAddress();
    const td: any = typedData;
    const payload = {
      domain: td.domain,
      types: { EIP712Domain: domainTypes(td.domain ?? {}), ...td.types },
      primaryType: td.primaryType,
      message: td.message,
    };
    const message = JSON.stringify({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(payload, jsonReplacer)] });
    const preview = await this.call<{ requestId: string; risks?: BawPreview["risks"] }>([
      "sign-message", "preview", "--binanceChainId", this.chainId, "--signType", "EIP712", "--message", message,
    ]);
    if (!preview.requestId) throw new BawError("intercepted", "", "sign-message preview returned no requestId");
    if (this.opts.confirm && !(await this.opts.confirm(preview as BawPreview, { to: from, data: "0x", description: "EIP-712 signature" }))) {
      throw new BawRejectedError(preview as BawPreview, "declined by confirm()");
    }
    if (!this.opts.confirm && !this.opts.autoApprove) throw new Error("BawSigner: confirm or autoApprove required to sign");
    let res = await this.call<{ orderId: string; status: string; signature: string | null; signatureRecovery: string | null }>([
      "sign-message", "execute", "--requestId", preview.requestId,
    ]);
    const deadline = Date.now() + (this.opts.pollTimeoutMs ?? 10 * 60_000);
    while (res.status === "PENDING_CONFIRMATION") {
      if (this.opts.pending !== "poll" || Date.now() > deadline) throw new BawPendingConfirmationError(res.orderId, preview as BawPreview, "signature needs approval in the Binance App");
      await new Promise((r) => setTimeout(r, this.opts.pollIntervalMs ?? 5_000));
      res = await this.call(["sign-message", "result", "--order-id", res.orderId]);
    }
    if (res.status !== "COMPLETED" || !res.signature) throw new BawError("sign", res.status, "no signature returned");
    return normaliseBawSignature(res.signature, res.signatureRecovery);
  }
}
