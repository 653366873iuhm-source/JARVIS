/**
 * Single table definition shared by both dialects (PostgreSQL in prod, SQLite/libSQL in dev/tests).
 * `defineSchema(builders)` is instantiated twice: with sqlite-core builders (schema.sqlite.ts, also the
 * TypeScript type source) and with pg-core builders (schema.pg.ts). Only portable column kinds are used:
 *   text   — strings, addresses (lowercase), wei amounts (decimal strings), JSON blobs
 *   int    — unix seconds, block numbers, counts (pg: bigint mode number)
 *   bool   — booleans (sqlite: integer 0/1)
 */
import * as s from "drizzle-orm/sqlite-core";

export const sqliteBuilders = {
  table: s.sqliteTable,
  text: (n: string) => s.text(n),
  int: (n: string) => s.integer(n),
  bool: (n: string) => s.integer(n, { mode: "boolean" }),
  index: s.index,
  uniqueIndex: s.uniqueIndex,
  primaryKey: s.primaryKey,
};
export type Builders = typeof sqliteBuilders;

export function defineSchema(b: Builders) {
  const { table, text, int, bool, index, uniqueIndex, primaryKey } = b;

  const kv = table("kv", {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
  });

  const agents = table(
    "agents",
    {
      wallet: text("wallet").primaryKey(), // lowercase 0x address
      agentId: text("agent_id").notNull(), // e.g. "alice.ai" (lowercased)
      agentIdHash: text("agent_id_hash").notNull(),
      xHandle: text("x_handle").notNull(), // lowercased, without @
      xHandleHash: text("x_handle_hash").notNull(),
      xUserId: text("x_user_id"),
      walletType: text("wallet_type").notNull().default("eoa"), // eoa | contract
      refCode: text("ref_code"), // referral code (deterministic HMAC of wallet)
      intent: text("intent").notNull(), // launch | trade
      canLaunch: bool("can_launch").notNull().default(false), // as last signed
      canTrade: bool("can_trade").notNull().default(true),
      eligibility: text("eligibility"), // JSON EligibilityResult
      expiry: int("expiry"),
      lastQualifiedAt: int("last_qualified_at"),
      lastCheckedAt: int("last_checked_at"),
      // on-chain mirror (indexer)
      onchain: bool("onchain").notNull().default(false),
      onchainCanLaunch: bool("onchain_can_launch").notNull().default(false),
      onchainCanTrade: bool("onchain_can_trade").notNull().default(false),
      removed: bool("removed").notNull().default(false),
      // sybil
      funder: text("funder"),
      fundingTx: text("funding_tx"),
      fundingCheckedAt: int("funding_checked_at"),
      sybilFlag: bool("sybil_flag").notNull().default(false),
      sybilCluster: text("sybil_cluster"),
      createdAt: int("created_at").notNull(),
      updatedAt: int("updated_at").notNull(),
    },
    (t) => [index("agents_agent_id_idx").on(t.agentId), index("agents_x_idx").on(t.xHandle)],
  );

  const challenges = table("challenges", {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    wallet: text("wallet").notNull(),
    xHandle: text("x_handle").notNull(),
    intent: text("intent").notNull(),
    xCode: text("x_code").notNull(),
    message: text("message").notNull(), // EIP-191 text
    typedData: text("typed_data").notNull(), // EIP-712 JSON (for smart wallets that only sign typed data)
    issuedAt: int("issued_at").notNull(),
    expiresAt: int("expires_at").notNull(),
    usedAt: int("used_at"),
  });

  const projects = table(
    "projects",
    {
      address: text("address").primaryKey(),
      token: text("token").notNull(),
      launcher: text("launcher").notNull(),
      agentIdHash: text("agent_id_hash").notNull(),
      name: text("name").notNull(),
      symbol: text("symbol").notNull(),
      baseUri: text("base_uri").notNull(),
      idx: int("idx").notNull(),
      tag: text("tag").notNull(), // X hashtag agents must use, e.g. #AP_AGC
      createdAt: int("created_at").notNull(),
      createdBlock: int("created_block").notNull(),
      phase: int("phase").notNull().default(0), // 0 trading, 1 promotion, 2 graduated
      virtualBnb: text("virtual_bnb").notNull(),
      virtualToken: text("virtual_token").notNull(),
      reserveBnb: text("reserve_bnb").notNull().default("0"),
      sold: int("sold").notNull().default(0), // live curve NFTs (minted - burned) before graduation
      supply: int("supply").notNull().default(0), // live NFTs
      priceWei: text("price_wei").notNull(), // spot price per NFT (80k tokens) in wei
      volumeWei: text("volume_wei").notNull().default("0"),
      tradeCount: int("trade_count").notNull().default(0),
      lastTradeAt: int("last_trade_at"),
      promotionStart: int("promotion_start"),
      graduatedAt: int("graduated_at"),
      forced: bool("forced"),
      pair: text("pair"),
      promoterRoot: text("promoter_root"),
      attestationNonce: int("attestation_nonce").notNull().default(0),
      lastShareBps: int("last_share_bps"),
      // metadata (<baseURI>collection.json, fetched by the metadata job)
      story: text("story"),
      image: text("image"), // gateway URL of the cover image
      traits: text("traits"), // JSON TraitSpec[] (collection.json `traits`, else the default rarity table)
      metaStatus: text("meta_status"), // null = not fetched yet | ok | error
      metaAttempts: int("meta_attempts").notNull().default(0),
      metaCheckedAt: int("meta_checked_at"),
      // PancakeSwap V2 pool (graduated projects; Sync events / getReserves)
      poolTokenIs0: bool("pool_token_is0"),
      poolReserveBnb: text("pool_reserve_bnb"),
      poolReserveToken: text("pool_reserve_token"),
      poolUpdatedAt: int("pool_updated_at"),
      poolUpdatedBlock: int("pool_updated_block"),
    },
    (t) => [index("projects_phase_idx").on(t.phase), index("projects_launcher_idx").on(t.launcher)],
  );

  const trades = table(
    "trades",
    {
      id: text("id").primaryKey(), // txHash:logIndex
      project: text("project").notNull(),
      trader: text("trader").notNull(),
      side: text("side").notNull(), // buy | sell
      count: int("count").notNull(),
      bnbWei: text("bnb_wei").notNull(), // buy: curve cost (excl fee); sell: gross (incl fee)
      feeWei: text("fee_wei").notNull(),
      priceWei: text("price_wei").notNull(), // spot price per NFT after the trade
      firstTokenId: int("first_token_id"),
      blockNumber: int("block_number").notNull(),
      logIndex: int("log_index").notNull(),
      txHash: text("tx_hash").notNull(),
      ts: int("ts").notNull(),
    },
    (t) => [index("trades_project_ts_idx").on(t.project, t.ts), index("trades_trader_idx").on(t.trader), index("trades_ts_idx").on(t.ts)],
  );

  const nftTokens = table(
    "nft_tokens",
    {
      project: text("project").notNull(),
      tokenId: int("token_id").notNull(),
      owner: text("owner").notNull(),
      // traits: seed = BondingNFT.traitSeed(tokenId) (0/null while VRF is pending); rarity/image derived from it
      seed: text("seed"),
      traits: text("traits"), // JSON [{trait_type,value}]
      rarity: text("rarity"), // common | rare | epic | legendary
      image: text("image"),
    },
    (t) => [primaryKey({ columns: [t.project, t.tokenId] }), index("nft_owner_idx").on(t.project, t.owner), index("nft_seed_idx").on(t.project, t.seed)],
  );

  /** PancakeSwap V2 swaps of graduated projects' pairs (ticker / candles / 24h volume after graduation). */
  const poolSwaps = table(
    "pool_swaps",
    {
      id: text("id").primaryKey(), // txHash:logIndex
      project: text("project").notNull(),
      pair: text("pair").notNull(),
      trader: text("trader").notNull(), // Swap.to (router swaps: the recipient)
      side: text("side").notNull(), // buy (BNB -> token) | sell (token -> BNB)
      bnbWei: text("bnb_wei").notNull(),
      tokenWei: text("token_wei").notNull(),
      priceWei: text("price_wei").notNull(), // pool price per NFT (80k tokens) after the swap (from the Sync before it)
      blockNumber: int("block_number").notNull(),
      logIndex: int("log_index").notNull(),
      txHash: text("tx_hash").notNull(),
      ts: int("ts").notNull(),
    },
    (t) => [index("pool_swaps_project_ts_idx").on(t.project, t.ts), index("pool_swaps_ts_idx").on(t.ts)],
  );

  const chainEvents = table(
    "chain_events",
    {
      id: text("id").primaryKey(), // txHash:logIndex
      address: text("address").notNull(),
      name: text("name").notNull(),
      args: text("args").notNull(), // JSON (bigints as strings)
      blockNumber: int("block_number").notNull(),
      txHash: text("tx_hash").notNull(),
      ts: int("ts").notNull(),
    },
    (t) => [index("events_addr_idx").on(t.address, t.blockNumber)],
  );

  const xPosts = table(
    "x_posts",
    {
      tweetId: text("tweet_id").primaryKey(),
      project: text("project").notNull(),
      wallet: text("wallet").notNull(),
      authorId: text("author_id").notNull(),
      text: text("text").notNull(),
      createdAt: int("created_at").notNull(),
      hasCode: bool("has_code").notNull().default(false),
      // promotion-gate verdict: accepted | duplicate_text | agent_already_counted | not_holder | no_code | too_early | excluded
      gateStatus: text("gate_status"),
      similarTo: text("similar_to"),
      likes: int("likes").notNull().default(0),
      reposts: int("reposts").notNull().default(0),
      replies: int("replies").notNull().default(0),
      quotes: int("quotes").notNull().default(0),
      metricsAt: int("metrics_at"),
    },
    (t) => [index("xposts_project_idx").on(t.project), index("xposts_wallet_idx").on(t.wallet, t.createdAt)],
  );

  const attestations = table("attestations", {
    id: text("id").primaryKey(), // project:nonce
    project: text("project").notNull(),
    nonce: int("nonce").notNull(),
    shareBps: int("share_bps").notNull(),
    root: text("root").notNull(),
    promoters: text("promoters").notNull(), // JSON address[]
    tree: text("tree").notNull(), // StandardMerkleTree dump JSON
    signature: text("signature").notNull(),
    deadline: int("deadline").notNull(),
    txHash: text("tx_hash"),
    status: text("status").notNull(), // signed | submitted | failed
    error: text("error"),
    createdAt: int("created_at").notNull(),
  });

  const referralBindings = table(
    "referral_bindings",
    {
      project: text("project").notNull(),
      buyer: text("buyer").notNull(),
      referrer: text("referrer").notNull(),
      code: text("code").notNull(),
      boundAt: int("bound_at").notNull(), // chain time
    },
    (t) => [primaryKey({ columns: [t.project, t.buyer] })],
  );

  const rewardEpochs = table("reward_epochs", {
    epoch: int("epoch").primaryKey(),
    windowFrom: int("window_from").notNull(),
    windowTo: int("window_to").notNull(),
    poolWei: text("pool_wei").notNull(),
    totalWei: text("total_wei").notNull(),
    engagementWei: text("engagement_wei").notNull(),
    referralWei: text("referral_wei").notNull(),
    root: text("root"),
    tree: text("tree"),
    txHash: text("tx_hash"),
    status: text("status").notNull(), // computed | posted | empty | failed
    error: text("error"),
    createdAt: int("created_at").notNull(),
  });

  const rewardAllocations = table(
    "reward_allocations",
    {
      epoch: int("epoch").notNull(),
      wallet: text("wallet").notNull(),
      amountWei: text("amount_wei").notNull(),
      engagementScore: int("engagement_score").notNull().default(0),
      referralWei: text("referral_wei").notNull().default("0"),
      proof: text("proof").notNull(), // JSON bytes32[]
      claimed: bool("claimed").notNull().default(false),
    },
    (t) => [primaryKey({ columns: [t.epoch, t.wallet] }), index("alloc_wallet_idx").on(t.wallet)],
  );

  const adminTxs = table("admin_txs", {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // revokeLaunch | removeAgent | postRoot | submitPromotion | graduate | register
    target: text("target").notNull(),
    to: text("to_address").notNull(),
    data: text("data").notNull(),
    value: text("value").notNull().default("0"),
    reason: text("reason"),
    status: text("status").notNull(), // prepared | sent | confirmed | failed
    txHash: text("tx_hash"),
    error: text("error"),
    createdAt: int("created_at").notNull(),
    updatedAt: int("updated_at").notNull(),
  });

  // 发射台推特空投 (X airdrop campaign): one claim per X handle AND one per wallet; verified later by an operator.
  const airdropClaims = table(
    "airdrop_claims",
    {
      id: text("id").primaryKey(),
      xHandle: text("x_handle").notNull(), // lowercased, without @
      wallet: text("wallet").notNull(), // lowercase 0x address
      amount: int("amount").notNull(), // NFT 凭证额度 (credits), not a token
      status: text("status").notNull(), // pending_verification | approved | rejected
      ipHash: text("ip_hash"), // HMAC of client IP (rate-limit audit; raw IP never stored)
      repostUrl: text("repost_url"), // URL of the user's repost / quote of the pinned post (v2 claims)
      agentId: text("agent_id"), // Binance Agent ID, e.g. "alice.ai" (lowercased; resolved on-chain to `wallet`)
      reviewReason: text("review_reason"), // why the claim is pending / how it was approved (auto-verify result code)
      verifyAttempts: int("verify_attempts").notNull().default(0), // FxTwitter auto-verify attempts (sweep retries)
      createdAt: int("created_at").notNull(),
      updatedAt: int("updated_at").notNull(),
    },
    (t) => [
      uniqueIndex("airdrop_handle_uq").on(t.xHandle),
      uniqueIndex("airdrop_wallet_uq").on(t.wallet),
      uniqueIndex("airdrop_agent_uq").on(t.agentId),
      index("airdrop_created_idx").on(t.createdAt),
    ],
  );

  // 挖矿积分 (off-chain mining points; convertible to the platform token later under rules announced separately).
  // Points are stored in units of 1e-8 points (integer). Accrual is settled lazily: points += rate * elapsed since lastAccrualAt.
  const miningAccounts = table(
    "mining_accounts",
    {
      wallet: text("wallet").primaryKey(), // lowercase 0x address
      pointsE8: int("points_e8").notNull().default(0), // settled points (accrual + check-ins), x1e8
      checkinE8: int("checkin_e8").notNull().default(0), // part of pointsMilli from check-ins
      rateE8PerDay: int("rate_e8_per_day").notNull().default(0), // rate in force since lastAccrualAt, x1e8
      credit: int("credit").notNull().default(0), // ChyAICredential.creditOf at last settle
      lastAccrualAt: int("last_accrual_at").notNull(),
      createdAt: int("created_at").notNull(),
      updatedAt: int("updated_at").notNull(),
    },
    (t) => [index("mining_points_idx").on(t.pointsE8)],
  );
  const miningCheckins = table(
    "mining_checkins",
    {
      id: text("id").primaryKey(),
      wallet: text("wallet").notNull(),
      day: text("day").notNull(), // UTC YYYY-MM-DD
      pointsE8: int("points_e8").notNull(),
      createdAt: int("created_at").notNull(),
    },
    (t) => [uniqueIndex("mining_checkin_uq").on(t.wallet, t.day), index("mining_checkin_day_idx").on(t.day)],
  );

  return {
    airdropClaims,
    miningAccounts,
    miningCheckins,
    kv,
    agents,
    challenges,
    projects,
    trades,
    poolSwaps,
    nftTokens,
    chainEvents,
    xPosts,
    attestations,
    referralBindings,
    rewardEpochs,
    rewardAllocations,
    adminTxs,
  };
}

export type Schema = ReturnType<typeof defineSchema>;
