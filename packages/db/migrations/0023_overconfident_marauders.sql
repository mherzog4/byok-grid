CREATE TYPE "public"."ingestion_batch_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "ingestion_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"status" "ingestion_batch_status" DEFAULT 'queued' NOT NULL,
	"fields" text[] NOT NULL,
	"record_count" integer NOT NULL,
	"processed_record_count" integer DEFAULT 0 NOT NULL,
	"created_row_count" integer DEFAULT 0 NOT NULL,
	"updated_row_count" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_batches_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "ingestion_batches_nonnegative_counts" CHECK ("ingestion_batches"."record_count" between 1 and 1000 and "ingestion_batches"."processed_record_count" >= 0 and "ingestion_batches"."created_row_count" >= 0 and "ingestion_batches"."updated_row_count" >= 0 and "ingestion_batches"."attempt" >= 0),
	CONSTRAINT "ingestion_batches_request_digest_length" CHECK (length("ingestion_batches"."request_digest") = 64)
);
--> statement-breakpoint
CREATE TABLE "ingestion_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"record_key_field" text NOT NULL,
	"field_mapping" jsonb,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_endpoints_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "ingestion_endpoints_scope_unique" UNIQUE("id","table_id","workspace_id"),
	CONSTRAINT "ingestion_endpoints_token_hash_length" CHECK (length("ingestion_endpoints"."token_hash") = 64),
	CONSTRAINT "ingestion_endpoints_token_prefix_length" CHECK (length("ingestion_endpoints"."token_prefix") between 8 and 24)
);
--> statement-breakpoint
CREATE TABLE "ingestion_records" (
	"endpoint_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"record_key" text NOT NULL,
	"row_id" uuid NOT NULL,
	"last_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_records_endpoint_id_record_key_pk" PRIMARY KEY("endpoint_id","record_key"),
	CONSTRAINT "ingestion_records_key_length" CHECK (length("ingestion_records"."record_key") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "ingestion_staged_records" (
	"batch_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"record_key" text NOT NULL,
	"values" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_staged_records_batch_id_ordinal_pk" PRIMARY KEY("batch_id","ordinal"),
	CONSTRAINT "ingestion_staged_records_valid_ordinal" CHECK ("ingestion_staged_records"."ordinal" between 1 and 1000),
	CONSTRAINT "ingestion_staged_records_key_length" CHECK (length("ingestion_staged_records"."record_key") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "ingestion_batches" ADD CONSTRAINT "ingestion_batches_endpoint_scope_fk" FOREIGN KEY ("endpoint_id","table_id","workspace_id") REFERENCES "public"."ingestion_endpoints"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_endpoints" ADD CONSTRAINT "ingestion_endpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_endpoints" ADD CONSTRAINT "ingestion_endpoints_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_endpoints" ADD CONSTRAINT "ingestion_endpoints_table_workspace_fk" FOREIGN KEY ("table_id","workspace_id") REFERENCES "public"."data_tables"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_records" ADD CONSTRAINT "ingestion_records_last_batch_id_ingestion_batches_id_fk" FOREIGN KEY ("last_batch_id") REFERENCES "public"."ingestion_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_records" ADD CONSTRAINT "ingestion_records_endpoint_scope_fk" FOREIGN KEY ("endpoint_id","table_id","workspace_id") REFERENCES "public"."ingestion_endpoints"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_records" ADD CONSTRAINT "ingestion_records_row_scope_fk" FOREIGN KEY ("row_id","table_id","workspace_id") REFERENCES "public"."rows"("id","table_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_staged_records" ADD CONSTRAINT "ingestion_staged_records_batch_workspace_fk" FOREIGN KEY ("batch_id","workspace_id") REFERENCES "public"."ingestion_batches"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_batches_endpoint_idempotency_unique" ON "ingestion_batches" USING btree ("endpoint_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ingestion_batches_workspace_created_idx" ON "ingestion_batches" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_endpoints_token_hash_unique" ON "ingestion_endpoints" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ingestion_endpoints_workspace_table_idx" ON "ingestion_endpoints" USING btree ("workspace_id","table_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_records_endpoint_row_unique" ON "ingestion_records" USING btree ("endpoint_id","row_id");--> statement-breakpoint
CREATE INDEX "ingestion_records_workspace_table_idx" ON "ingestion_records" USING btree ("workspace_id","table_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_staged_records_batch_key_unique" ON "ingestion_staged_records" USING btree ("batch_id","record_key");--> statement-breakpoint
CREATE INDEX "ingestion_staged_records_workspace_batch_idx" ON "ingestion_staged_records" USING btree ("workspace_id","batch_id","ordinal");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "byok_grid_private"."ingestion_token_hash"()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('byok_grid.ingestion_token_hash', true), '')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "byok_grid_private"."has_active_ingestion_claim"(
  target_endpoint_id uuid,
  target_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.ingestion_endpoints AS endpoint
    WHERE endpoint.id = target_endpoint_id
      AND endpoint.workspace_id = target_workspace_id
      AND endpoint.token_hash = byok_grid_private.ingestion_token_hash()
      AND endpoint.revoked_at IS NULL
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "byok_grid_private"."has_ingestion_batch_claim"(
  target_batch_id uuid,
  target_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.ingestion_batches AS batch
    INNER JOIN public.ingestion_endpoints AS endpoint
      ON endpoint.id = batch.endpoint_id
      AND endpoint.workspace_id = batch.workspace_id
    WHERE batch.id = target_batch_id
      AND batch.workspace_id = target_workspace_id
      AND endpoint.token_hash = byok_grid_private.ingestion_token_hash()
      AND endpoint.revoked_at IS NULL
  )
$$;
--> statement-breakpoint
ALTER TABLE "ingestion_endpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingestion_endpoints" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ingestion_endpoints_select" ON "ingestion_endpoints"
  FOR SELECT USING (
    byok_grid_private.is_workspace_member(workspace_id)
    OR byok_grid_private.has_active_ingestion_claim(id, workspace_id)
  );
CREATE POLICY "ingestion_endpoints_insert" ON "ingestion_endpoints"
  FOR INSERT WITH CHECK (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
    AND created_by_user_id = byok_grid_private.current_user_id()
  );
CREATE POLICY "ingestion_endpoints_update" ON "ingestion_endpoints"
  FOR UPDATE USING (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  ) WITH CHECK (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  );
CREATE POLICY "ingestion_endpoints_delete" ON "ingestion_endpoints"
  FOR DELETE USING (
    byok_grid_private.workspace_role(workspace_id) IN ('owner'::workspace_role, 'admin'::workspace_role)
  );
--> statement-breakpoint
ALTER TABLE "ingestion_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingestion_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ingestion_batches_select" ON "ingestion_batches"
  FOR SELECT USING (
    byok_grid_private.is_workspace_member(workspace_id)
    OR byok_grid_private.has_active_ingestion_claim(endpoint_id, workspace_id)
  );
CREATE POLICY "ingestion_batches_insert" ON "ingestion_batches"
  FOR INSERT WITH CHECK (
    byok_grid_private.has_active_ingestion_claim(endpoint_id, workspace_id)
  );
CREATE POLICY "ingestion_batches_member_write" ON "ingestion_batches"
  FOR ALL USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
--> statement-breakpoint
ALTER TABLE "ingestion_staged_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingestion_staged_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ingestion_staged_records_select" ON "ingestion_staged_records"
  FOR SELECT USING (
    byok_grid_private.is_workspace_member(workspace_id)
    OR byok_grid_private.has_ingestion_batch_claim(batch_id, workspace_id)
  );
CREATE POLICY "ingestion_staged_records_insert" ON "ingestion_staged_records"
  FOR INSERT WITH CHECK (
    byok_grid_private.has_ingestion_batch_claim(batch_id, workspace_id)
  );
CREATE POLICY "ingestion_staged_records_member_write" ON "ingestion_staged_records"
  FOR ALL USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
--> statement-breakpoint
ALTER TABLE "ingestion_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingestion_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_member_access" ON "ingestion_records"
  FOR ALL USING (byok_grid_private.is_workspace_member(workspace_id))
  WITH CHECK (byok_grid_private.is_workspace_member(workspace_id));
--> statement-breakpoint
CREATE POLICY "ingestion_claim_insert" ON "outbox_events"
  FOR INSERT WITH CHECK (
    aggregate_type = 'ingestion_batch'
    AND event_type = 'table.ingestion_batch_requested'
    AND byok_grid_private.has_ingestion_batch_claim(aggregate_id, workspace_id)
  );
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_web') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE "ingestion_endpoints", "ingestion_batches", "ingestion_staged_records", "ingestion_records"
      TO byok_grid_web;
    GRANT EXECUTE ON FUNCTION
      "byok_grid_private"."ingestion_token_hash"(),
      "byok_grid_private"."has_active_ingestion_claim"(uuid, uuid),
      "byok_grid_private"."has_ingestion_batch_claim"(uuid, uuid)
      TO byok_grid_web;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'byok_grid_worker') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE "ingestion_endpoints", "ingestion_batches", "ingestion_staged_records", "ingestion_records"
      TO byok_grid_worker;
    GRANT EXECUTE ON FUNCTION
      "byok_grid_private"."ingestion_token_hash"(),
      "byok_grid_private"."has_active_ingestion_claim"(uuid, uuid),
      "byok_grid_private"."has_ingestion_batch_claim"(uuid, uuid)
      TO byok_grid_worker;
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  "byok_grid_private"."ingestion_token_hash"(),
  "byok_grid_private"."has_active_ingestion_claim"(uuid, uuid),
  "byok_grid_private"."has_ingestion_batch_claim"(uuid, uuid)
  FROM PUBLIC;
