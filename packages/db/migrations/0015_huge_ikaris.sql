CREATE TYPE "public"."source_pagination_mode" AS ENUM('none', 'cursor');--> statement-breakpoint
ALTER TABLE "source_runs" DROP CONSTRAINT "source_runs_nonnegative_counts";--> statement-breakpoint
ALTER TABLE "source_definitions" ADD COLUMN "pagination_mode" "source_pagination_mode" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_definitions" ADD COLUMN "cursor_parameter" text;--> statement-breakpoint
ALTER TABLE "source_definitions" ADD COLUMN "next_cursor_path" text;--> statement-breakpoint
ALTER TABLE "source_definitions" ADD COLUMN "max_pages" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_runs" ADD COLUMN "page_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_runs" ADD COLUMN "next_cursor_encrypted" jsonb;--> statement-breakpoint
ALTER TABLE "source_definitions" ADD CONSTRAINT "source_definitions_pagination_limits" CHECK ("source_definitions"."max_pages" between 1 and 25);--> statement-breakpoint
ALTER TABLE "source_definitions" ADD CONSTRAINT "source_definitions_pagination_configuration" CHECK (("source_definitions"."pagination_mode" = 'none' and "source_definitions"."cursor_parameter" is null and "source_definitions"."next_cursor_path" is null and "source_definitions"."max_pages" = 1) or ("source_definitions"."pagination_mode" = 'cursor' and "source_definitions"."cursor_parameter" is not null and "source_definitions"."next_cursor_path" is not null and "source_definitions"."max_pages" >= 2));--> statement-breakpoint
ALTER TABLE "source_runs" ADD CONSTRAINT "source_runs_nonnegative_counts" CHECK ("source_runs"."attempt" >= 0 and "source_runs"."page_count" >= 0 and "source_runs"."received_record_count" >= 0 and "source_runs"."created_row_count" >= 0 and "source_runs"."updated_row_count" >= 0);