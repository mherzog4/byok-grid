ALTER TABLE "workspace_purge_receipts" ADD COLUMN "analytics_erase_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_purge_receipts" ADD COLUMN "analytics_erase_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_purge_receipts" ADD COLUMN "analytics_erase_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_purge_receipts" ADD COLUMN "analytics_erase_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_purge_receipts" ADD COLUMN "analytics_erase_last_error" text;--> statement-breakpoint
ALTER TABLE "workspace_purge_receipts" ADD COLUMN "analytics_erased_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workspace_purge_receipts_analytics_erase_idx" ON "workspace_purge_receipts" USING btree ("analytics_erased_at","analytics_erase_next_attempt_at","purged_at");--> statement-breakpoint
ALTER TABLE "workspace_purge_receipts" ADD CONSTRAINT "workspace_purge_receipts_analytics_state" CHECK ("workspace_purge_receipts"."analytics_erase_attempts" >= 0 and (("workspace_purge_receipts"."analytics_erase_claim_id" is null and "workspace_purge_receipts"."analytics_erase_claimed_at" is null) or ("workspace_purge_receipts"."analytics_erase_claim_id" is not null and "workspace_purge_receipts"."analytics_erase_claimed_at" is not null)) and ("workspace_purge_receipts"."analytics_erase_last_error" is null or length("workspace_purge_receipts"."analytics_erase_last_error") <= 500));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_worker') THEN
    GRANT SELECT, UPDATE ON TABLE workspace_purge_receipts TO byok_grid_worker;
  END IF;
END $$;
