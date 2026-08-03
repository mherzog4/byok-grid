CREATE TABLE "schema_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"column_id" uuid,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schema_lifecycle_events_valid_action" CHECK ("schema_lifecycle_events"."action" in ('column_archived', 'column_restored', 'table_archived', 'table_restored')),
	CONSTRAINT "schema_lifecycle_events_column_scope" CHECK (("schema_lifecycle_events"."action" like 'column_%' and "schema_lifecycle_events"."column_id" is not null) or ("schema_lifecycle_events"."action" like 'table_%' and "schema_lifecycle_events"."column_id" is null))
);
--> statement-breakpoint
ALTER TABLE "columns" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "columns" ADD COLUMN "archived_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "data_tables" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_tables" ADD COLUMN "archived_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "schema_lifecycle_events" ADD CONSTRAINT "schema_lifecycle_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_lifecycle_events" ADD CONSTRAINT "schema_lifecycle_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schema_lifecycle_events_workspace_created_idx" ON "schema_lifecycle_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "schema_lifecycle_events_resource_created_idx" ON "schema_lifecycle_events" USING btree ("table_id","column_id","created_at");--> statement-breakpoint
ALTER TABLE "columns" ADD CONSTRAINT "columns_archived_by_user_id_users_id_fk" FOREIGN KEY ("archived_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_tables" ADD CONSTRAINT "data_tables_archived_by_user_id_users_id_fk" FOREIGN KEY ("archived_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "columns_table_archived_position_idx" ON "columns" USING btree ("table_id","archived_at","position");--> statement-breakpoint
CREATE INDEX "data_tables_workspace_archived_idx" ON "data_tables" USING btree ("workspace_id","archived_at","created_at");
--> statement-breakpoint
ALTER TABLE "schema_lifecycle_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "schema_lifecycle_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "schema_manager_select" ON "schema_lifecycle_events"
  FOR SELECT
  USING (
    byok_grid_private.workspace_role(workspace_id) IN ('owner', 'admin')
  );
CREATE POLICY "schema_manager_insert" ON "schema_lifecycle_events"
  FOR INSERT
  WITH CHECK (
    byok_grid_private.workspace_role(workspace_id) IN ('owner', 'admin')
    AND actor_user_id = byok_grid_private.current_user_id()
  );
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_web') THEN
    GRANT SELECT, INSERT ON TABLE "schema_lifecycle_events" TO byok_grid_web;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_worker') THEN
    GRANT SELECT ON TABLE "schema_lifecycle_events" TO byok_grid_worker;
  END IF;
END
$$;
