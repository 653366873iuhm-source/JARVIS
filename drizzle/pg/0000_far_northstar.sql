CREATE TABLE "admin_txs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"to_address" text NOT NULL,
	"data" text NOT NULL,
	"value" text DEFAULT '0' NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"tx_hash" text,
	"error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"wallet" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"agent_id_hash" text NOT NULL,
	"x_handle" text NOT NULL,
	"x_handle_hash" text NOT NULL,
	"x_user_id" text,
	"wallet_type" text DEFAULT 'eoa' NOT NULL,
	"ref_code" text,
	"intent" text NOT NULL,
	"can_launch" boolean DEFAULT false NOT NULL,
	"can_trade" boolean DEFAULT true NOT NULL,
	"eligibility" text,
	"expiry" bigint,
	"last_qualified_at" bigint,
	"last_checked_at" bigint,
	"onchain" boolean DEFAULT false NOT NULL,
	"onchain_can_launch" boolean DEFAULT false NOT NULL,
	"onchain_can_trade" boolean DEFAULT false NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	"funder" text,
	"funding_tx" text,
	"funding_checked_at" bigint,
	"sybil_flag" boolean DEFAULT false NOT NULL,
	"sybil_cluster" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attestations" (
	"id" text PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"nonce" bigint NOT NULL,
	"share_bps" bigint NOT NULL,
	"root" text NOT NULL,
	"promoters" text NOT NULL,
	"tree" text NOT NULL,
	"signature" text NOT NULL,
	"deadline" bigint NOT NULL,
	"tx_hash" text,
	"status" text NOT NULL,
	"error" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_events" (
	"id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"name" text NOT NULL,
	"args" text NOT NULL,
	"block_number" bigint NOT NULL,
	"tx_hash" text NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"wallet" text NOT NULL,
	"x_handle" text NOT NULL,
	"intent" text NOT NULL,
	"x_code" text NOT NULL,
	"message" text NOT NULL,
	"typed_data" text NOT NULL,
	"issued_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nft_tokens" (
	"project" text NOT NULL,
	"token_id" bigint NOT NULL,
	"owner" text NOT NULL,
	CONSTRAINT "nft_tokens_project_token_id_pk" PRIMARY KEY("project","token_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"address" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"launcher" text NOT NULL,
	"agent_id_hash" text NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"base_uri" text NOT NULL,
	"idx" bigint NOT NULL,
	"tag" text NOT NULL,
	"created_at" bigint NOT NULL,
	"created_block" bigint NOT NULL,
	"phase" bigint DEFAULT 0 NOT NULL,
	"virtual_bnb" text NOT NULL,
	"virtual_token" text NOT NULL,
	"reserve_bnb" text DEFAULT '0' NOT NULL,
	"sold" bigint DEFAULT 0 NOT NULL,
	"supply" bigint DEFAULT 0 NOT NULL,
	"price_wei" text NOT NULL,
	"volume_wei" text DEFAULT '0' NOT NULL,
	"trade_count" bigint DEFAULT 0 NOT NULL,
	"last_trade_at" bigint,
	"promotion_start" bigint,
	"graduated_at" bigint,
	"forced" boolean,
	"pair" text,
	"promoter_root" text,
	"attestation_nonce" bigint DEFAULT 0 NOT NULL,
	"last_share_bps" bigint
);
--> statement-breakpoint
CREATE TABLE "referral_bindings" (
	"project" text NOT NULL,
	"buyer" text NOT NULL,
	"referrer" text NOT NULL,
	"code" text NOT NULL,
	"bound_at" bigint NOT NULL,
	CONSTRAINT "referral_bindings_project_buyer_pk" PRIMARY KEY("project","buyer")
);
--> statement-breakpoint
CREATE TABLE "reward_allocations" (
	"epoch" bigint NOT NULL,
	"wallet" text NOT NULL,
	"amount_wei" text NOT NULL,
	"engagement_score" bigint DEFAULT 0 NOT NULL,
	"referral_wei" text DEFAULT '0' NOT NULL,
	"proof" text NOT NULL,
	"claimed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "reward_allocations_epoch_wallet_pk" PRIMARY KEY("epoch","wallet")
);
--> statement-breakpoint
CREATE TABLE "reward_epochs" (
	"epoch" bigint PRIMARY KEY NOT NULL,
	"window_from" bigint NOT NULL,
	"window_to" bigint NOT NULL,
	"pool_wei" text NOT NULL,
	"total_wei" text NOT NULL,
	"engagement_wei" text NOT NULL,
	"referral_wei" text NOT NULL,
	"root" text,
	"tree" text,
	"tx_hash" text,
	"status" text NOT NULL,
	"error" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" text PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"trader" text NOT NULL,
	"side" text NOT NULL,
	"count" bigint NOT NULL,
	"bnb_wei" text NOT NULL,
	"fee_wei" text NOT NULL,
	"price_wei" text NOT NULL,
	"first_token_id" bigint,
	"block_number" bigint NOT NULL,
	"log_index" bigint NOT NULL,
	"tx_hash" text NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_posts" (
	"tweet_id" text PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"wallet" text NOT NULL,
	"author_id" text NOT NULL,
	"text" text NOT NULL,
	"created_at" bigint NOT NULL,
	"has_code" boolean DEFAULT false NOT NULL,
	"gate_status" text,
	"similar_to" text,
	"likes" bigint DEFAULT 0 NOT NULL,
	"reposts" bigint DEFAULT 0 NOT NULL,
	"replies" bigint DEFAULT 0 NOT NULL,
	"quotes" bigint DEFAULT 0 NOT NULL,
	"metrics_at" bigint
);
--> statement-breakpoint
CREATE INDEX "agents_agent_id_idx" ON "agents" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agents_x_idx" ON "agents" USING btree ("x_handle");--> statement-breakpoint
CREATE INDEX "events_addr_idx" ON "chain_events" USING btree ("address","block_number");--> statement-breakpoint
CREATE INDEX "nft_owner_idx" ON "nft_tokens" USING btree ("project","owner");--> statement-breakpoint
CREATE INDEX "projects_phase_idx" ON "projects" USING btree ("phase");--> statement-breakpoint
CREATE INDEX "projects_launcher_idx" ON "projects" USING btree ("launcher");--> statement-breakpoint
CREATE INDEX "alloc_wallet_idx" ON "reward_allocations" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "trades_project_ts_idx" ON "trades" USING btree ("project","ts");--> statement-breakpoint
CREATE INDEX "trades_trader_idx" ON "trades" USING btree ("trader");--> statement-breakpoint
CREATE INDEX "trades_ts_idx" ON "trades" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "xposts_project_idx" ON "x_posts" USING btree ("project");--> statement-breakpoint
CREATE INDEX "xposts_wallet_idx" ON "x_posts" USING btree ("wallet","created_at");