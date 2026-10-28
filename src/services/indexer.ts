import { and, eq, inArray, sql } from "drizzle-orm";
import type { AbiEvent, Address, Log } from "viem";
import type { AppContext } from "../context.js";
import type { DB } from "../db/index.js";
import { AgentRegistryAbi, BondingNFTAbi, LaunchFactoryAbi, RewardPoolAbi } from "../chain/abi.js";
import { MAX_CURVE_NFTS, TOKENS_PER_NFT, VIRTUAL_BNB0, VIRTUAL_TOKEN0, nftPrice } from "../lib/curve.js";
import { chunk, jsonStringify, lc } from "../lib/util.js";
import { invalidateLeaderboard } from "./market.js";

const events = (abi: readonly any[], names: string[]) => abi.filter((e) => e.type === "event" && names.includes(e.name)) as AbiEvent[];
const REGISTRY_EVENTS = events(AgentRegistryAbi, ["AgentRegistered", "LaunchRevoked", "AgentRemoved"]);
const FACTORY_EVENTS = events(LaunchFactoryAbi, ["Launched"]);
const PROJECT_EVENTS = events(BondingNFTAbi, [
  "Minted", "Burned", "Transfer", "TransferDeferred", "PromotionStarted", "PromotionAttested", "Graduated", "PromoterExempted", "Redeemed", "Deposited",
]);
const POOL_EVENTS = events(RewardPoolAbi, ["RootPosted", "Claimed", "EpochClosed"]);

/** PancakeSwap V2 (UniswapV2) pair: the graduated project's pool. */
export const PancakePairAbi = [
  { type: "event", name: "Sync", anonymous: false, inputs: [{ name: "reserve0", type: "uint112", indexed: false }, { name: "reserve1", type: "uint112", indexed: false }] },
  {
    type: "event", name: "Swap", anonymous: false,
    inputs: [
      { name: "sender", type: "address", indexed: true }, { name: "amount0In", type: "uint256", indexed: false }, { name: "amount1In", type: "uint256", indexed: false },
      { name: "amount0Out", type: "uint256", indexed: false }, { name: "amount1Out", type: "uint256", indexed: false }, { name: "to", type: "address", indexed: true },
    ],
  },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ name: "reserve0", type: "uint112" }, { name: "reserve1", type: "uint112" }, { name: "blockTimestampLast", type: "uint32" }] },
] as const;
const PAIR_EVENTS = events(PancakePairAbi as unknown as any[], ["Sync", "Swap"]);

/** Pool price of one NFT (80k tokens) in wei from the pair reserves. */
export const poolNftPrice = (reserveBnb: bigint, reserveToken: bigint) => (reserveToken > 0n ? (reserveBnb * TOKENS_PER_NFT) / reserveToken : 0n);

type DecodedLog = Log<bigint, number, false> & { eventName: string; args: any };

export const CURSOR_KEY = "indexer:lastBlock";
export const CURSOR_TS_KEY = "indexer:lastBlockTs";

export function projectTag(symbol: string) {
  return "#AP_" + symbol.toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 20);
}

export async function getKv(ctx: AppContext, key: string): Promise<string | null> {
  const { db, t } = ctx.database;
  const [r] = await db.select().from(t.kv).where(eq(t.kv.key, key));
  return r?.value ?? null;
}
export async function setKv(ctx: AppContext, key: string, value: string) {
  const { db, t } = ctx.database;
  await db.insert(t.kv).values({ key, value }).onConflictDoUpdate({ target: t.kv.key, set: { value } });
}

/** Business clock: wall clock, or the last indexed block time if the chain runs ahead (local time-travel). */
export async function clockNow(ctx: AppContext): Promise<number> {
  const ts = Number((await getKv(ctx, CURSOR_TS_KEY)) ?? 0);
  return Math.max(Math.floor(Date.now() / 1000), ts);
}

export class Indexer {
  private blockTs = new Map<bigint, number>();
  constructor(private ctx: AppContext) {}

  private async ts(block: bigint): Promise<number> {
    let v = this.blockTs.get(block);
    if (v === undefined) {
      v = Number((await this.ctx.pc.getBlock({ blockNumber: block })).timestamp);
      this.blockTs.set(block, v);
      if (this.blockTs.size > 5000) this.blockTs.clear();
    }
    return v;
  }

  /** Index up to `INDEXER_BATCH_BLOCKS` new blocks. Returns the number of blocks processed. */
  async tick(): Promise<number> {
    const { cfg, pc } = this.ctx;
    const head = (await pc.getBlockNumber()) - BigInt(cfg.CONFIRMATIONS);
    const last = await getKv(this.ctx, CURSOR_KEY);
    const from = last === null ? BigInt(cfg.START_BLOCK) : BigInt(last) + 1n;
    if (from > head) return 0;
    const to = from + BigInt(cfg.INDEXER_BATCH_BLOCKS) - 1n < head ? from + BigInt(cfg.INDEXER_BATCH_BLOCKS) - 1n : head;
    await this.processRange(from, to);
    await setKv(this.ctx, CURSOR_KEY, to.toString());
    await setKv(this.ctx, CURSOR_TS_KEY, String(await this.ts(to)));
    return Number(to - from + 1n);
  }

  /** Index until caught up with the head. */
  async syncToHead(): Promise<void> {
    while ((await this.tick()) > 0) {
      /* loop */
    }
    await this.refreshPoolReserves();
  }

  private async processRange(fromBlock: bigint, toBlock: bigint) {
    const { pc, addresses } = this.ctx;
    const { db, t } = this.ctx.database;
    const [regLogs, facLogs, poolLogs] = await Promise.all([
      pc.getLogs({ address: addresses.registry, events: REGISTRY_EVENTS, fromBlock, toBlock }),
      pc.getLogs({ address: addresses.factory, events: FACTORY_EVENTS, fromBlock, toBlock }),
      pc.getLogs({ address: addresses.rewardPool, events: POOL_EVENTS, fromBlock, toBlock }),
    ]);
    // projects must exist before their logs are queried (a project launched in this range emits in this range too)
    for (const l of facLogs as DecodedLog[]) await this.onLaunched(l);
    const projects = (await db.select({ a: t.projects.address }).from(t.projects)).map((r) => r.a as Address);
    const projLogs: DecodedLog[] = [];
    for (const c of chunk(projects, 200)) {
      if (c.length === 0) continue;
      projLogs.push(...((await pc.getLogs({ address: c, events: PROJECT_EVENTS, fromBlock, toBlock })) as DecodedLog[]));
    }
    const all = [...(regLogs as DecodedLog[]), ...projLogs, ...(poolLogs as DecodedLog[])].sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
    );
    if (all.length || facLogs.length) invalidateLeaderboard();
    // Warm the block-timestamp cache BEFORE opening write transactions: an RPC round trip inside db.transaction holds
    // the SQLite write lock, and a slow RPC (rate-limited provider, forked node fetching remote state) then makes
    // concurrent API writes fail with SQLITE_BUSY after the 5 s busy timeout (seen in the BSC-fork E2E run).
    for (const l of all) await this.ts(l.blockNumber!);
    for (const l of all) {
      // event row + its effects commit atomically, so a crash/restart never double-applies a trade
      await db.transaction(async (tx) => {
        if (!(await this.record(l, tx as unknown as DB))) return; // already processed (idempotent re-run)
        await this.handle(l, tx as unknown as DB);
      });
    }
    // PancakeSwap pairs of graduated projects (incl. ones that graduated in this range: their LP-add Sync is in it)
    const pairs = (await db.select({ pair: t.projects.pair }).from(t.projects).where(eq(t.projects.phase, 2))).map((r) => r.pair).filter((x): x is string => !!x);
    if (pairs.length) {
      const pairLogs: DecodedLog[] = [];
      for (const c of chunk(pairs as Address[], 200)) pairLogs.push(...((await pc.getLogs({ address: c, events: PAIR_EVENTS, fromBlock, toBlock })) as DecodedLog[]));
      pairLogs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
      if (pairLogs.length) invalidateLeaderboard();
      for (const l of pairLogs) await this.ts(l.blockNumber!); // see above: no RPC inside write transactions
      for (const l of pairLogs) {
        await db.transaction(async (tx) => {
          if (!(await this.record(l, tx as unknown as DB))) return;
          await this.handlePair(l, tx as unknown as DB);
        });
      }
    }
  }

  private token0Cache = new Map<string, boolean>();
  /** Whether the project token is the pair's token0 (cached in projects.pool_token_is0). */
  private async tokenIs0(p: { address: string; token: string; pair: string | null; poolTokenIs0: boolean | null }): Promise<boolean> {
    if (p.poolTokenIs0 !== null && p.poolTokenIs0 !== undefined) return p.poolTokenIs0;
    const hit = this.token0Cache.get(p.pair!);
    if (hit !== undefined) return hit;
    // throws on RPC failure: the batch is retried on the next tick (cursor not advanced)
    const t0 = (await this.ctx.pc.readContract({ address: p.pair as Address, abi: PancakePairAbi, functionName: "token0" })) as string;
    const is0 = lc(t0) === lc(p.token);
    this.token0Cache.set(p.pair!, is0);
    return is0;
  }

  private async handlePair(l: DecodedLog, db: DB) {
    const { t } = this.ctx.database;
    const pairAddr = lc(l.address);
    const [p] = await db.select().from(t.projects).where(eq(t.projects.pair, pairAddr));
    if (!p) return;
    const is0 = await this.tokenIs0(p);
    const ts = await this.ts(l.blockNumber!);
    const a = l.args;
    if (l.eventName === "Sync") {
      const rb: bigint = is0 ? a.reserve1 : a.reserve0;
      const rt: bigint = is0 ? a.reserve0 : a.reserve1;
      await db
        .update(t.projects)
        .set({
          poolTokenIs0: is0, poolReserveBnb: rb.toString(), poolReserveToken: rt.toString(), poolUpdatedAt: ts, poolUpdatedBlock: Number(l.blockNumber),
          priceWei: poolNftPrice(rb, rt).toString(),
        })
        .where(eq(t.projects.address, p.address));
      return;
    }
    // Swap (UniswapV2 emits Sync right before Swap, so the project row already holds the post-swap reserves)
    const tokenIn: bigint = is0 ? a.amount0In : a.amount1In;
    const bnbIn: bigint = is0 ? a.amount1In : a.amount0In;
    const tokenOut: bigint = is0 ? a.amount0Out : a.amount1Out;
    const bnbOut: bigint = is0 ? a.amount1Out : a.amount0Out;
    const buy = bnbIn > 0n && tokenOut > 0n;
    const bnb = buy ? bnbIn - bnbOut : bnbOut - bnbIn;
    const tok = buy ? tokenOut - tokenIn : tokenIn - tokenOut;
    if (bnb <= 0n || tok <= 0n) return; // flash / degenerate swap
    const price = p.poolReserveBnb && p.poolReserveToken ? poolNftPrice(BigInt(p.poolReserveBnb), BigInt(p.poolReserveToken)) : BigInt(p.priceWei);
    const swap = {
      id: `${l.transactionHash}:${l.logIndex}`, project: p.address, pair: pairAddr, trader: lc(a.to), side: buy ? "buy" : "sell",
      bnbWei: bnb.toString(), tokenWei: tok.toString(), priceWei: price.toString(), blockNumber: Number(l.blockNumber), logIndex: l.logIndex,
      txHash: l.transactionHash!, ts,
    };
    await db.insert(t.poolSwaps).values(swap).onConflictDoNothing();
    await db.update(t.projects).set({ lastTradeAt: ts }).where(eq(t.projects.address, p.address));
    this.ctx.bus.emit("trade", { ...swap, venue: "pool", symbol: p.symbol, name: p.name, progressBps: 10_000 });
  }

  /**
   * Fallback for graduated projects whose pool state was never indexed (START_BLOCK after graduation, or a pair that
   * emits no Sync): read getReserves() at the head.
   */
  async refreshPoolReserves(): Promise<number> {
    const { db, t } = this.ctx.database;
    const rows = await db.select().from(t.projects).where(eq(t.projects.phase, 2));
    let n = 0;
    for (const p of rows) {
      if (!p.pair || p.poolReserveBnb) continue;
      try {
        const is0 = await this.tokenIs0(p);
        const [r0, r1] = (await this.ctx.pc.readContract({ address: p.pair as Address, abi: PancakePairAbi, functionName: "getReserves" })) as readonly [bigint, bigint, number];
        const rb = is0 ? r1 : r0;
        const rt = is0 ? r0 : r1;
        if (rt === 0n) continue;
        const now = await clockNow(this.ctx);
        await db
          .update(t.projects)
          .set({ poolTokenIs0: is0, poolReserveBnb: rb.toString(), poolReserveToken: rt.toString(), poolUpdatedAt: now, priceWei: poolNftPrice(rb, rt).toString() })
          .where(eq(t.projects.address, p.address));
        n++;
      } catch (e) {
        this.ctx.log.warn({ project: p.address, err: String(e) }, "getReserves failed");
      }
    }
    return n;
  }

  /** Inserts the raw event; returns false if it was already indexed. */
  private async record(l: DecodedLog, db: DB): Promise<boolean> {
    const { t } = this.ctx.database;
    const id = `${l.transactionHash}:${l.logIndex}`;
    const res = await db
      .insert(t.chainEvents)
      .values({ id, address: lc(l.address), name: l.eventName, args: jsonStringify(l.args), blockNumber: Number(l.blockNumber), txHash: l.transactionHash!, ts: await this.ts(l.blockNumber!) })
      .onConflictDoNothing()
      .returning({ id: t.chainEvents.id });
    return res.length > 0;
  }

  private async onLaunched(l: DecodedLog) {
    const { db, t } = this.ctx.database;
    if (!(await this.record(l, db))) return;
    const a = l.args;
    const ts = await this.ts(l.blockNumber!);
    await db
      .insert(t.projects)
      .values({
        address: lc(a.project), token: lc(a.token), launcher: lc(a.launcher), agentIdHash: a.agentId, name: a.name, symbol: a.symbol,
        baseUri: a.baseURI, idx: Number(a.index), tag: projectTag(a.symbol), createdAt: ts, createdBlock: Number(l.blockNumber),
        phase: 0, virtualBnb: VIRTUAL_BNB0.toString(), virtualToken: VIRTUAL_TOKEN0.toString(), reserveBnb: "0",
        priceWei: nftPrice(VIRTUAL_BNB0, VIRTUAL_TOKEN0).toString(),
      })
      .onConflictDoNothing();
    this.ctx.bus.emit("project", { type: "launched", project: lc(a.project), launcher: lc(a.launcher), name: a.name, symbol: a.symbol, ts });
  }

  private async handle(l: DecodedLog, db: DB) {
    const { t } = this.ctx.database;
    const a = l.args;
    const addr = lc(l.address);
    const ts = await this.ts(l.blockNumber!);
    switch (l.eventName) {
      // ------------------------------------------------------------ registry
      case "AgentRegistered": {
        const wallet = lc(a.wallet);
        const upd = {
          onchain: true, onchainCanLaunch: a.canLaunch, onchainCanTrade: a.canTrade, expiry: Number(a.expiry), removed: false, updatedAt: ts,
        };
        const [ex] = await db.select({ w: t.agents.wallet }).from(t.agents).where(eq(t.agents.wallet, wallet));
        if (ex) await db.update(t.agents).set(upd).where(eq(t.agents.wallet, wallet));
        else
          await db.insert(t.agents).values({
            wallet, agentId: a.agentIdString.toLowerCase(), agentIdHash: a.agentId, xHandle: "", xHandleHash: a.xHandle, intent: a.canLaunch ? "launch" : "trade",
            canLaunch: a.canLaunch, canTrade: a.canTrade, createdAt: ts, ...upd,
          });
        break;
      }
      case "LaunchRevoked":
        await db.update(t.agents).set({ onchainCanLaunch: false, canLaunch: false, updatedAt: ts }).where(eq(t.agents.wallet, lc(a.wallet)));
        break;
      case "AgentRemoved":
        await db
          .update(t.agents)
          .set({ onchain: false, onchainCanLaunch: false, onchainCanTrade: false, canLaunch: false, canTrade: false, removed: true, updatedAt: ts })
          .where(eq(t.agents.wallet, lc(a.wallet)));
        break;

      // ------------------------------------------------------------ project curve
      case "Minted":
      case "Burned": {
        const [p] = await db.select().from(t.projects).where(eq(t.projects.address, addr));
        if (!p) return;
        const isBuy = l.eventName === "Minted";
        const count = isBuy ? Number(a.count) : (a.tokenIds as bigint[]).length;
        const amount: bigint = isBuy ? a.cost : a.gross;
        let x = BigInt(p.virtualBnb);
        let y = BigInt(p.virtualToken);
        const dy = BigInt(count) * TOKENS_PER_NFT;
        if (isBuy) {
          x += amount;
          y -= dy;
        } else {
          x -= amount;
          y += dy;
        }
        const price = nftPrice(x, y);
        const reserve = BigInt(p.reserveBnb) + (isBuy ? amount : -amount);
        await db
          .update(t.projects)
          .set({
            virtualBnb: x.toString(), virtualToken: y.toString(), reserveBnb: reserve.toString(), priceWei: price.toString(),
            sold: p.sold + (isBuy ? count : -count), supply: p.supply + (isBuy ? count : -count),
            volumeWei: (BigInt(p.volumeWei) + amount).toString(), tradeCount: p.tradeCount + 1, lastTradeAt: ts,
          })
          .where(eq(t.projects.address, addr));
        const trade = {
          id: `${l.transactionHash}:${l.logIndex}`, project: addr, trader: lc(isBuy ? a.buyer : a.seller), side: isBuy ? "buy" : "sell",
          count, bnbWei: amount.toString(), feeWei: (a.fee as bigint).toString(), priceWei: price.toString(),
          firstTokenId: isBuy ? Number(a.firstTokenId) : null, blockNumber: Number(l.blockNumber), logIndex: l.logIndex, txHash: l.transactionHash!, ts,
        };
        await db.insert(t.trades).values(trade).onConflictDoNothing();
        this.ctx.bus.emit("trade", { ...trade, symbol: p.symbol, name: p.name, progressBps: Math.floor(((p.sold + (isBuy ? count : -count)) * 10_000) / MAX_CURVE_NFTS) });
        break;
      }
      case "Transfer": {
        const from = lc(a.from);
        const to = lc(a.to);
        const tokenId = Number(a.tokenId);
        const zero = "0x0000000000000000000000000000000000000000";
        if (to === zero) {
          await db.delete(t.nftTokens).where(and(eq(t.nftTokens.project, addr), eq(t.nftTokens.tokenId, tokenId)));
        } else if (from === zero) {
          await db.insert(t.nftTokens).values({ project: addr, tokenId, owner: to }).onConflictDoUpdate({ target: [t.nftTokens.project, t.nftTokens.tokenId], set: { owner: to } });
        } else {
          await db.update(t.nftTokens).set({ owner: to }).where(and(eq(t.nftTokens.project, addr), eq(t.nftTokens.tokenId, tokenId)));
        }
        break;
      }
      case "TransferDeferred": {
        // BondingNFT v2 sell()/redeem(): the token is retired at once; its Transfer(from -> 0) log follows in a later tx
        await db.delete(t.nftTokens).where(and(eq(t.nftTokens.project, addr), eq(t.nftTokens.tokenId, Number(a.tokenId))));
        break;
      }
      case "PromotionStarted":
        await db.update(t.projects).set({ phase: 1, promotionStart: Number(a.timestamp) }).where(eq(t.projects.address, addr));
        this.ctx.bus.emit("project", { type: "promotion", project: addr, ts });
        break;
      case "PromotionAttested":
        await db
          .update(t.projects)
          .set({ attestationNonce: Number(a.nonce) + 1, promoterRoot: a.promoterRoot, lastShareBps: Number(a.shareBps) })
          .where(eq(t.projects.address, addr));
        break;
      case "Graduated":
        await db
          .update(t.projects)
          .set({ phase: 2, graduatedAt: ts, pair: lc(a.pair), forced: a.forced, reserveBnb: "0" })
          .where(eq(t.projects.address, addr));
        this.ctx.bus.emit("project", { type: "graduated", project: addr, pair: lc(a.pair), forced: a.forced, ts });
        break;
      case "Redeemed":
        await db.update(t.projects).set({ supply: sql`${t.projects.supply} - ${(a.tokenIds as bigint[]).length}` }).where(eq(t.projects.address, addr));
        break;
      case "Deposited":
        await db.update(t.projects).set({ supply: sql`${t.projects.supply} + ${Number(a.count)}` }).where(eq(t.projects.address, addr));
        break;
      case "PromoterExempted":
        break;

      // ------------------------------------------------------------ reward pool
      case "RootPosted":
        await db
          .update(t.rewardEpochs)
          .set({ status: "posted", txHash: l.transactionHash })
          .where(eq(t.rewardEpochs.epoch, Number(a.epoch)));
        break;
      case "Claimed":
        await db
          .update(t.rewardAllocations)
          .set({ claimed: true })
          .where(and(eq(t.rewardAllocations.epoch, Number(a.epoch)), eq(t.rewardAllocations.wallet, lc(a.account))));
        break;
      case "EpochClosed":
        break;
    }
  }
}

export { inArray };
