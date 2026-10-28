ALTER TABLE "mining_accounts" RENAME COLUMN "points_milli" TO "points_e8";--> statement-breakpoint
ALTER TABLE "mining_accounts" RENAME COLUMN "checkin_milli" TO "checkin_e8";--> statement-breakpoint
ALTER TABLE "mining_accounts" RENAME COLUMN "rate_milli_per_day" TO "rate_e8_per_day";--> statement-breakpoint
ALTER TABLE "mining_checkins" RENAME COLUMN "points_milli" TO "points_e8";--> statement-breakpoint
UPDATE "mining_accounts" SET "points_e8" = "points_e8" * 100000, "checkin_e8" = "checkin_e8" * 100000, "rate_e8_per_day" = "rate_e8_per_day" * 100000;--> statement-breakpoint
UPDATE "mining_checkins" SET "points_e8" = "points_e8" * 100000;