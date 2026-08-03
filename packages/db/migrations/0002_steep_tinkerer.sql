CREATE TYPE "public"."import_job_status" AS ENUM('staging', 'queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"filename" text NOT NULL,
	"status" "import_job_status" DEFAULT 'staging' NOT NULL,
	"headers" text[] DEFAULT '{}' NOT NULL,
	"column_mapping" jsonb,
	"uploaded_bytes" bigint DEFAULT 0 NOT NULL,
	"staged_row_count" integer DEFAULT 0 NOT NULL,
	"imported_row_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_jobs_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "import_jobs_nonnegative_counts" CHECK ("import_jobs"."uploaded_bytes" >= 0 and "import_jobs"."staged_row_count" >= 0 and "import_jobs"."imported_row_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "import_staged_rows" (
	"import_job_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"values" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_staged_rows_import_job_id_row_number_pk" PRIMARY KEY("import_job_id","row_number"),
	CONSTRAINT "import_staged_rows_positive_number" CHECK ("import_staged_rows"."row_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_table_workspace_fk" FOREIGN KEY ("table_id","workspace_id") REFERENCES "public"."data_tables"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_staged_rows" ADD CONSTRAINT "import_staged_rows_job_workspace_fk" FOREIGN KEY ("import_job_id","workspace_id") REFERENCES "public"."import_jobs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_jobs_workspace_created_idx" ON "import_jobs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "import_jobs_status_created_idx" ON "import_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "import_staged_rows_workspace_job_idx" ON "import_staged_rows" USING btree ("workspace_id","import_job_id","row_number");