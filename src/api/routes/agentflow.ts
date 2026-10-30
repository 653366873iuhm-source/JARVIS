/**
 * One-command agent flow (ChyAI airdrop → credential → mining → daily check-in) for AI agents running the
 * Binance Agentic Wallet (baw CLI).
 *
 *   GET /agent.md, /v1/agent.md        the agent instructions (markdown skill; exact baw commands + API calls)
 *   GET /v1/agent/flow?wallet=0x…      machine-readable state of one wallet: each step done / todo / waiting,
 *                                      with the exact command for the next step (mint calldata, check-in message)
 *
 * Nothing is broadcast or signed here: every state-changing step runs in the user's own agent wallet and needs the
 * user's approval (baw preview → user confirms → execute; Binance App approval when requireConfirmation=true).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../../context.js";
import { airdropStatus, normalizeWallet } from "../../services/airdrop.js";
import { issueCredentialVoucher } from "../../services/credential.js";
import { getMining } from "../../services/mining.js";
import { ApiError } from "../../services/registration.js";
import { checksum } from "../../lib/util.js";
import { normalizeRef } from "../../services/invites.js";
import { minPoolWei } from "../../services/rewards.js";
import { formatEther } from "viem";
import { chyaiAddresses, chyaiAgentMarkdown } from "./chyai.js";

export const OFFICIAL_X = "https://x.com/ChyAI_Official";
export const PINNED_POST = "https://x.com/ChyAI_Official/status/2115430735167607129";

export function apiBase(req: FastifyRequest): string {
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() || req.protocol || "https";
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "agentpad-api.onrender.com").split(",")[0]!.trim();
  return `${host.startsWith("localhost") || host.startsWith("127.") ? proto : "https"}://${host}`;
}

/** The copyable one-command prompt a user gives their AI agent (also embedded in the site). */
export function agentPrompt(base: string, ref?: string | null) {
  const r = ref ? normalizeRef(ref) : null;
  return [
    `请用我的 Binance Agentic Wallet（baw CLI）按 ${base}/agent.md 的步骤，帮我跑完 ChyAI 空投全流程：申请 → 核验 → mint 凭证 → 开始挖矿 → 每日签到。`,
    `我的 X 用户名：<你的X用户名>；我引用转发/回复 ChyAI 置顶帖的链接：<帖子链接>。`,
    ...(r ? [`邀请人：${r}（申请时在 claim 里带上 "ref":"${r}"）。`] : []),
    `钱包和 .ai 名称从 baw 读取。每笔交易和签名先给我看 preview，我确认后再 execute；之后每天自动签到一次。`,
  ].join("\n");
}

/** CHYAI sale prompt (after the 2026-10-30 pivot). */
export function chyaiPrompt(base: string) {
  return [
    `请用我的 Binance Agentic Wallet（baw CLI）按 ${base}/agent.md 的步骤，帮我参与 ChyAI 平台币 CHYAI 打新：先读 ${base}/v1/chyai 看当前阶段和价格，再用 ${base}/v1/chyai/buy 生成的 baw 步骤购买 <份数> 份（每个 Agent ID 每阶段最多 10 份），用 USDT 支付。`,
    `如果我是老矿工，开池后再用 ${base}/v1/chyai/airdrop/<我的钱包> 领取 10,000 CHYAI 空投。`,
    `每笔交易先给我看 preview，我确认后再 execute。`,
  ].join("\n");
}

export function agentMarkdown(base: string, chainId: number, minPool = "0.01") {
  const api = `${base}/v1`;
  return `# ChyAI 空投 → 凭证 → 挖矿 · Agent 一键流程

You are an AI agent with the **Binance Agentic Wallet** (\`baw\` CLI, always append \`--json\`). Run the whole ChyAI
airdrop for your user. Manual clicks on the website alone never mint a credential and never start mining: the
credential must be minted **from the Agentic Wallet that holds the user's .ai Agent ID**.

API base: \`${api}\` · chain: BSC (binanceChainId ${chainId}) · official X: ${OFFICIAL_X} · pinned post: ${PINNED_POST}

Rules: never invent calldata — always use what the API returns. Every \`baw contract-call\` / \`baw sign-message\` is
two-step: run \`preview\`, show the user the parsed tx / message and risks, wait for an explicit yes, then \`execute\`
with the \`requestId\`. If preview fails, stop and report the error. Re-running any step is safe (all endpoints are idempotent).

## 0. Wallet (agent)
\`\`\`
baw wallet address --json          # BSC address = <WALLET>
baw wallet settings --json         # devMode.enabled must be true
\`\`\`
If Developer Mode is off → **human step**: enable it in the Binance App (Agentic Wallet → settings → Developer Mode).
The wallet's .ai name: \`GET ${api}/agent/flow?wallet=<WALLET>\` → \`agentName\` (read on-chain from the Binance Agent ID registry).
No .ai name → this wallet cannot take part (only Binance Agent ID wallets can mint).

## 1. X post (human, unless you control the user's X account)
Follow ${OFFICIAL_X}, then **quote** or **reply to** the pinned post ${PINNED_POST}. Plain retweets have no link and are rejected.
Ask the user for the X handle and the link of that quote/reply.

## 2. Apply (agent)
\`\`\`
curl -s -X POST ${api}/airdrop/claim -H 'content-type: application/json' \\
  -d '{"xHandle":"<handle>","wallet":"<WALLET>","agentName":"<name>.ai","repostUrl":"https://x.com/<handle>/status/<id>","ref":"<inviter>.ai"}'
\`\`\`
\`ref\` is optional: the inviter's .ai name (or wallet) from the user's invite link (\`…/airdrop?ref=<inviter>.ai\`).
Leave it out when the user has none. It is bound once, on the first application; the response's \`invite\` says whether it was bound.
201 = new claim, 200 = already applied (returns the same claim; \`existing:true\`). \`status\`: \`approved\` → step 3;
\`pending_verification\` → poll \`GET ${api}/airdrop/status?wallet=<WALLET>\` every 10 min; 422 → read \`error.message\`, fix the link, submit again.

## 3. Mint the credential (agent; user approves)
**Approved ≠ credential.** Approval only unlocks the voucher; the credential exists after this transaction.
\`\`\`
curl -s "${api}/airdrop/voucher?wallet=<WALLET>"
\`\`\`
For each item of \`steps[]\` in order: check \`simulation.ok == true\`, run its \`baw\` field exactly
(\`baw contract-call preview --binanceChainId ${chainId} --from <WALLET> --to <to> --value 0 --inputData <data> --json\`),
show the preview, then \`baw contract-call execute --requestId <requestId> --json\`. If \`requireConfirmation=true\` →
**human step**: approve the order in the Binance App. Gas ≈ 200k gas (< 0.0001 BNB) is paid by the wallet.
\`minted:true\` in the voucher response = already done. The voucher expires (\`deadline\`); just fetch a fresh one.

## 4. Mining (automatic)
Mining starts by itself within ~2 minutes of the mint. Check: \`GET ${api}/mining/<WALLET>\` → \`mining:true\`,
\`credential.active:true\`. \`status:"no_credential"\` means the mint has not landed yet (未 mint 凭证 → 不挖矿).

## 5. Daily check-in (agent, once per UTC day; user approves the signature)
\`\`\`
curl -s ${api}/mining/<WALLET>      # → checkin.checkedInToday, checkin.baw.preview
\`\`\`
Run \`checkin.baw.preview\` exactly (EIP-712, signs only today's date — no funds move), show it, then
\`baw sign-message execute --requestId <requestId> --json\` (if PENDING_CONFIRMATION: user approves in the Binance App,
then \`baw sign-message result --order-id <orderId> --json\`). Submit:
\`\`\`
curl -s -X POST ${api}/mining/checkin -H 'content-type: application/json' \\
  -d '{"wallet":"<WALLET>","signType":"eip712","signature":"<signature>","signatureRecovery":"<signatureRecovery>"}'
\`\`\`
409 \`already_checked_in\` = done for today. Repeat daily (schedule it if you can).

## 6. Invites (optional)
Once the credential is minted, the user has an invite link: \`GET ${api}/airdrop/invites/<WALLET>\` → \`link\`
(\`…/airdrop?ref=<name>.ai\`). Each invitee who applies with that ref and mints a credential adds +5% mining speed
(up to +50%). No self-invites. Leaderboard: \`GET ${api}/airdrop/invites/leaderboard\`.

## 7. Claim promotion rewards (agent; user approves the tx)
Reward roots are posted on-chain by the platform in the daily settlement, but only once the reward pool
(RewardPool.unallocated) reaches ${minPool} BNB. Below that nothing is posted and the pool rolls over; the settlement that
reaches it pays out the whole accumulated pool, scored over every day since the last settlement.
（BNB 奖励在奖励池达到 ${minPool} BNB 时才结算；未达到时顺延累积，达到后一次结算全部累积的奖励池，未结算的每一天的推广/推荐都计入。）
Pool and threshold: \`GET ${api}/rewards\` → \`pool\`. Check what the wallet can claim:
\`\`\`
curl -s ${api}/rewards/<WALLET>/proof   # → rewards[]: { epoch, amount (wei), proof, claimed, rewardPool, calldata }
\`\`\`
For each item with \`claimed:false\`, send the returned \`calldata\` to \`rewardPool\` with value 0 — never build it yourself:
\`baw contract-call preview --binanceChainId ${chainId} --from <WALLET> --to <rewardPool> --value 0 --inputData <calldata> --json\`,
show the preview, then \`baw contract-call execute --requestId <requestId> --json\`. The amount is paid in BNB to the wallet.
Claim within the epoch's claim window (RewardPool.CLAIM_WINDOW; afterwards unclaimed amounts may return to the pool). Claiming costs gas — skip amounts smaller than the fee.

## One call for the current state
\`GET ${api}/agent/flow?wallet=<WALLET>\` → \`steps[]\` (done / todo / waiting / blocked) and \`next\` with the exact command.

Points convert to the platform token by rules announced later; no promised returns. ChyAI is independent of Binance.
`;
}

type FlowStep = { id: string; who: "agent" | "human" | "auto"; state: "done" | "todo" | "waiting" | "blocked"; detail?: string; command?: unknown };

export async function agentFlow(ctx: AppContext, walletIn: string, base: string) {
  const wallet = normalizeWallet(walletIn);
  const api = `${base}/v1`;
  const st = await airdropStatus(ctx, wallet);
  const res = ctx.resolver as unknown as { nameOf?: (w: string) => Promise<string | null> };
  const onchainName = typeof res.nameOf === "function" ? await res.nameOf(checksum(wallet)).catch(() => null) : null;
  const agentName = (st as { agentId?: string | null }).agentId ?? (onchainName ? (onchainName.endsWith(".ai") ? onchainName : `${onchainName}.ai`) : null);
  const steps: FlowStep[] = [];
  const claimed = st.claimed;
  const status = (st as { status?: string }).status;
  steps.push({ id: "x_post", who: "human", state: claimed ? "done" : "todo", detail: `Quote or reply to ${PINNED_POST}` });
  steps.push({
    id: "apply", who: "agent",
    state: !claimed ? "todo" : status === "approved" ? "done" : status === "rejected" ? "blocked" : "waiting",
    detail: claimed ? (st as { message?: string }).message : undefined,
    command: claimed && status === "approved" ? undefined : { method: "POST", url: `${api}/airdrop/claim`, body: { xHandle: "<handle>", wallet: checksum(wallet), agentName: agentName ?? "<name>.ai", repostUrl: "<quote/reply link>" } },
  });
  const minted = !!st.credential?.active;
  let mintStep: FlowStep = { id: "mint_credential", who: "agent", state: minted ? "done" : status === "approved" ? "todo" : "waiting" };
  if (!minted && status === "approved") {
    try {
      const v = await issueCredentialVoucher(ctx, wallet);
      mintStep = { ...mintStep, state: v.minted ? "done" : "todo", detail: "Approved ≠ credential: send this from the Agentic Wallet (baw), user approves", command: v.steps };
    } catch (e) {
      mintStep = { ...mintStep, state: "blocked", detail: e instanceof ApiError ? `${e.code}: ${e.message}` : String(e) };
    }
  }
  steps.push(mintStep);
  let m: Awaited<ReturnType<typeof getMining>> | null = null;
  try {
    m = await getMining(ctx, wallet);
  } catch {
    m = null;
  }
  steps.push({ id: "mining", who: "auto", state: m?.mining ? "done" : "waiting", detail: m?.mining ? `mining ${m.ratePerDay}/day` : "未 mint 凭证 → 不挖矿" });
  steps.push({
    id: "daily_checkin", who: "agent",
    state: !m?.mining ? "waiting" : m.checkin.checkedInToday ? "done" : "todo",
    command: m?.mining && !m.checkin.checkedInToday ? m.checkin.baw : undefined,
  });
  const next = steps.find((s) => s.state === "todo" || s.state === "blocked") ?? steps.find((s) => s.state === "waiting") ?? null;
  return { wallet: checksum(wallet), agentName, next: next?.id ?? "done", steps, instructions: `${base}/agent.md`, points: m?.points ?? "0" };
}

export function registerAgentFlowRoutes(app: FastifyInstance, ctx: AppContext) {
  const frozen = () => ctx.cfg.MINING_FROZEN_AT > 0; // CHYAI pivot: agent.md describes the token sale instead
  const md = async (req: FastifyRequest, reply: any) =>
    reply
      .header("content-type", "text/markdown; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .send(frozen() ? chyaiAgentMarkdown(apiBase(req), ctx.cfg.CHAIN_ID, chyaiAddresses(ctx)) : agentMarkdown(apiBase(req), ctx.cfg.CHAIN_ID, formatEther(minPoolWei(ctx.cfg))));
  app.get("/agent.md", md);
  app.get("/v1/agent.md", md);
  app.get<{ Querystring: { ref?: string } }>("/v1/agent/prompt", async (req) =>
    frozen()
      ? { prompt: chyaiPrompt(apiBase(req)), instructions: `${apiBase(req)}/agent.md` }
      : { prompt: agentPrompt(apiBase(req), req.query.ref), instructions: `${apiBase(req)}/agent.md` },
  );
  app.get<{ Querystring: { wallet?: string } }>("/v1/agent/flow", async (req) =>
    frozen()
      ? { closed: true, detail: "The airdrop credential / mining / check-in flow ended on 2026-10-30. See /v1/chyai (CHYAI sale) and /v1/chyai/airdrop/<wallet> (10,000 CHYAI for past miners).", instructions: `${apiBase(req)}/agent.md`, next: "chyai_sale" }
      : agentFlow(ctx, String(req.query.wallet ?? ""), apiBase(req)),
  );
}
