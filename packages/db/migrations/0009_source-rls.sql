ALTER TABLE "source_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_definitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "source_definitions"
  FOR ALL
  USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
--> statement-breakpoint
ALTER TABLE "source_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "source_runs"
  FOR ALL
  USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
--> statement-breakpoint
ALTER TABLE "source_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "source_records"
  FOR ALL
  USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_web') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE "source_definitions", "source_runs", "source_records"
      TO byok_grid_web;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_worker') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE "source_definitions", "source_runs", "source_records"
      TO byok_grid_worker;
  END IF;
END
$$;
