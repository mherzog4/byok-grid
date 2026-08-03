CREATE TYPE "public"."cell_status" AS ENUM('idle', 'queued', 'running', 'succeeded', 'failed', 'stale', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."cell_value_type" AS ENUM('empty', 'text', 'number', 'boolean', 'timestamp', 'json');--> statement-breakpoint
CREATE TYPE "public"."column_kind" AS ENUM('input', 'formula', 'connector', 'function');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TABLE "cell_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"cell_id" uuid NOT NULL,
	"credential_id" uuid,
	"connector_id" text NOT NULL,
	"action_id" text NOT NULL,
	"input" jsonb NOT NULL,
	"input_fingerprint" text NOT NULL,
	"allowed_hosts" text[] NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"output" jsonb,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cell_runs_id_workspace_unique" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "cells" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"value_type" "cell_value_type" DEFAULT 'empty' NOT NULL,
	"value_text" text,
	"value_number" numeric,
	"value_boolean" boolean,
	"value_timestamp" timestamp with time zone,
	"value_json" jsonb,
	"status" "cell_status" DEFAULT 'idle' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cells_id_workspace_unique" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "column_dependencies" (
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"depends_on_column_id" uuid NOT NULL,
	CONSTRAINT "column_dependencies_column_id_depends_on_column_id_pk" PRIMARY KEY("column_id","depends_on_column_id"),
	CONSTRAINT "column_dependencies_not_self" CHECK ("column_dependencies"."column_id" <> "column_dependencies"."depends_on_column_id")
);
--> statement-breakpoint
CREATE TABLE "columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "column_kind" NOT NULL,
	"value_type" "cell_value_type" NOT NULL,
	"position" text NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "columns_id_table_workspace_unique" UNIQUE("id","table_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"connector_id" text NOT NULL,
	"encrypted_value" jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credentials_id_workspace_unique" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "data_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_tables_id_workspace_unique" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"position" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rows_id_table_workspace_unique" UNIQUE("id","table_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"connector_id" text NOT NULL,
	"provider_units" text,
	"estimated_cost_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_keys" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"wrapped_key" jsonb NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "workspace_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cell_runs" ADD CONSTRAINT "cell_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cell_runs" ADD CONSTRAINT "cell_runs_cell_workspace_fk" FOREIGN KEY ("cell_id","workspace_id") REFERENCES "public"."cells"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cell_runs" ADD CONSTRAINT "cell_runs_credential_workspace_fk" FOREIGN KEY ("credential_id","workspace_id") REFERENCES "public"."credentials"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cells" ADD CONSTRAINT "cells_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cells" ADD CONSTRAINT "cells_table_workspace_fk" FOREIGN KEY ("table_id","workspace_id") REFERENCES "public"."data_tables"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cells" ADD CONSTRAINT "cells_row_scope_fk" FOREIGN KEY ("row_id","table_id","workspace_id") REFERENCES "public"."rows"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cells" ADD CONSTRAINT "cells_column_scope_fk" FOREIGN KEY ("column_id","table_id","workspace_id") REFERENCES "public"."columns"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_dependencies" ADD CONSTRAINT "column_dependencies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_dependencies" ADD CONSTRAINT "column_dependencies_column_scope_fk" FOREIGN KEY ("column_id","table_id","workspace_id") REFERENCES "public"."columns"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_dependencies" ADD CONSTRAINT "column_dependencies_parent_scope_fk" FOREIGN KEY ("depends_on_column_id","table_id","workspace_id") REFERENCES "public"."columns"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "columns" ADD CONSTRAINT "columns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "columns" ADD CONSTRAINT "columns_table_workspace_fk" FOREIGN KEY ("table_id","workspace_id") REFERENCES "public"."data_tables"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_tables" ADD CONSTRAINT "data_tables_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rows" ADD CONSTRAINT "rows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rows" ADD CONSTRAINT "rows_table_workspace_fk" FOREIGN KEY ("table_id","workspace_id") REFERENCES "public"."data_tables"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."cell_runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_keys" ADD CONSTRAINT "workspace_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cell_runs_cell_created_idx" ON "cell_runs" USING btree ("cell_id","created_at");--> statement-breakpoint
CREATE INDEX "cell_runs_workspace_status_idx" ON "cell_runs" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "cells_row_column_unique" ON "cells" USING btree ("row_id","column_id");--> statement-breakpoint
CREATE INDEX "cells_text_sort_idx" ON "cells" USING btree ("column_id","value_text","row_id");--> statement-breakpoint
CREATE INDEX "cells_number_sort_idx" ON "cells" USING btree ("column_id","value_number","row_id");--> statement-breakpoint
CREATE INDEX "cells_timestamp_sort_idx" ON "cells" USING btree ("column_id","value_timestamp","row_id");--> statement-breakpoint
CREATE INDEX "columns_table_position_idx" ON "columns" USING btree ("table_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "columns_table_name_unique" ON "columns" USING btree ("table_id","name");--> statement-breakpoint
CREATE INDEX "credentials_workspace_connector_idx" ON "credentials" USING btree ("workspace_id","connector_id");--> statement-breakpoint
CREATE INDEX "data_tables_workspace_idx" ON "data_tables" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox_events" USING btree ("published_at","created_at");--> statement-breakpoint
CREATE INDEX "outbox_workspace_created_idx" ON "outbox_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "rows_table_position_idx" ON "rows" USING btree ("table_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledger_run_unique" ON "usage_ledger" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "usage_ledger_workspace_created_idx" ON "usage_ledger" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_unique" ON "workspaces" USING btree ("slug");