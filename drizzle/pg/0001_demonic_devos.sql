CREATE TABLE "pool_swaps" (
	"id" text PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"pair" text NOT NULL,
	"trader" text NOT NULL,
	"side" text NOT NULL,
	"bnb_wei" text NOT NULL,
	"token_wei" text NOT NULL,
	"price_wei" text NOT NULL,
	"block_number" bigint NOT NULL,
	"log_index" bigint NOT NULL,
	"tx_hash" text NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nft_tokens" ADD COLUMN "seed" text;--> statement-breakpoint
ALTER TABLE "nft_tokens" ADD COLUMN "traits" text;--> statement-breakpoint
ALTER TABLE "nft_tokens" ADD COLUMN "rarity" text;--> statement-breakpoint
ALTER TABLE "nft_tokens" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "story" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "traits" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "meta_status" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "meta_attempts" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "meta_checked_at" bigint;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pool_token_is0" boolean;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pool_reserve_bnb" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pool_reserve_token" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pool_updated_at" bigint;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pool_updated_block" bigint;--> statement-breakpoint
CREATE INDEX "pool_swaps_project_ts_idx" ON "pool_swaps" USING btree ("project","ts");--> statement-breakpoint
CREATE INDEX "pool_swaps_ts_idx" ON "pool_swaps" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "nft_seed_idx" ON "nft_tokens" USING btree ("project","seed");