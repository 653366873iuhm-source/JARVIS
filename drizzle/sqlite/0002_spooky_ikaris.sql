CREATE TABLE `airdrop_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`x_handle` text NOT NULL,
	`wallet` text NOT NULL,
	`amount` integer NOT NULL,
	`status` text NOT NULL,
	`ip_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `airdrop_handle_uq` ON `airdrop_claims` (`x_handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `airdrop_wallet_uq` ON `airdrop_claims` (`wallet`);--> statement-breakpoint
CREATE INDEX `airdrop_created_idx` ON `airdrop_claims` (`created_at`);