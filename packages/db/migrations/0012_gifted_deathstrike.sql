CREATE TYPE "public"."row_settlement_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."webhook_trigger_mode" AS ENUM('manual', 'row_settled');--> statement-breakpoint
CREATE TABLE "row_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"row_version" integer NOT NULL,
	"status" "row_settlement_status" DEFAULT 'queued' NOT NULL,
	"queued_delivery_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "row_settlements_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "row_settlements_valid_version" CHECK ("row_settlements"."row_version" > 0),
	CONSTRAINT "row_settlements_valid_delivery_count" CHECK ("row_settlements"."queued_delivery_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "row_version" integer;--> statement-breakpoint
UPDATE "webhook_deliveries"
SET "row_version" = COALESCE(
  NULLIF("payload"->'data'->'row'->>'version', '')::integer,
  1
);--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "row_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "trigger_mode" "webhook_trigger_mode" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_destinations" ADD COLUMN "trigger_mode" "webhook_trigger_mode" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "row_settlements" ADD CONSTRAINT "row_settlements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_settlements" ADD CONSTRAINT "row_settlements_row_scope_fk" FOREIGN KEY ("row_id","table_id","workspace_id") REFERENCES "public"."rows"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "row_settlements_row_version_unique" ON "row_settlements" USING btree ("row_id","row_version");--> statement-breakpoint
CREATE INDEX "row_settlements_workspace_created_idx" ON "row_settlements" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "row_settlements_status_created_idx" ON "row_settlements" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_settlement_unique" ON "webhook_deliveries" USING btree ("destination_id","row_id","row_version") WHERE "webhook_deliveries"."trigger_mode" = 'row_settled';--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_valid_row_version" CHECK ("webhook_deliveries"."row_version" > 0);
