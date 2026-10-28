ALTER TABLE "airdrop_claims" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "airdrop_claims" ADD COLUMN "verify_attempts" bigint DEFAULT 0 NOT NULL;