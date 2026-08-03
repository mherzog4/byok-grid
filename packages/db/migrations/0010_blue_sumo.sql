CREATE TYPE "public"."webhook_delivery_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."webhook_destination_status" AS ENUM('active', 'paused');--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"destination_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"response_status" integer,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "webhook_deliveries_valid_attempt" CHECK ("webhook_deliveries"."attempt" >= 0),
	CONSTRAINT "webhook_deliveries_valid_response_status" CHECK ("webhook_deliveries"."response_status" is null or "webhook_deliveries"."response_status" between 100 and 599)
);
--> statement-breakpoint
CREATE TABLE "webhook_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"name" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"signing_credential_id" uuid NOT NULL,
	"status" "webhook_destination_status" DEFAULT 'active' NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_destinations_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "webhook_destinations_scope_unique" UNIQUE("id","table_id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_destination_scope_fk" FOREIGN KEY ("destination_id","table_id","workspace_id") REFERENCES "public"."webhook_destinations"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_row_scope_fk" FOREIGN KEY ("row_id","table_id","workspace_id") REFERENCES "public"."rows"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_destinations" ADD CONSTRAINT "webhook_destinations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_destinations" ADD CONSTRAINT "webhook_destinations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_destinations" ADD CONSTRAINT "webhook_destinations_table_workspace_fk" FOREIGN KEY ("table_id","workspace_id") REFERENCES "public"."data_tables"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_destinations" ADD CONSTRAINT "webhook_destinations_credential_workspace_fk" FOREIGN KEY ("signing_credential_id","workspace_id") REFERENCES "public"."credentials"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_workspace_created_idx" ON "webhook_deliveries" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_destination_created_idx" ON "webhook_deliveries" USING btree ("destination_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_destinations_workspace_table_idx" ON "webhook_destinations" USING btree ("workspace_id","table_id","created_at");