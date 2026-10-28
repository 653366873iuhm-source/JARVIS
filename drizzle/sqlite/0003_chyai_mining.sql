CREATE TABLE `mining_accounts` (
	`wallet` text PRIMARY KEY NOT NULL,
	`points_milli` integer DEFAULT 0 NOT NULL,
	`checkin_milli` integer DEFAULT 0 NOT NULL,
	`rate_milli_per_day` integer DEFAULT 0 NOT NULL,
	`credit` integer DEFAULT 0 NOT NULL,
	`last_accrual_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mining_points_idx` ON `mining_accounts` (`points_milli`);--> statement-breakpoint
CREATE TABLE `mining_checkins` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet` text NOT NULL,
	`day` text NOT NULL,
	`points_milli` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mining_checkin_uq` ON `mining_checkins` (`wallet`,`day`);--> statement-breakpoint
CREATE INDEX `mining_checkin_day_idx` ON `mining_checkins` (`day`);--> statement-breakpoint
ALTER TABLE `airdrop_claims` ADD `repost_url` text;--> statement-breakpoint
ALTER TABLE `airdrop_claims` ADD `agent_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `airdrop_agent_uq` ON `airdrop_claims` (`agent_id`);