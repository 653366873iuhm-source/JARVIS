import * as p from "drizzle-orm/pg-core";
import { defineSchema, type Builders } from "./schema.js";

const pgBuilders = {
  table: p.pgTable,
  text: (n: string) => p.text(n),
  int: (n: string) => p.bigint(n, { mode: "number" }),
  bool: (n: string) => p.boolean(n),
  index: p.index,
  uniqueIndex: p.uniqueIndex,
  primaryKey: p.primaryKey,
} as unknown as Builders; // runtime pg-core objects; TS types come from the sqlite instantiation

export const schema = defineSchema(pgBuilders);
export const { kv, agents, challenges, projects, trades, poolSwaps, nftTokens, chainEvents, xPosts, attestations, referralBindings, rewardEpochs, rewardAllocations, adminTxs } = schema;
