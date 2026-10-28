import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Abi, type Hex } from "viem";
import { AgentRegistryAbi, BondingNFTAbi, FeeSplitterAbi, LaunchFactoryAbi, RewardPoolAbi, AgentTokenAbi } from "./abi/index.js";

/** Union of every custom error in the AgentPad contracts (+ standard OZ ERC-20/721 errors). */
export const ALL_ERRORS_ABI = [
  ...[AgentRegistryAbi, BondingNFTAbi, FeeSplitterAbi, LaunchFactoryAbi, RewardPoolAbi, AgentTokenAbi]
    .flatMap((a) => (a as readonly any[]).filter((x) => x.type === "error")),
].filter((e, i, arr) => arr.findIndex((o) => o.name === e.name && JSON.stringify(o.inputs) === JSON.stringify(e.inputs)) === i) as Abi;

/**
 * Errors raised by the SDK's own pre-flight checks that have no contract counterpart (every other errorName an
 * AgentPadError carries is a contract custom error from ALL_ERRORS_ABI).
 */
export const SDK_CHECK_ERRORS = ["MaxTotalExceeded"] as const;

/** Plain-language hints for the errors an agent will meet most. */
export const ERROR_HINTS: Record<string, string> = {
  NotAgent: "wallet is not a registered agent with canTrade (or the registration expired) — run register()",
  NotLauncher: "wallet lacks canLaunch (not registered, revoked, or expired)",
  Cooldown: "this agentId launched within the last 24h; wait until availableAt",
  AntiSnipeLimit: "first 5 minutes after launch: max 20 NFTs per tx and 50 per wallet",
  LauncherCap: "launcher may hold at most 500 NFTs of its own project",
  InsufficientPayment: "msg.value below cost+fee — re-quote (price moved)",
  Slippage: "burn payout below minOut — re-quote or raise slippage",
  WrongPhase: "action not allowed in the project's current phase",
  TransfersDisabled: "NFTs cannot be transferred before graduation",
  Locked: "NFT locked after graduation (24h non-promoters, 7d launcher)",
  PromotionOver: "the 2h promotion window is over — call graduate()",
  PromotionNotOver: "graduate() is only possible 2h after the curve sold out",
  BadAttestation: "promotion attestation signature/nonce/deadline invalid",
  InvalidProof: "Merkle proof does not match the root",
  BadAmount: "count is 0, above 100, or above remaining supply / your holdings",
  NotOwner: "you don't own one of these tokenIds",
  BadSignature: "registration signature invalid (wrong signer, chain, nonce, or tampered fields)",
  Expired: "registration signature deadline passed or expiry in the past — fetch a fresh signature",
  AlreadyClaimed: "reward for this epoch already claimed",
  NothingToWithdraw: "no fee balance to withdraw",
  NotRegistered: "wallet has no registration in AgentRegistry",
  MaxTotalExceeded: "quoted cost + fee is above maxTotal (--max-total-bnb) — re-quote; ask before raising the cap",
};

export class AgentPadError extends Error {
  constructor(public errorName: string, public args: readonly unknown[] = [], public cause?: unknown) {
    super(`${errorName}${args.length ? `(${args.map(String).join(", ")})` : ""}${ERROR_HINTS[errorName] ? ` — ${ERROR_HINTS[errorName]}` : ""}`);
    this.name = "AgentPadError";
  }
}

/** Try to turn any viem error / revert data into an AgentPadError with the contract's custom error name. */
export function decodeAgentPadError(err: unknown): AgentPadError | null {
  if (err instanceof AgentPadError) return err;
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted?.data?.errorName) return new AgentPadError(reverted.data.errorName, reverted.data.args ?? [], err);
    const withData = err.walk((e: any) => typeof e?.data === "string" && e.data.startsWith("0x")) as any;
    const data: Hex | undefined = withData?.data;
    if (data && data.length >= 10) {
      try {
        const d = decodeErrorResult({ abi: ALL_ERRORS_ABI, data });
        return new AgentPadError(d.errorName, (d.args ?? []) as readonly unknown[], err);
      } catch {
        /* unknown selector */
      }
    }
  }
  // Some nodes (e.g. Hardhat with clones) only put the revert data / error name into the message text.
  const text = err instanceof Error ? `${err.message} ${(err as any).details ?? ""}` : String(err);
  const m = text.match(/return data: (0x[0-9a-fA-F]{8,})/) ?? text.match(/"data":"(0x[0-9a-fA-F]{8,})"/);
  if (m) {
    try {
      const d = decodeErrorResult({ abi: ALL_ERRORS_ABI, data: m[1] as Hex });
      return new AgentPadError(d.errorName, (d.args ?? []) as readonly unknown[], err);
    } catch {
      /* unknown */
    }
  }
  const n = text.match(/custom error '(\w+)\(/);
  if (n) return new AgentPadError(n[1], [], err);
  return null;
}
