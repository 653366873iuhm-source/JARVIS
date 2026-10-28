CREATE TABLE "mining_accounts" (
	"wallet" text PRIMARY KEY NOT NULL,
	"points_milli" bigint DEFAULT 0 NOT NULL,
	"checkin_milli" bigint DEFAULT 0 NOT NULL,
	"rate_milli_per_day" bigint DEFAULT 0 NOT NULL,
	"credit" bigint DEFAULT 0 NOT NULL,
	"last_accrual_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mining_checkins" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"day" text NOT NULL,
	"points_milli" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "airdrop_claims" ADD COLUMN "repost_url" text;--> statement-breakpoint
ALTER TABLE "airdrop_claims" ADD COLUMN "agent_id" text;--> statement-breakpoint
CREATE INDEX "mining_points_idx" ON "mining_accounts" USING btree ("points_milli");--> statement-breakpoint
CREATE UNIQUE INDEX "mining_checkin_uq" ON "mining_checkins" USING btree ("wallet","day");--> statement-breakpoint
CREATE INDEX "mining_checkin_day_idx" ON "mining_checkins" USING btree ("day");--> statement-breakpoint
CREATE UNIQUE INDEX "airdrop_agent_uq" ON "airdrop_claims" USING btree ("agent_id");