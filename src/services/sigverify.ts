import type { Address, Hex, PublicClient, TypedDataDefinition } from "viem";
import { verifyMessage, verifyTypedData } from "viem/actions";

/**
 * Verifies an agent-wallet signature. Uses viem's public-client actions, which handle:
 *   - EOAs (ecrecover),
 *   - deployed smart-contract wallets via ERC-1271 isValidSignature (Binance agentic wallets),
 *   - counterfactual (not yet deployed) smart wallets via ERC-6492 wrapped signatures.
 */
export async function verifyAgentSignature(
  pc: PublicClient,
  args: { address: Address; signature: Hex } & ({ kind: "eip191"; message: string } | { kind: "eip712"; typedData: TypedDataDefinition }),
): Promise<boolean> {
  try {
    if (args.kind === "eip191") {
      return await verifyMessage(pc, { address: args.address, message: args.message, signature: args.signature });
    }
    return await verifyTypedData(pc, { address: args.address, signature: args.signature, ...(args.typedData as any) });
  } catch {
    return false;
  }
}

export async function walletType(pc: PublicClient, address: Address): Promise<"eoa" | "contract"> {
  const code = await pc.getCode({ address });
  return code && code !== "0x" ? "contract" : "eoa";
}
