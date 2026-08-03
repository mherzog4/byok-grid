CREATE TABLE "connector_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target" jsonb NOT NULL,
	"target_key" text NOT NULL,
	"reason" text NOT NULL,
	"created_by_user_id" uuid,
	"lifted_at" timestamp with time zone,
	"lifted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_revocations_target_shape" CHECK (jsonb_typeof("connector_revocations"."target") = 'object' and case "connector_revocations"."target"->>'kind'
        when 'publisher' then "connector_revocations"."target_key" = 'publisher:' || ("connector_revocations"."target"->>'publisherKeyId') and ("connector_revocations"."target"->>'publisherKeyId') ~ '^[a-z][a-z0-9_-]{0,63}$'
        when 'connector' then "connector_revocations"."target_key" = 'connector:' || ("connector_revocations"."target"->>'connectorId') and ("connector_revocations"."target"->>'connectorId') ~ '^[a-z][a-z0-9_-]{0,63}$'
        when 'version' then "connector_revocations"."target_key" = 'version:' || ("connector_revocations"."target"->>'connectorId') || '@' || ("connector_revocations"."target"->>'connectorVersion') and ("connector_revocations"."target"->>'connectorId') ~ '^[a-z][a-z0-9_-]{0,63}$' and ("connector_revocations"."target"->>'connectorVersion') ~ '^[0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z.-]+)?$'
        when 'artifact' then "connector_revocations"."target_key" = 'artifact:' || ("connector_revocations"."target"->>'artifactSha256') and ("connector_revocations"."target"->>'artifactSha256') ~ '^[0-9a-f]{64}$'
        else false end),
	CONSTRAINT "connector_revocations_reason_length" CHECK (length("connector_revocations"."reason") between 8 and 500),
	CONSTRAINT "connector_revocations_lift_actor" CHECK ("connector_revocations"."lifted_at" is not null or "connector_revocations"."lifted_by_user_id" is null)
);
--> statement-breakpoint
ALTER TABLE "cell_runs" ADD COLUMN "artifact_sha256" text;--> statement-breakpoint
ALTER TABLE "cell_runs" ADD COLUMN "registry_sha256" text;--> statement-breakpoint
ALTER TABLE "cell_runs" ADD COLUMN "publisher_key_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_revocations" ADD CONSTRAINT "connector_revocations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_revocations" ADD CONSTRAINT "connector_revocations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_revocations" ADD CONSTRAINT "connector_revocations_lifted_by_user_id_users_id_fk" FOREIGN KEY ("lifted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_revocations_workspace_active_target_unique" ON "connector_revocations" USING btree ("workspace_id","target_key") WHERE "connector_revocations"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "connector_revocations_workspace_created_idx" ON "connector_revocations" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "cell_runs" ADD CONSTRAINT "cell_runs_connector_digest_shape" CHECK (("cell_runs"."artifact_sha256" is null or "cell_runs"."artifact_sha256" ~ '^[0-9a-f]{64}$') and ("cell_runs"."registry_sha256" is null or "cell_runs"."registry_sha256" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "connector_revocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connector_revocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "connector_revocations_select" ON "connector_revocations"
  FOR SELECT USING (byok_grid_private.is_workspace_member(workspace_id));
CREATE POLICY "connector_revocations_insert" ON "connector_revocations"
  FOR INSERT WITH CHECK (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  );
CREATE POLICY "connector_revocations_update" ON "connector_revocations"
  FOR UPDATE USING (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  ) WITH CHECK (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  );--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_web') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE connector_revocations TO byok_grid_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_worker') THEN
    GRANT SELECT ON TABLE connector_revocations TO byok_grid_worker;
  END IF;
END $$;
