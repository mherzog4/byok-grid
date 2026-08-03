DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_web') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE "bulk_run_batches", "bulk_run_items"
      TO byok_grid_web;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_worker') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE "bulk_run_batches", "bulk_run_items"
      TO byok_grid_worker;
  END IF;
END
$$;
