DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_web') THEN
    REVOKE ALL PRIVILEGES ON TABLE workspace_purge_holds FROM byok_grid_web;
    REVOKE ALL PRIVILEGES ON TABLE workspace_purge_receipts FROM byok_grid_web;
    GRANT SELECT ON TABLE workspace_purge_holds TO byok_grid_web;
    GRANT SELECT, INSERT ON TABLE workspace_purge_receipts TO byok_grid_web;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_worker') THEN
    REVOKE ALL PRIVILEGES ON TABLE workspace_purge_holds FROM byok_grid_worker;
    REVOKE ALL PRIVILEGES ON TABLE workspace_purge_receipts FROM byok_grid_worker;
    GRANT SELECT, UPDATE ON TABLE workspace_purge_receipts TO byok_grid_worker;
  END IF;
END $$;
