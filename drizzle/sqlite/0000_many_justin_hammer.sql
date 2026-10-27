CREATE TABLE `admin_txs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`to_address` text NOT NULL,
	`data` text NOT NULL,
	`value` text DEFAULT '0' NOT NULL,
	`reason` text,
	`status` text NOT NULL,
	`tx_hash` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`wallet` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`agent_id_hash` text NOT NULL,
	`x_handle` text NOT NULL,
	`x_handle_hash` text NOT NULL,
	`x_user_id` text,
	`wallet_type` text DEFAULT 'eoa' NOT NULL,
	`ref_code` text,
	`intent` text NOT NULL,
	`can_launch` integer DEFAULT false NOT NULL,
	`can_trade` integer DEFAULT true NOT NULL,
	`eligibility` text,
	`expiry` integer,
	`last_qualified_at` integer,
	`last_checked_at` integer,
	`onchain` integer DEFAULT false NOT NULL,
	`onchain_can_launch` integer DEFAULT false NOT NULL,
	`onchain_can_trade` integer DEFAULT false NOT NULL,
	`removed` integer DEFAULT false NOT NULL,
	`funder` text,
	`funding_tx` text,
	`funding_checked_at` integer,
	`sybil_flag` integer DEFAULT false NOT NULL,
	`sybil_cluster` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agents_agent_id_idx` ON `agents` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agents_x_idx` ON `agents` (`x_handle`);--> statement-breakpoint
CREATE TABLE `attestations` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`nonce` integer NOT NULL,
	`share_bps` integer NOT NULL,
	`root` text NOT NULL,
	`promoters` text NOT NULL,
	`tree` text NOT NULL,
	`signature` text NOT NULL,
	`deadline` integer NOT NULL,
	`tx_hash` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chain_events` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`name` text NOT NULL,
	`args` text NOT NULL,
	`block_number` integer NOT NULL,
	`tx_hash` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_addr_idx` ON `chain_events` (`address`,`block_number`);--> statement-breakpoint
CREATE TABLE `challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`wallet` text NOT NULL,
	`x_handle` text NOT NULL,
	`intent` text NOT NULL,
	`x_code` text NOT NULL,
	`message` text NOT NULL,
	`typed_data` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `nft_tokens` (
	`project` text NOT NULL,
	`token_id` integer NOT NULL,
	`owner` text NOT NULL,
	PRIMARY KEY(`project`, `token_id`)
);
--> statement-breakpoint
CREATE INDEX `nft_owner_idx` ON `nft_tokens` (`project`,`owner`);--> statement-breakpoint
CREATE TABLE `projects` (
	`address` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`launcher` text NOT NULL,
	`agent_id_hash` text NOT NULL,
	`name` text NOT NULL,
	`symbol` text NOT NULL,
	`base_uri` text NOT NULL,
	`idx` integer NOT NULL,
	`tag` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_block` integer NOT NULL,
	`phase` integer DEFAULT 0 NOT NULL,
	`virtual_bnb` text NOT NULL,
	`virtual_token` text NOT NULL,
	`reserve_bnb` text DEFAULT '0' NOT NULL,
	`sold` integer DEFAULT 0 NOT NULL,
	`supply` integer DEFAULT 0 NOT NULL,
	`price_wei` text NOT NULL,
	`volume_wei` text DEFAULT '0' NOT NULL,
	`trade_count` integer DEFAULT 0 NOT NULL,
	`last_trade_at` integer,
	`promotion_start` integer,
	`graduated_at` integer,
	`forced` integer,
	`pair` text,
	`promoter_root` text,
	`attestation_nonce` integer DEFAULT 0 NOT NULL,
	`last_share_bps` integer
);
--> statement-breakpoint
CREATE INDEX `projects_phase_idx` ON `projects` (`phase`);--> statement-breakpoint
CREATE INDEX `projects_launcher_idx` ON `projects` (`launcher`);--> statement-breakpoint
CREATE TABLE `referral_bindings` (
	`project` text NOT NULL,
	`buyer` text NOT NULL,
	`referrer` text NOT NULL,
	`code` text NOT NULL,
	`bound_at` integer NOT NULL,
	PRIMARY KEY(`project`, `buyer`)
);
--> statement-breakpoint
CREATE TABLE `reward_allocations` (
	`epoch` integer NOT NULL,
	`wallet` text NOT NULL,
	`amount_wei` text NOT NULL,
	`engagement_score` integer DEFAULT 0 NOT NULL,
	`referral_wei` text DEFAULT '0' NOT NULL,
	`proof` text NOT NULL,
	`claimed` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`epoch`, `wallet`)
);
--> statement-breakpoint
CREATE INDEX `alloc_wallet_idx` ON `reward_allocations` (`wallet`);--> statement-breakpoint
CREATE TABLE `reward_epochs` (
	`epoch` integer PRIMARY KEY NOT NULL,
	`window_from` integer NOT NULL,
	`window_to` integer NOT NULL,
	`pool_wei` text NOT NULL,
	`total_wei` text NOT NULL,
	`engagement_wei` text NOT NULL,
	`referral_wei` text NOT NULL,
	`root` text,
	`tree` text,
	`tx_hash` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`trader` text NOT NULL,
	`side` text NOT NULL,
	`count` integer NOT NULL,
	`bnb_wei` text NOT NULL,
	`fee_wei` text NOT NULL,
	`price_wei` text NOT NULL,
	`first_token_id` integer,
	`block_number` integer NOT NULL,
	`log_index` integer NOT NULL,
	`tx_hash` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trades_project_ts_idx` ON `trades` (`project`,`ts`);--> statement-breakpoint
CREATE INDEX `trades_trader_idx` ON `trades` (`trader`);--> statement-breakpoint
CREATE INDEX `trades_ts_idx` ON `trades` (`ts`);--> statement-breakpoint
CREATE TABLE `x_posts` (
	`tweet_id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`wallet` text NOT NULL,
	`author_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	`has_code` integer DEFAULT false NOT NULL,
	`gate_status` text,
	`similar_to` text,
	`likes` integer DEFAULT 0 NOT NULL,
	`reposts` integer DEFAULT 0 NOT NULL,
	`replies` integer DEFAULT 0 NOT NULL,
	`quotes` integer DEFAULT 0 NOT NULL,
	`metrics_at` integer
);
--> statement-breakpoint
CREATE INDEX `xposts_project_idx` ON `x_posts` (`project`);--> statement-breakpoint
CREATE INDEX `xposts_wallet_idx` ON `x_posts` (`wallet`,`created_at`);