CREATE TYPE "public"."source_missing_record_mode" AS ENUM('preserve', 'archive');--> statement-breakpoint
ALTER TABLE "source_runs" DROP CONSTRAINT "source_runs_nonnegative_counts";--> statement-breakpoint
DROP INDEX "rows_table_position_idx";--> statement-breakpoint
ALTER TABLE "rows" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_definitions" ADD COLUMN "missing_record_mode" "source_missing_record_mode" DEFAULT 'preserve' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_records" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_records" ADD COLUMN "archived_by_run_id" uuid;--> statement-breakpoint
ALTER TABLE "source_runs" ADD COLUMN "archived_row_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_runs" ADD COLUMN "restored_row_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_archived_by_run_id_source_runs_id_fk" FOREIGN KEY ("archived_by_run_id") REFERENCES "public"."source_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rows_table_archived_position_idx" ON "rows" USING btree ("table_id","archived_at","position");--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_archive_state" CHECK (("source_records"."archived_at" is null and "source_records"."archived_by_run_id" is null) or ("source_records"."archived_at" is not null and "source_records"."archived_by_run_id" is not null));--> statement-breakpoint
ALTER TABLE "source_runs" ADD CONSTRAINT "source_runs_nonnegative_counts" CHECK ("source_runs"."attempt" >= 0 and "source_runs"."page_count" >= 0 and "source_runs"."received_record_count" >= 0 and "source_runs"."created_row_count" >= 0 and "source_runs"."updated_row_count" >= 0 and "source_runs"."archived_row_count" >= 0 and "source_runs"."restored_row_count" >= 0);
