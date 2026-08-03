ALTER TABLE "bulk_run_batches" ADD COLUMN "cancelled_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "bulk_run_batches" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
UPDATE "bulk_run_batches"
SET "cancelled_at" = coalesce("finished_at", "updated_at", "created_at")
WHERE "status" = 'cancelled' AND "cancelled_at" IS NULL;--> statement-breakpoint
ALTER TABLE "bulk_run_batches" ADD CONSTRAINT "bulk_run_batches_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_run_batches" ADD CONSTRAINT "bulk_run_batches_cancellation_state" CHECK (("bulk_run_batches"."status" = 'cancelled' and "bulk_run_batches"."cancelled_at" is not null) or ("bulk_run_batches"."status" <> 'cancelled' and "bulk_run_batches"."cancelled_at" is null and "bulk_run_batches"."cancelled_by_user_id" is null));
