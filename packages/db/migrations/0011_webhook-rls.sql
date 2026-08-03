ALTER TABLE "webhook_destinations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_destinations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "webhook_destinations"
  FOR ALL
  USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "webhook_deliveries"
  FOR ALL
  USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_web') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE "webhook_destinations", "webhook_deliveries"
      TO byok_grid_web;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_worker') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE "webhook_destinations", "webhook_deliveries"
      TO byok_grid_worker;
  END IF;
END
$$;
