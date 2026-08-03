CREATE DATABASE hatchet;

REVOKE CONNECT ON DATABASE hatchet FROM PUBLIC;
GRANT CONNECT ON DATABASE hatchet TO postgres;

-- Local-only credentials. Production deployments should create equivalent
-- least-privilege roles with secrets supplied by their platform.
CREATE ROLE byok_grid_web
  LOGIN PASSWORD 'byok-grid-web-local'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE byok_grid_worker
  LOGIN PASSWORD 'byok-grid-worker-local'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;

GRANT CONNECT ON DATABASE byok_grid TO byok_grid_web, byok_grid_worker;
GRANT USAGE ON SCHEMA public TO byok_grid_web, byok_grid_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO byok_grid_web, byok_grid_worker;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public
  TO byok_grid_web, byok_grid_worker;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
  TO byok_grid_web, byok_grid_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES
  TO byok_grid_web, byok_grid_worker;
