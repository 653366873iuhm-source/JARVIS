ALTER TABLE `airdrop_claims` ADD `review_reason` text;--> statement-breakpoint
ALTER TABLE `airdrop_claims` ADD `verify_attempts` integer DEFAULT 0 NOT NULL;