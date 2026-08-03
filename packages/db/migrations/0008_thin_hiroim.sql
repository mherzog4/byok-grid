CREATE TYPE "public"."source_definition_status" AS ENUM('active', 'paused');--> statement-breakpoint
CREATE TYPE "public"."source_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."source_run_trigger" AS ENUM('manual', 'schedule');--> statement-breakpoint
CREATE TABLE "source_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"name" text NOT NULL,
	"adapter_id" text DEFAULT 'http_json' NOT NULL,
	"endpoint_url" text NOT NULL,
	"credential_id" uuid,
	"record_path" text DEFAULT '' NOT NULL,
	"record_key_field" text NOT NULL,
	"max_records" integer DEFAULT 1000 NOT NULL,
	"field_mapping" jsonb,
	"status" "source_definition_status" DEFAULT 'active' NOT NULL,
	"schedule_interval_minutes" integer,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_definitions_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "source_definitions_scope_unique" UNIQUE("id","table_id","workspace_id"),
	CONSTRAINT "source_definitions_record_limits" CHECK ("source_definitions"."max_records" between 1 and 5000),
	CONSTRAINT "source_definitions_schedule_interval" CHECK ("source_definitions"."schedule_interval_minutes" is null or "source_definitions"."schedule_interval_minutes" >= 5),
	CONSTRAINT "source_definitions_manual_has_no_next_run" CHECK ("source_definitions"."schedule_interval_minutes" is not null or "source_definitions"."next_run_at" is null)
);
--> statement-breakpoint
CREATE TABLE "source_records" (
	"source_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"record_key" text NOT NULL,
	"row_id" uuid NOT NULL,
	"last_seen_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_records_source_id_record_key_pk" PRIMARY KEY("source_id","record_key"),
	CONSTRAINT "source_records_key_length" CHECK (length("source_records"."record_key") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "source_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"trigger" "source_run_trigger" NOT NULL,
	"status" "source_run_status" DEFAULT 'queued' NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"received_record_count" integer DEFAULT 0 NOT NULL,
	"created_row_count" integer DEFAULT 0 NOT NULL,
	"updated_row_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_runs_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "source_runs_nonnegative_counts" CHECK ("source_runs"."attempt" >= 0 and "source_runs"."received_record_count" >= 0 and "source_runs"."created_row_count" >= 0 and "source_runs"."updated_row_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "source_definitions" ADD CONSTRAINT "source_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_definitions" ADD CONSTRAINT "source_definitions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_definitions" ADD CONSTRAINT "source_definitions_table_workspace_fk" FOREIGN KEY ("table_id","workspace_id") REFERENCES "public"."data_tables"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_definitions" ADD CONSTRAINT "source_definitions_credential_workspace_fk" FOREIGN KEY ("credential_id","workspace_id") REFERENCES "public"."credentials"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_last_seen_run_id_source_runs_id_fk" FOREIGN KEY ("last_seen_run_id") REFERENCES "public"."source_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_definition_scope_fk" FOREIGN KEY ("source_id","table_id","workspace_id") REFERENCES "public"."source_definitions"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_row_scope_fk" FOREIGN KEY ("row_id","table_id","workspace_id") REFERENCES "public"."rows"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_runs" ADD CONSTRAINT "source_runs_definition_scope_fk" FOREIGN KEY ("source_id","table_id","workspace_id") REFERENCES "public"."source_definitions"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_definitions_workspace_table_idx" ON "source_definitions" USING btree ("workspace_id","table_id","created_at");--> statement-breakpoint
CREATE INDEX "source_definitions_due_idx" ON "source_definitions" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_source_row_unique" ON "source_records" USING btree ("source_id","row_id");--> statement-breakpoint
CREATE INDEX "source_records_workspace_table_idx" ON "source_records" USING btree ("workspace_id","table_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_runs_source_scheduled_unique" ON "source_runs" USING btree ("source_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "source_runs_workspace_created_idx" ON "source_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "source_runs_source_created_idx" ON "source_runs" USING btree ("source_id","created_at");