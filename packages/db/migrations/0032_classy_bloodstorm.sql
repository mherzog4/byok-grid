CREATE TABLE "workspace_purge_holds" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"placed_by" text NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_purge_holds_reason_length" CHECK (length("workspace_purge_holds"."reason") between 8 and 500),
	CONSTRAINT "workspace_purge_holds_actor_length" CHECK (length("workspace_purge_holds"."placed_by") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "workspace_purge_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"reason" text NOT NULL,
	"preview_digest" text NOT NULL,
	"impact" jsonb NOT NULL,
	"purged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_purge_receipts_reason" CHECK ("workspace_purge_receipts"."reason" in ('duplicate_workspace', 'test_data', 'user_requested', 'other')),
	CONSTRAINT "workspace_purge_receipts_digest" CHECK ("workspace_purge_receipts"."preview_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_purge_receipts_impact_shape" CHECK (jsonb_typeof("workspace_purge_receipts"."impact") = 'object')
);
--> statement-breakpoint
ALTER TABLE "workspace_purge_holds" ADD CONSTRAINT "workspace_purge_holds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_purge_receipts" ADD CONSTRAINT "workspace_purge_receipts_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_purge_receipts_workspace_unique" ON "workspace_purge_receipts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_purge_receipts_purged_at_idx" ON "workspace_purge_receipts" USING btree ("purged_at");--> statement-breakpoint
ALTER TABLE "workspace_purge_holds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_purge_holds" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_purge_holds_owner_select" ON "workspace_purge_holds"
  FOR SELECT USING (
    byok_grid_private.workspace_role(workspace_id) = 'owner'::workspace_role
  );--> statement-breakpoint
ALTER TABLE "workspace_purge_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_purge_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_purge_receipts_actor_insert" ON "workspace_purge_receipts"
  FOR INSERT WITH CHECK (
    actor_user_id = byok_grid_private.current_user_id()
    AND byok_grid_private.workspace_role(workspace_id) = 'owner'::workspace_role
  );
CREATE POLICY "workspace_purge_receipts_actor_select" ON "workspace_purge_receipts"
  FOR SELECT USING (
    actor_user_id = byok_grid_private.current_user_id()
  );--> statement-breakpoint
DROP POLICY IF EXISTS "workspaces_delete" ON "workspaces";
CREATE POLICY "workspaces_delete" ON "workspaces"
  FOR DELETE USING (
    byok_grid_private.workspace_role(id) = 'owner'::workspace_role
    AND NOT EXISTS (
      SELECT 1
      FROM workspace_purge_holds
      WHERE workspace_purge_holds.workspace_id = workspaces.id
    )
  );--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_web') THEN
    GRANT SELECT ON TABLE workspace_purge_holds TO byok_grid_web;
    GRANT SELECT, INSERT ON TABLE workspace_purge_receipts TO byok_grid_web;
  END IF;
END $$;
