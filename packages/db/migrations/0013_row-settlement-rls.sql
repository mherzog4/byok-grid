ALTER TABLE "row_settlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "row_settlements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "row_settlements"
  FOR ALL
  USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_web') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE "row_settlements"
      TO byok_grid_web;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_worker') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE "row_settlements"
      TO byok_grid_worker;
  END IF;
END
$$;
