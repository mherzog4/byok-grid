CREATE SCHEMA IF NOT EXISTS "byok_grid_private";
--> statement-breakpoint
REVOKE ALL ON SCHEMA "byok_grid_private" FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "byok_grid_private"."current_user_id"()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('byok_grid.user_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "byok_grid_private"."invitation_token_hash"()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('byok_grid.invitation_token_hash', true), '')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "byok_grid_private"."workspace_role"(target_workspace_id uuid)
RETURNS workspace_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT member.role
  FROM public.workspace_members AS member
  WHERE member.workspace_id = target_workspace_id
    AND member.user_id = byok_grid_private.current_user_id()
  LIMIT 1
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "byok_grid_private"."is_workspace_member"(target_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_members AS member
    WHERE member.workspace_id = target_workspace_id
      AND member.user_id = byok_grid_private.current_user_id()
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "byok_grid_private"."workspace_has_no_members"(target_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.workspace_members AS member
    WHERE member.workspace_id = target_workspace_id
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "byok_grid_private"."can_assign_workspace_role"(
  target_workspace_id uuid,
  assigned_role workspace_role
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE byok_grid_private.workspace_role(target_workspace_id)
    WHEN 'owner'::workspace_role THEN assigned_role IN ('admin'::workspace_role, 'member'::workspace_role)
    WHEN 'admin'::workspace_role THEN assigned_role = 'member'::workspace_role
    ELSE false
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "byok_grid_private"."can_manage_workspace_member"(
  target_workspace_id uuid,
  target_role workspace_role
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE byok_grid_private.workspace_role(target_workspace_id)
    WHEN 'owner'::workspace_role THEN target_role <> 'owner'::workspace_role
    WHEN 'admin'::workspace_role THEN target_role = 'member'::workspace_role
    ELSE false
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "byok_grid_private"."is_active_invitation_claim"(
  invitation_email text,
  invitation_hash text,
  invitation_expires_at timestamptz,
  invitation_accepted_at timestamptz,
  invitation_revoked_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT byok_grid_private.current_user_id() IS NOT NULL
    AND byok_grid_private.invitation_token_hash() = invitation_hash
    AND invitation_accepted_at IS NULL
    AND invitation_revoked_at IS NULL
    AND invitation_expires_at > statement_timestamp()
    AND lower(invitation_email) = (
      SELECT lower(app_user.email)
      FROM public.users AS app_user
      WHERE app_user.id = byok_grid_private.current_user_id()
    )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "byok_grid_private"."is_accepted_invitation_claim"(
  target_workspace_id uuid,
  target_user_id uuid,
  target_role workspace_role
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT target_user_id = byok_grid_private.current_user_id()
    AND EXISTS (
      SELECT 1
      FROM public.workspace_invitations AS invitation
      INNER JOIN public.users AS app_user
        ON app_user.id = byok_grid_private.current_user_id()
      WHERE invitation.workspace_id = target_workspace_id
        AND invitation.role = target_role
        AND invitation.token_hash = byok_grid_private.invitation_token_hash()
        AND lower(invitation.email) = lower(app_user.email)
        AND invitation.accepted_by_user_id = target_user_id
        AND invitation.accepted_at IS NOT NULL
        AND invitation.revoked_at IS NULL
        AND invitation.expires_at > statement_timestamp()
    )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "byok_grid_private"."is_accepted_invitation_row_claim"(
  invitation_email text,
  invitation_hash text,
  invitation_expires_at timestamptz,
  invitation_accepted_at timestamptz,
  invitation_accepted_by_user_id uuid,
  invitation_revoked_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT byok_grid_private.current_user_id() IS NOT NULL
    AND byok_grid_private.invitation_token_hash() = invitation_hash
    AND invitation_accepted_at IS NOT NULL
    AND invitation_accepted_at <= statement_timestamp()
    AND invitation_accepted_by_user_id = byok_grid_private.current_user_id()
    AND invitation_revoked_at IS NULL
    AND invitation_expires_at > statement_timestamp()
    AND lower(invitation_email) = (
      SELECT lower(app_user.email)
      FROM public.users AS app_user
      WHERE app_user.id = byok_grid_private.current_user_id()
    )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "byok_grid_private"."guard_workspace_invitation_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.workspace_id,
    NEW.email,
    NEW.role,
    NEW.token_hash,
    NEW.invited_by_user_id,
    NEW.expires_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.workspace_id,
    OLD.email,
    OLD.role,
    OLD.token_hash,
    OLD.invited_by_user_id,
    OLD.expires_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Invitation scope fields are immutable.' USING ERRCODE = '42501';
  END IF;

  IF OLD.accepted_at IS NOT NULL AND ROW(NEW.accepted_at, NEW.accepted_by_user_id)
    IS DISTINCT FROM ROW(OLD.accepted_at, OLD.accepted_by_user_id) THEN
    RAISE EXCEPTION 'An accepted invitation is immutable.' USING ERRCODE = '42501';
  END IF;

  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'A revoked invitation is immutable.' USING ERRCODE = '42501';
  END IF;

  IF NEW.accepted_at IS NOT NULL AND NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'An invitation cannot be both accepted and revoked.' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "workspace_invitations_immutable_scope"
BEFORE UPDATE ON "workspace_invitations"
FOR EACH ROW EXECUTE FUNCTION "byok_grid_private"."guard_workspace_invitation_update"();
--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspaces_select" ON "workspaces"
  FOR SELECT USING (
    byok_grid_private.is_workspace_member(id)
    OR (
      byok_grid_private.current_user_id() IS NOT NULL
      AND byok_grid_private.workspace_has_no_members(id)
    )
  );
CREATE POLICY "workspaces_insert" ON "workspaces"
  FOR INSERT WITH CHECK (
    byok_grid_private.current_user_id() IS NOT NULL
    AND byok_grid_private.workspace_has_no_members(id)
  );
CREATE POLICY "workspaces_update" ON "workspaces"
  FOR UPDATE USING (
    byok_grid_private.workspace_role(id) = 'owner'::workspace_role
  ) WITH CHECK (
    byok_grid_private.workspace_role(id) = 'owner'::workspace_role
  );
CREATE POLICY "workspaces_delete" ON "workspaces"
  FOR DELETE USING (
    byok_grid_private.workspace_role(id) = 'owner'::workspace_role
  );
--> statement-breakpoint
ALTER TABLE "workspace_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_members" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_members_select" ON "workspace_members"
  FOR SELECT USING (
    user_id = byok_grid_private.current_user_id()
    OR byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  );
CREATE POLICY "workspace_members_insert" ON "workspace_members"
  FOR INSERT WITH CHECK (
    (
      user_id = byok_grid_private.current_user_id()
      AND role = 'owner'::workspace_role
      AND byok_grid_private.workspace_has_no_members(workspace_id)
    )
    OR byok_grid_private.can_assign_workspace_role(workspace_id, role)
    OR byok_grid_private.is_accepted_invitation_claim(workspace_id, user_id, role)
  );
CREATE POLICY "workspace_members_update" ON "workspace_members"
  FOR UPDATE USING (
    byok_grid_private.can_manage_workspace_member(workspace_id, role)
  ) WITH CHECK (
    byok_grid_private.can_assign_workspace_role(workspace_id, role)
  );
CREATE POLICY "workspace_members_delete" ON "workspace_members"
  FOR DELETE USING (
    byok_grid_private.can_manage_workspace_member(workspace_id, role)
  );
--> statement-breakpoint
ALTER TABLE "workspace_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_invitations_select" ON "workspace_invitations"
  FOR SELECT USING (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
    OR byok_grid_private.is_active_invitation_claim(
      email, token_hash, expires_at, accepted_at, revoked_at
    )
    OR byok_grid_private.is_accepted_invitation_row_claim(
      email,
      token_hash,
      expires_at,
      accepted_at,
      accepted_by_user_id,
      revoked_at
    )
  );
CREATE POLICY "workspace_invitations_insert" ON "workspace_invitations"
  FOR INSERT WITH CHECK (
    byok_grid_private.can_assign_workspace_role(workspace_id, role)
  );
CREATE POLICY "workspace_invitations_update" ON "workspace_invitations"
  FOR UPDATE USING (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
    OR byok_grid_private.is_active_invitation_claim(
      email, token_hash, expires_at, accepted_at, revoked_at
    )
  ) WITH CHECK (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
    OR byok_grid_private.is_accepted_invitation_row_claim(
      email,
      token_hash,
      expires_at,
      accepted_at,
      accepted_by_user_id,
      revoked_at
    )
  );
CREATE POLICY "workspace_invitations_delete" ON "workspace_invitations"
  FOR DELETE USING (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  );
--> statement-breakpoint
ALTER TABLE "data_tables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_tables" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "data_tables"
  FOR ALL USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
ALTER TABLE "columns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "columns" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "columns"
  FOR ALL USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
ALTER TABLE "column_dependencies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "column_dependencies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "column_dependencies"
  FOR ALL USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
ALTER TABLE "rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rows" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "rows"
  FOR ALL USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
ALTER TABLE "cells" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cells" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "cells"
  FOR ALL USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
ALTER TABLE "import_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "import_jobs"
  FOR ALL USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
ALTER TABLE "import_staged_rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_staged_rows" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "import_staged_rows"
  FOR ALL USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
ALTER TABLE "cell_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cell_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "cell_runs"
  FOR ALL USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
ALTER TABLE "usage_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_ledger" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "usage_ledger"
  FOR ALL USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "outbox_events"
  FOR ALL USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
--> statement-breakpoint
ALTER TABLE "workspace_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_keys_select" ON "workspace_keys"
  FOR SELECT USING (byok_grid_private.is_workspace_member(workspace_id));
CREATE POLICY "workspace_keys_insert" ON "workspace_keys"
  FOR INSERT WITH CHECK (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  );
CREATE POLICY "workspace_keys_update" ON "workspace_keys"
  FOR UPDATE USING (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  ) WITH CHECK (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  );
CREATE POLICY "workspace_keys_delete" ON "workspace_keys"
  FOR DELETE USING (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  );
ALTER TABLE "credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credentials" FORCE ROW LEVEL SECURITY;
CREATE POLICY "credentials_select" ON "credentials"
  FOR SELECT USING (byok_grid_private.is_workspace_member(workspace_id));
CREATE POLICY "credentials_insert" ON "credentials"
  FOR INSERT WITH CHECK (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  );
CREATE POLICY "credentials_update" ON "credentials"
  FOR UPDATE USING (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  ) WITH CHECK (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  );
CREATE POLICY "credentials_delete" ON "credentials"
  FOR DELETE USING (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  );
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_web') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public, byok_grid_private TO byok_grid_web';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO byok_grid_web';
    EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO byok_grid_web';
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA byok_grid_private TO byok_grid_web';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO byok_grid_web';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO byok_grid_web';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA byok_grid_private GRANT EXECUTE ON FUNCTIONS TO byok_grid_web';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_worker') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public, byok_grid_private TO byok_grid_worker';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO byok_grid_worker';
    EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO byok_grid_worker';
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA byok_grid_private TO byok_grid_worker';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO byok_grid_worker';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO byok_grid_worker';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA byok_grid_private GRANT EXECUTE ON FUNCTIONS TO byok_grid_worker';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "byok_grid_private" FROM PUBLIC;
