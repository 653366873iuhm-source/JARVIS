#!/usr/bin/env node
/**
 * agentpad CLI — thin wrapper over @agentpad/sdk for agents and the Binance agent skill.
 * Every command prints one JSON object: {"success":true,"data":…} or {"success":false,"error":{…}}.
 *
 * Signers:  --signer key   (env AGENTPAD_PRIVATE_KEY)
 *           --signer baw   (Binance Agentic Wallet via `baw`; without --yes it stops after preview and returns it)
 *           --dry-run      (simulate and print the raw {to,value,data} instead of sending; use with `baw contract-call preview`)
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, bscTestnet } from "viem/chains";
import { AgentPad } from "./client.js";
import { AgentPadApi } from "./api.js";
import { DEPLOYMENTS, type Deployment } from "./constants.js";
import { lintPromotionPost, buildPromotionPost } from "./promotion.js";
import { pinningFromEnv } from "./pinning.js";
import { BawSigner, type BawPreview } from "./signers/baw.js";
import { ViemSigner } from "./signers/viem.js";
import type { AgentSigner, TxRequest } from "./signers/types.js";
import { AgentPadError } from "./errors.js";

type Flags = Record<string, string | boolean | string[]>;

function parseArgs(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      const v: string | boolean = next !== undefined && !next.startsWith("--") ? (i++, next) : true;
      if (k in flags) flags[k] = ([] as string[]).concat(flags[k] as any, v as any);
      else flags[k] = v;
    } else pos.push(a);
  }
  return { pos, flags };
}

const str = (f: Flags, k: string, env?: string): string | undefined => {
  const v = f[k];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[v.length - 1];
  return env ? process.env[env] || undefined : undefined;
};
const list = (f: Flags, k: string): string[] => {
  const v = f[k];
  if (v === undefined || v === true) return [];
  return ([] as string[]).concat(v as any).flatMap((x) => String(x).split(",")).filter(Boolean);
};

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
function print(o: unknown, code = 0): never {
  process.stdout.write(JSON.stringify(o, replacer, 2) + "\n");
  process.exit(code);
}

class CapturedTx extends Error {
  constructor(public tx: TxRequest) {
    super("captured");
  }
}

class CaptureSigner implements AgentSigner {
  readonly kind = "capture";
  constructor(private readonly addr: Address) {}
  async getAddress() {
    return this.addr;
  }
  async sendTransaction(tx: TxRequest): Promise<Hex> {
    throw new CapturedTx(tx);
  }
  async signTypedData(): Promise<Hex> {
    throw new Error("--dry-run cannot sign typed data");
  }
}

class NeedsConfirmation extends Error {
  constructor(public preview: BawPreview, public tx: TxRequest) {
    super("needs_confirmation");
  }
}

function loadDeployment(f: Flags, chainId: number): Deployment {
  const file = str(f, "deployment", "AGENTPAD_DEPLOYMENT");
  if (file) {
    const j = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
    const c = j.contracts ?? j;
    return { chainId: j.chainId ?? chainId, AgentRegistry: c.AgentRegistry, LaunchFactory: c.LaunchFactory, FeeSplitter: c.FeeSplitter, RewardPool: c.RewardPool, TraitRandomness: c.TraitRandomness, fromBlock: j.fromBlock !== undefined ? BigInt(j.fromBlock) : undefined };
  }
  const d = DEPLOYMENTS[chainId];
  if (!d) throw new Error(`no deployment for chain ${chainId}: pass --deployment <contracts/deployments/<net>.json> or AGENTPAD_DEPLOYMENT`);
  return d;
}

async function build(f: Flags) {
  const chainId = Number(str(f, "chain-id", "AGENTPAD_CHAIN_ID") ?? 56);
  const rpc = str(f, "rpc", "AGENTPAD_RPC_URL") ?? (chainId === 97 ? "https://data-seed-prebsc-1-s1.bnbchain.org:8545" : "https://bsc-dataseed.bnbchain.org");
  const chain = chainId === 56 ? bsc : chainId === 97 ? bscTestnet : defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const publicClient = createPublicClient({ chain, transport: http(rpc) }) as any;
  const deployment = loadDeployment(f, chainId);
  const apiUrl = str(f, "api", "AGENTPAD_API_URL");
  const api = apiUrl ? new AgentPadApi({ baseUrl: apiUrl }) : undefined;
  let signer: AgentSigner | undefined;
  const mode = str(f, "signer", "AGENTPAD_SIGNER") ?? (process.env.AGENTPAD_PRIVATE_KEY ? "key" : undefined);
  const from = str(f, "from", "AGENTPAD_WALLET") as Address | undefined;
  if (f["dry-run"]) {
    let addr = from;
    if (!addr && mode === "key" && process.env.AGENTPAD_PRIVATE_KEY) addr = privateKeyToAccount(process.env.AGENTPAD_PRIVATE_KEY as Hex).address;
    if (!addr && mode === "baw") addr = await new BawSigner({ bin: str(f, "baw-bin", "BAW_BIN") }).getAddress();
    if (!addr) throw new Error("--dry-run needs --from <wallet> (or a signer to derive it)");
    signer = new CaptureSigner(addr);
  } else if (mode === "key") {
    const pk = process.env.AGENTPAD_PRIVATE_KEY as Hex | undefined;
    if (!pk) throw new Error("AGENTPAD_PRIVATE_KEY not set");
    signer = new ViemSigner(createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(rpc) }) as any);
  } else if (mode === "baw") {
    const yes = !!f["yes"];
    signer = new BawSigner({
      bin: str(f, "baw-bin", "BAW_BIN"),
      binanceChainId: str(f, "binance-chain-id") ?? String(chainId),
      address: from,
      autoApprove: yes,
      confirm: yes ? undefined : (p, tx) => {
        throw new NeedsConfirmation(p, tx);
      },
      pending: f["wait-app"] ? "poll" : "throw",
      publicClient,
    });
  }
  const pad = new AgentPad({ publicClient, signer, deployment, api, slippageBps: str(f, "slippage-bps") ? BigInt(str(f, "slippage-bps")!) : undefined });
  return { pad, publicClient, deployment, chainId };
}

const HELP = `agentpad <command> [args] [--flags]

Global: --rpc URL --chain-id 56|97|… --deployment file.json --api URL
        --signer key|baw  --from 0xWallet  --yes (baw: execute after preview)  --dry-run  --slippage-bps 50

Commands:
  status [--wallet 0x]                         registration + launch cooldown
  register --agent-id x.ai --x-handle h [--intent launch|trade] --tweet-url URL [--eligibility-urls U1,U2,...]
  register-request --agent-id x.ai --x-handle h [--intent] [--tweet-url URL] [--eligibility-urls U1,U2,...]
                                               (no X search: post the code, then pass the post URL; launch needs
                                                >= 10 own post URLs from the last 30 days)
  eligibility-submit --urls U1,U2,...          fresh eligibility posts for the 30-day re-check (wallet-signed)
  register-submit --agent-id x.ai              wait for platform signature and register on-chain
  upload --name N --symbol S --story T --image f.png [--image layer.png] [--token-files 10000]
  launch --name N --symbol S (--base-uri ipfs://cid/ | --story T --image f.png)
  projects [--phase trading|promotion|graduated] [--limit 20]
  project <addr>
  quote mint|sell <addr> <count>
  mint <addr> <count> [--max-total-bnb 0.5]
  sell <addr> <count> | sell <addr> --ids 1,2,3   (alias: burn; uses BondingNFT.sell on v2 projects)
  holdings <addr> [--wallet 0x] [--from-block N]
  promo-code <addr>
  promo-post <addr> [--text "..."] [--story-line "..."]   build/lint a promotion post (does not post), prints next step
  promo-submit <addr> --url URL                submit your posted promotion URL (quote-post, not a plain retweet)
  claim-exemption <addr>
  redeem <addr> [--ids 1,2]
  deposit <addr> <count>
  claim-rewards
  fees | withdraw-fees [--to 0x]
  graduate <addr>
`;

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  if (!cmd || cmd === "help" || flags.help) {
    process.stdout.write(HELP);
    return;
  }
  const { pad, deployment } = await build(flags);
  const addrArg = () => {
    const a = pos[1] as Address | undefined;
    if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error("project address required");
    return a;
  };
  const wallet = async () => (str(flags, "wallet") as Address | undefined) ?? (await pad.address());

  switch (cmd) {
    case "status": {
      const w = await wallet();
      const s = await pad.getAgent(w);
      const next = s.registered ? await pad.nextLaunchAt(w) : 0n;
      return print({ success: true, data: { ...s, nextLaunchAt: next, fees: await pad.feeBalance(w) } });
    }
    case "register-request": {
      const r = await pad.requestRegistration({ agentId: str(flags, "agent-id")!, xHandle: str(flags, "x-handle")!, intent: (str(flags, "intent") as any) ?? "launch", xProofTweetUrl: str(flags, "tweet-url"), eligibilityPostUrls: list(flags, "eligibility-urls") });
      return print({ success: true, data: r });
    }
    case "register-submit": {
      const sig = await pad.waitForRegistrationSignature(str(flags, "agent-id")!, { timeoutMs: Number(str(flags, "timeout-ms") ?? 600_000) });
      const tx = await pad.submitRegistration(sig);
      return print({ success: true, data: { txHash: tx.hash, status: await pad.getAgent() } });
    }
    case "register": {
      const r = await pad.register({ agentId: str(flags, "agent-id")!, xHandle: str(flags, "x-handle")!, intent: (str(flags, "intent") as any) ?? "launch", xProofTweetUrl: str(flags, "tweet-url"), eligibilityPostUrls: list(flags, "eligibility-urls"), timeoutMs: Number(str(flags, "timeout-ms") ?? 600_000) });
      return print({ success: true, data: { skipped: !!r.skipped, txHash: r.tx?.hash, status: r.status } });
    }
    case "upload":
    case "launch": {
      let baseURI = str(flags, "base-uri");
      let assets: unknown;
      if (!baseURI) {
        const images = list(flags, "image").map((p) => ({ name: path.basename(p), content: new Uint8Array(fs.readFileSync(p)) }));
        const a = await pad.uploadLaunchAssets(pinningFromEnv(), { name: str(flags, "name")!, symbol: str(flags, "symbol")!, story: str(flags, "story") ?? (str(flags, "story-file") ? fs.readFileSync(str(flags, "story-file")!, "utf8") : ""), images, agentId: str(flags, "agent-id"), tokenFileCount: str(flags, "token-files") ? Number(str(flags, "token-files")) : undefined });
        baseURI = a.baseURI;
        assets = { baseURI: a.baseURI, imagesURI: a.imagesURI, coverImage: a.coverImage, pinning: pinningFromEnv().name };
      }
      if (cmd === "upload") return print({ success: true, data: assets });
      const r = await pad.launch({ name: str(flags, "name")!, symbol: str(flags, "symbol")!, baseURI });
      return print({ success: true, data: { txHash: r.hash, project: r.project, token: r.token, index: r.index, baseURI: r.baseURI, assets } });
    }
    case "projects":
      return print({ success: true, data: await pad.listProjects({ phase: str(flags, "phase") as any, limit: Number(str(flags, "limit") ?? 20) }) });
    case "project":
      return print({ success: true, data: await pad.getProject(addrArg()) });
    case "quote": {
      const side = pos[1];
      const project = pos[2] as Address;
      const n = BigInt(pos[3] ?? "1");
      const q = side === "burn" || side === "sell" ? await pad.quoteBurn(project, n) : await pad.quoteMint(project, n);
      return print({ success: true, data: { side, ...q, human: Object.fromEntries(Object.entries(q).filter(([k]) => k !== "count" && k !== "newVirtualBnb").map(([k, v]) => [k, `${formatEther(v as bigint)} BNB`])) } });
    }
    case "mint": {
      const max = str(flags, "max-total-bnb");
      const r = await pad.mint(addrArg(), BigInt(pos[2] ?? "1"), { maxTotal: max ? parseEther(max) : undefined });
      return print({ success: true, data: { txHash: r.hash, tokenIds: r.tokenIds, cost: r.cost, fee: r.fee, totalBnb: formatEther(r.cost + r.fee) } });
    }
    case "sell":
    case "burn": {
      const ids = list(flags, "ids").map(BigInt);
      const r = await pad.sell(addrArg(), ids.length ? ids : BigInt(pos[2] ?? "1"), { fromBlock: str(flags, "from-block") ? BigInt(str(flags, "from-block")!) : undefined });
      return print({ success: true, data: { txHash: r.hash, tokenIds: r.tokenIds, gross: r.gross, fee: r.fee, net: r.net, netBnb: formatEther(r.net) } });
    }
    case "holdings":
      return print({ success: true, data: await pad.getHoldings(addrArg(), await wallet(), { fromBlock: str(flags, "from-block") ? BigInt(str(flags, "from-block")!) : undefined }) });
    case "promo-code":
      return print({ success: true, data: await pad.getPromotionCode(addrArg()) });
    case "promo-post": {
      const project = addrArg();
      const code = await pad.getPromotionCode(project);
      const info = await pad.getProject(project);
      const text = str(flags, "text") ?? buildPromotionPost({ name: info.name, symbol: info.symbol, storyLine: str(flags, "story-line") ?? info.api?.story ?? undefined, code });
      const lint = lintPromotionPost(text, code);
      process.stderr.write(`${text}\n\n# post the text above from your bound X account (or quote-post with it; plain retweets can't be verified), then:\n# agentpad promo-submit ${project} --url <your post URL>\n`);
      return print({ success: true, data: { text, lint, code, next: `agentpad promo-submit ${project} --url <post URL>` } });
    }
    case "promo-submit": {
      const url = str(flags, "url") ?? pos[2];
      if (!url) throw new Error("--url <post URL> required");
      return print({ success: true, data: await pad.submitPromotionPost(addrArg(), url) });
    }
    case "eligibility-submit": {
      const urls = list(flags, "urls");
      if (urls.length === 0) throw new Error("--urls U1,U2,... required");
      return print({ success: true, data: await pad.submitEligibilityPosts(urls) });
    }
    case "claim-exemption":
      return print({ success: true, data: await pad.claimPromoterExemption(addrArg()) });
    case "redeem": {
      const ids = list(flags, "ids").map(BigInt);
      const r = await pad.redeem(addrArg(), ids.length ? ids : undefined);
      return print({ success: true, data: { txHash: r.hash, tokenIds: r.tokenIds, tokens: r.tokens } });
    }
    case "deposit": {
      const r = await pad.deposit(addrArg(), BigInt(pos[2] ?? "1"));
      return print({ success: true, data: { txHash: r.hash, approveTx: r.approveTx?.hash, tokenIds: r.tokenIds } });
    }
    case "claim-rewards":
      return print({ success: true, data: await pad.claimRewards() });
    case "fees":
      return print({ success: true, data: { balance: await pad.feeBalance(await wallet()) } });
    case "withdraw-fees": {
      const r = await pad.withdrawFees(str(flags, "to") as Address | undefined);
      return print({ success: true, data: { txHash: r.hash } });
    }
    case "graduate": {
      const r = await pad.graduate(addrArg());
      return print({ success: true, data: { txHash: r.hash } });
    }
    default:
      void deployment;
      throw new Error(`unknown command ${cmd} (agentpad help)`);
  }
}

main().catch((e) => {
  if (e instanceof CapturedTx) {
    print({ success: true, data: { dryRun: true, tx: { to: e.tx.to, value: (e.tx.value ?? 0n).toString(), data: e.tx.data, description: e.tx.description }, bawPreview: `baw contract-call preview --binanceChainId 56 --from <wallet> --to ${e.tx.to} --value ${(e.tx.value ?? 0n).toString()} --inputData ${e.tx.data} --json` } });
  }
  const cause = e?.cause instanceof NeedsConfirmation ? e.cause : e instanceof NeedsConfirmation ? e : null;
  if (cause) {
    print({ success: false, error: { code: "needs_confirmation", message: "Show this preview to the user. Re-run with --yes after explicit approval, or run `baw contract-call execute --requestId <id> --json`.", requestId: cause.preview.requestId, preview: cause.preview, tx: cause.tx } }, 3);
  }
  const ap = e instanceof AgentPadError ? e : null;
  print({ success: false, error: { code: ap ? ap.errorName : e?.code ?? e?.name ?? "error", message: String(e?.message ?? e) } }, 1);
});
