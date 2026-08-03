CREATE TYPE "public"."bulk_run_item_status" AS ENUM('pending', 'queued', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."bulk_run_mode" AS ENUM('pending', 'all');--> statement-breakpoint
CREATE TYPE "public"."bulk_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "bulk_run_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"mode" "bulk_run_mode" NOT NULL,
	"status" "bulk_run_status" DEFAULT 'queued' NOT NULL,
	"selected_row_count" integer NOT NULL,
	"queued_row_count" integer DEFAULT 0 NOT NULL,
	"skipped_row_count" integer DEFAULT 0 NOT NULL,
	"estimated_provider_requests" integer NOT NULL,
	"estimated_max_output_tokens" bigint,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bulk_run_batches_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "bulk_run_batches_nonnegative_counts" CHECK ("bulk_run_batches"."selected_row_count" >= 0 and "bulk_run_batches"."queued_row_count" >= 0 and "bulk_run_batches"."skipped_row_count" >= 0 and "bulk_run_batches"."estimated_provider_requests" >= 0 and ("bulk_run_batches"."estimated_max_output_tokens" is null or "bulk_run_batches"."estimated_max_output_tokens" >= 0)),
	CONSTRAINT "bulk_run_batches_processed_within_selected" CHECK ("bulk_run_batches"."queued_row_count" + "bulk_run_batches"."skipped_row_count" <= "bulk_run_batches"."selected_row_count")
);
--> statement-breakpoint
CREATE TABLE "bulk_run_items" (
	"batch_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"status" "bulk_run_item_status" DEFAULT 'pending' NOT NULL,
	"run_id" uuid,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bulk_run_items_batch_id_row_id_pk" PRIMARY KEY("batch_id","row_id"),
	CONSTRAINT "bulk_run_items_nonnegative_sequence" CHECK ("bulk_run_items"."sequence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "bulk_run_batches" ADD CONSTRAINT "bulk_run_batches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_run_batches" ADD CONSTRAINT "bulk_run_batches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_run_batches" ADD CONSTRAINT "bulk_run_batches_table_workspace_fk" FOREIGN KEY ("table_id","workspace_id") REFERENCES "public"."data_tables"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_run_batches" ADD CONSTRAINT "bulk_run_batches_column_scope_fk" FOREIGN KEY ("column_id","table_id","workspace_id") REFERENCES "public"."columns"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_run_items" ADD CONSTRAINT "bulk_run_items_batch_workspace_fk" FOREIGN KEY ("batch_id","workspace_id") REFERENCES "public"."bulk_run_batches"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_run_items" ADD CONSTRAINT "bulk_run_items_row_scope_fk" FOREIGN KEY ("row_id","table_id","workspace_id") REFERENCES "public"."rows"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_run_items" ADD CONSTRAINT "bulk_run_items_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."cell_runs"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bulk_run_batches_workspace_created_idx" ON "bulk_run_batches" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "bulk_run_batches_status_created_idx" ON "bulk_run_batches" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bulk_run_items_batch_sequence_unique" ON "bulk_run_items" USING btree ("batch_id","sequence");--> statement-breakpoint
CREATE INDEX "bulk_run_items_batch_status_sequence_idx" ON "bulk_run_items" USING btree ("batch_id","status","sequence");--> statement-breakpoint
ALTER TABLE "bulk_run_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bulk_run_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "bulk_run_batches"
  FOR ALL USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
ALTER TABLE "bulk_run_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bulk_run_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "bulk_run_items"
  FOR ALL USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
