import { defineSchema, sqliteBuilders } from "./schema.js";
export const schema = defineSchema(sqliteBuilders);
export const { kv, agents, challenges, projects, trades, poolSwaps, nftTokens, chainEvents, xPosts, attestations, referralBindings, rewardEpochs, rewardAllocations, adminTxs, airdropClaims, miningAccounts, miningCheckins } = schema;
