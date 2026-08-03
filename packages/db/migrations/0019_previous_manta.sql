CREATE TABLE "saved_grid_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort" jsonb,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_grid_views_id_table_workspace_unique" UNIQUE("id","table_id","workspace_id"),
	CONSTRAINT "saved_grid_views_filter_shape" CHECK (jsonb_typeof("saved_grid_views"."filters") = 'array' and jsonb_array_length("saved_grid_views"."filters") <= 5),
	CONSTRAINT "saved_grid_views_name_length" CHECK (length("saved_grid_views"."name") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "saved_grid_views" ADD CONSTRAINT "saved_grid_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_grid_views" ADD CONSTRAINT "saved_grid_views_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_grid_views" ADD CONSTRAINT "saved_grid_views_table_workspace_fk" FOREIGN KEY ("table_id","workspace_id") REFERENCES "public"."data_tables"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_grid_views_table_name_unique" ON "saved_grid_views" USING btree ("table_id","name");--> statement-breakpoint
CREATE INDEX "saved_grid_views_workspace_table_created_idx" ON "saved_grid_views" USING btree ("workspace_id","table_id","created_at");
--> statement-breakpoint
ALTER TABLE "saved_grid_views" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saved_grid_views" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_member_select" ON "saved_grid_views"
  FOR SELECT
  USING (byok_grid_private.workspace_role(workspace_id) IS NOT NULL);
CREATE POLICY "workspace_member_insert" ON "saved_grid_views"
  FOR INSERT
  WITH CHECK (
    byok_grid_private.workspace_role(workspace_id) IS NOT NULL
    AND created_by_user_id = byok_grid_private.current_user_id()
  );
CREATE POLICY "workspace_member_update" ON "saved_grid_views"
  FOR UPDATE
  USING (byok_grid_private.workspace_role(workspace_id) IS NOT NULL)
  WITH CHECK (byok_grid_private.workspace_role(workspace_id) IS NOT NULL);
CREATE POLICY "workspace_member_delete" ON "saved_grid_views"
  FOR DELETE
  USING (byok_grid_private.workspace_role(workspace_id) IS NOT NULL);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_web') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "saved_grid_views" TO byok_grid_web;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_worker') THEN
    GRANT SELECT ON TABLE "saved_grid_views" TO byok_grid_worker;
  END IF;
END
$$;
