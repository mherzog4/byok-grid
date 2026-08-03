CREATE TYPE "public"."writeback_delivery_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."writeback_destination_status" AS ENUM('active', 'paused');--> statement-breakpoint
CREATE TABLE "writeback_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"destination_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"row_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "writeback_delivery_status" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"response_status" integer,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "writeback_deliveries_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "writeback_deliveries_valid_attempt" CHECK ("writeback_deliveries"."attempt" >= 0),
	CONSTRAINT "writeback_deliveries_valid_row_version" CHECK ("writeback_deliveries"."row_version" > 0),
	CONSTRAINT "writeback_deliveries_valid_response_status" CHECK ("writeback_deliveries"."response_status" is null or "writeback_deliveries"."response_status" between 100 and 599)
);
--> statement-breakpoint
CREATE TABLE "writeback_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"name" text NOT NULL,
	"adapter_id" text DEFAULT 'hubspot_contact' NOT NULL,
	"credential_id" uuid NOT NULL,
	"record_id_column_id" uuid NOT NULL,
	"field_mappings" jsonb NOT NULL,
	"status" "writeback_destination_status" DEFAULT 'active' NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "writeback_destinations_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "writeback_destinations_scope_unique" UNIQUE("id","table_id","workspace_id"),
	CONSTRAINT "writeback_destinations_supported_adapter" CHECK ("writeback_destinations"."adapter_id" = 'hubspot_contact')
);
--> statement-breakpoint
ALTER TABLE "writeback_deliveries" ADD CONSTRAINT "writeback_deliveries_destination_scope_fk" FOREIGN KEY ("destination_id","table_id","workspace_id") REFERENCES "public"."writeback_destinations"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writeback_deliveries" ADD CONSTRAINT "writeback_deliveries_row_scope_fk" FOREIGN KEY ("row_id","table_id","workspace_id") REFERENCES "public"."rows"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writeback_destinations" ADD CONSTRAINT "writeback_destinations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writeback_destinations" ADD CONSTRAINT "writeback_destinations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writeback_destinations" ADD CONSTRAINT "writeback_destinations_table_workspace_fk" FOREIGN KEY ("table_id","workspace_id") REFERENCES "public"."data_tables"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writeback_destinations" ADD CONSTRAINT "writeback_destinations_credential_workspace_fk" FOREIGN KEY ("credential_id","workspace_id") REFERENCES "public"."credentials"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writeback_destinations" ADD CONSTRAINT "writeback_destinations_record_id_column_scope_fk" FOREIGN KEY ("record_id_column_id","table_id","workspace_id") REFERENCES "public"."columns"("id","table_id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "writeback_deliveries_workspace_created_idx" ON "writeback_deliveries" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "writeback_deliveries_destination_created_idx" ON "writeback_deliveries" USING btree ("destination_id","created_at");--> statement-breakpoint
CREATE INDEX "writeback_destinations_workspace_table_idx" ON "writeback_destinations" USING btree ("workspace_id","table_id","created_at");