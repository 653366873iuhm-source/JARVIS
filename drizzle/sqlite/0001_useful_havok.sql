CREATE TABLE `pool_swaps` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`pair` text NOT NULL,
	`trader` text NOT NULL,
	`side` text NOT NULL,
	`bnb_wei` text NOT NULL,
	`token_wei` text NOT NULL,
	`price_wei` text NOT NULL,
	`block_number` integer NOT NULL,
	`log_index` integer NOT NULL,
	`tx_hash` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pool_swaps_project_ts_idx` ON `pool_swaps` (`project`,`ts`);--> statement-breakpoint
CREATE INDEX `pool_swaps_ts_idx` ON `pool_swaps` (`ts`);--> statement-breakpoint
ALTER TABLE `nft_tokens` ADD `seed` text;--> statement-breakpoint
ALTER TABLE `nft_tokens` ADD `traits` text;--> statement-breakpoint
ALTER TABLE `nft_tokens` ADD `rarity` text;--> statement-breakpoint
ALTER TABLE `nft_tokens` ADD `image` text;--> statement-breakpoint
CREATE INDEX `nft_seed_idx` ON `nft_tokens` (`project`,`seed`);--> statement-breakpoint
ALTER TABLE `projects` ADD `story` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `image` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `traits` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `meta_status` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `meta_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `meta_checked_at` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `pool_token_is0` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `pool_reserve_bnb` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `pool_reserve_token` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `pool_updated_at` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `pool_updated_block` integer;