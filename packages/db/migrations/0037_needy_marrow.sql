ALTER TABLE "outbox_events" ADD COLUMN "dispatch_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "dispatch_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "dispatch_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "dispatch_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "dispatch_last_error" text;--> statement-breakpoint
CREATE INDEX "outbox_dispatch_idx" ON "outbox_events" USING btree ("published_at","dispatch_next_attempt_at","created_at");--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_dispatch_state" CHECK ("outbox_events"."dispatch_attempts" >= 0 and (("outbox_events"."dispatch_claim_id" is null and "outbox_events"."dispatch_claimed_at" is null) or ("outbox_events"."dispatch_claim_id" is not null and "outbox_events"."dispatch_claimed_at" is not null)) and ("outbox_events"."dispatch_last_error" is null or length("outbox_events"."dispatch_last_error") <= 500));