ALTER TABLE "row_settlements" ADD COLUMN "changed_column_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "row_settlements" ADD COLUMN "consumed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "row_settlements" ADD COLUMN "queued_run_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "row_settlements" ADD CONSTRAINT "row_settlements_valid_run_count" CHECK ("row_settlements"."queued_run_count" >= 0);