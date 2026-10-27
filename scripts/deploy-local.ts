/**
 * Local dev: deploy contracts + mocks to a running Hardhat node and write deployments/local.json.
 *   (cd ../contracts && npx hardhat node)   # terminal 1
 *   npm run deploy:local                    # terminal 2  -> then DEPLOYMENTS_FILE=deployments/local.json npm run dev
 * Platform signer = Hardhat account #1 (its key goes to SIGNER_PRIVATE_KEY), treasury = account #2.
 */
import fs from "node:fs";
import { mnemonicToAccount } from "viem/accounts";
import { makeChain, makePublicClient } from "../src/chain/client.js";
import { deployAll } from "./lib/deploy.js";

const MNEMONIC = "test test test test test test test test test test test junk";
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const cfg = { RPC_URL: rpcUrl, CHAIN_ID: Number(process.env.CHAIN_ID ?? 31337) };
const deployer = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const signer = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const treasury = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
const d = await deployAll({ pc: makePublicClient(cfg), chain: makeChain(cfg), rpcUrl, deployer, platformSigner: signer.address, treasury: treasury.address });
fs.mkdirSync("deployments", { recursive: true });
fs.writeFileSync("deployments/local.json", JSON.stringify(d, null, 2));
console.log(JSON.stringify(d, null, 2));
console.log(`\nSIGNER_PRIVATE_KEY=0x${Buffer.from(signer.getHdKey().privateKey!).toString("hex")}`);
