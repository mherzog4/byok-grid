ALTER TABLE "outbox_events" ADD COLUMN "analytics_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "analytics_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "analytics_projected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "analytics_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "analytics_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "analytics_last_error" text;--> statement-breakpoint
CREATE INDEX "outbox_analytics_projection_idx" ON "outbox_events" USING btree ("analytics_projected_at","analytics_next_attempt_at","created_at");--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_analytics_projection_state" CHECK ("outbox_events"."analytics_attempts" >= 0 and (("outbox_events"."analytics_claim_id" is null and "outbox_events"."analytics_claimed_at" is null) or ("outbox_events"."analytics_claim_id" is not null and "outbox_events"."analytics_claimed_at" is not null)) and ("outbox_events"."analytics_last_error" is null or length("outbox_events"."analytics_last_error") <= 500));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_web') THEN
    REVOKE UPDATE, DELETE ON TABLE "outbox_events" FROM byok_grid_web;
  END IF;
END
$$;
