ALTER TABLE "bulk_run_items" DROP CONSTRAINT "bulk_run_items_run_workspace_fk";
--> statement-breakpoint
ALTER TABLE "bulk_run_items" ADD CONSTRAINT "bulk_run_items_run_id_cell_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."cell_runs"("id") ON DELETE set null ON UPDATE no action;