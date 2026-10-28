#!/usr/bin/env node
// Test double for the Binance Agentic Wallet CLI (`baw`). Implements the subset AgentPad uses, with the same
// JSON shapes as the official skill references: wallet address/settings, contract-call preview/execute,
// sign-message preview/execute/result. Backed by a local private key + RPC. State persists in MOCK_BAW_STATE.
import fs from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const argv = process.argv.slice(2);
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(o.success ? 0 : 1); };
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const statePath = process.env.MOCK_BAW_STATE;
const state = statePath && fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { previews: {}, signs: {}, log: [] };
const save = () => statePath && fs.writeFileSync(statePath, JSON.stringify(state));
state.log.push(argv.filter((a) => a !== "--json").slice(0, 2).join(" "));
save();

if (!argv.includes("--json")) out({ success: false, error: { code: 1, name: "NO_JSON", message: "--json required by AgentPad tests" } });
const account = privateKeyToAccount(process.env.MOCK_BAW_KEY);
const rpc = process.env.MOCK_BAW_RPC;
const pc = createPublicClient({ transport: http(rpc) });
const wc = createWalletClient({ account, transport: http(rpc) });
const [a, b] = argv;

if (a === "wallet" && b === "address") {
  out({ success: true, data: { addresses: [{ binanceChainId: "CT_501", chainName: "Solana", address: "SoLmock" }, { binanceChainId: "56", chainName: "BSC", address: account.address }] } });
}
if (a === "wallet" && b === "settings") {
  out({ success: true, data: { devMode: { enabled: process.env.MOCK_BAW_DEVMODE !== "false" } } });
}
if (a === "contract-call" && b === "preview") {
  const from = opt("from"); const to = opt("to"); const value = BigInt(opt("value") ?? "0"); const data = opt("inputData") ?? "0x";
  if (opt("binanceChainId") !== "56") out({ success: false, error: { code: 351821, name: "BAD_CHAIN", message: "unsupported chain" } });
  if (from.toLowerCase() !== account.address.toLowerCase()) out({ success: false, error: { code: 351800, name: "NOT_OWNER", message: "from is not the agentic wallet" } });
  try {
    await pc.call({ account: from, to, data, value });
  } catch (e) {
    out({ success: false, error: { code: 351805, name: "SIMULATION_FAILED", message: String(e.shortMessage ?? e.message).slice(0, 300) } });
  }
  const requestId = `req${Object.keys(state.previews).length + 1}${Date.now()}`;
  state.previews[requestId] = { to, value: value.toString(), data };
  save();
  out({ success: true, data: { requestId, parsedTx: { transactionType: "ContractCall", contractAddress: to, amount: Number(value) }, simulationResult: { simulationCode: "000000000", simulationErrorDetail: null, balanceChanges: [], allowanceChanges: [], authorityChanges: [], preCheckCode: "" }, risks: { riskDetails: process.env.MOCK_BAW_RISK ? [{ code: "RISK_001", title: "High Risk Address", description: "flagged", riskType: "RISK", order: 1 }] : [], addresses: {}, riskBehaviors: [] }, tokenInfos: {}, requireConfirmation: process.env.MOCK_BAW_PENDING === "true", expiresAt: Date.now() + 60000 } });
}
if (a === "contract-call" && b === "execute") {
  const p = state.previews[opt("requestId")];
  if (!p) out({ success: false, error: { code: 351810, name: "PREVIEW_EXPIRED", message: "preview expired or unknown requestId" } });
  delete state.previews[opt("requestId")];
  save();
  if (process.env.MOCK_BAW_PENDING === "true") out({ success: true, data: { orderId: "order-pending", status: "PENDING_CONFIRMATION", txHash: null, message: "Please confirm in the Binance App" } });
  const txHash = await wc.sendTransaction({ to: p.to, data: p.data, value: BigInt(p.value), chain: null });
  out({ success: true, data: { orderId: `order-${txHash.slice(2, 10)}`, status: "BROADCASTED", txHash, message: null } });
}
if (a === "sign-message" && b === "preview") {
  const msg = JSON.parse(opt("message"));
  if (msg.method !== "eth_signTypedData_v4" || msg.params[0].toLowerCase() !== account.address.toLowerCase()) out({ success: false, error: { code: 351830, name: "BAD_MESSAGE", message: "bad sign request" } });
  const requestId = `sig${Date.now()}`;
  state.signs[requestId] = msg.params[1];
  save();
  out({ success: true, data: { requestId, parsedMessage: { messageType: "SignTypedData", version: "V4", message: msg.params[1] }, risks: { riskDetails: [], addresses: {}, riskBehaviors: [] }, requireConfirmation: false, expiresAt: Date.now() + 60000 } });
}
if (a === "sign-message" && b === "execute") {
  const td = JSON.parse(state.signs[opt("requestId")]);
  const { EIP712Domain, ...types } = td.types;
  const sig = await account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
  const v = parseInt(sig.slice(130), 16);
  // Return the r||s + separate recovery-id format to exercise SDK normalisation.
  out({ success: true, data: { orderId: "msg-order-1", status: "COMPLETED", signature: sig.slice(2, 130), signatureRecovery: (v - 27).toString(16).padStart(2, "0"), message: null } });
}
out({ success: false, error: { code: 404, name: "UNKNOWN_COMMAND", message: `mock baw: unsupported ${a} ${b}` } });
