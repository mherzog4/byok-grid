CREATE TABLE `ingestion_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`fields` text NOT NULL,
	`record_count` integer NOT NULL,
	`processed_record_count` integer DEFAULT 0 NOT NULL,
	`created_row_count` integer DEFAULT 0 NOT NULL,
	`updated_row_count` integer DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`endpoint_id`,`table_id`,`workspace_id`) REFERENCES `ingestion_endpoints`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ingestion_batches_valid_status" CHECK("ingestion_batches"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "ingestion_batches_nonnegative_counts" CHECK("ingestion_batches"."record_count" between 1 and 1000 and "ingestion_batches"."processed_record_count" between 0 and "ingestion_batches"."record_count" and "ingestion_batches"."created_row_count" >= 0 and "ingestion_batches"."updated_row_count" >= 0 and "ingestion_batches"."created_row_count" + "ingestion_batches"."updated_row_count" <= "ingestion_batches"."processed_record_count" and "ingestion_batches"."attempt" >= 0),
	CONSTRAINT "ingestion_batches_request_digest_length" CHECK(length("ingestion_batches"."request_digest") = 64 and "ingestion_batches"."request_digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "ingestion_batches_payload_shape" CHECK(json_valid("ingestion_batches"."fields") and json_type("ingestion_batches"."fields") = 'array' and json_array_length("ingestion_batches"."fields") between 1 and 100 and length("ingestion_batches"."idempotency_key") between 8 and 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingestion_batches_endpoint_idempotency_unique` ON `ingestion_batches` (`endpoint_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `ingestion_batches_workspace_created_idx` ON `ingestion_batches` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `ingestion_batches_id_workspace_unique` ON `ingestion_batches` (`id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `ingestion_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`created_by_user_id` text,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`record_key_field` text NOT NULL,
	`field_mapping` text,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`table_id`,`workspace_id`) REFERENCES `data_tables`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ingestion_endpoints_token_hash_length" CHECK(length("ingestion_endpoints"."token_hash") = 64 and "ingestion_endpoints"."token_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "ingestion_endpoints_token_prefix_length" CHECK(length("ingestion_endpoints"."token_prefix") between 8 and 24),
	CONSTRAINT "ingestion_endpoints_text_lengths" CHECK(length("ingestion_endpoints"."name") between 1 and 120 and length("ingestion_endpoints"."record_key_field") between 1 and 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingestion_endpoints_token_hash_unique` ON `ingestion_endpoints` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ingestion_endpoints_workspace_table_idx` ON `ingestion_endpoints` (`workspace_id`,`table_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `ingestion_endpoints_id_workspace_unique` ON `ingestion_endpoints` (`id`,`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ingestion_endpoints_scope_unique` ON `ingestion_endpoints` (`id`,`table_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `ingestion_records` (
	`endpoint_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`record_key` text NOT NULL,
	`row_id` text NOT NULL,
	`last_batch_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`endpoint_id`, `record_key`),
	FOREIGN KEY (`last_batch_id`) REFERENCES `ingestion_batches`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`endpoint_id`,`table_id`,`workspace_id`) REFERENCES `ingestion_endpoints`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`row_id`,`table_id`,`workspace_id`) REFERENCES `rows`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ingestion_records_key_length" CHECK(length("ingestion_records"."record_key") between 1 and 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingestion_records_endpoint_row_unique` ON `ingestion_records` (`endpoint_id`,`row_id`);--> statement-breakpoint
CREATE INDEX `ingestion_records_workspace_table_idx` ON `ingestion_records` (`workspace_id`,`table_id`);--> statement-breakpoint
CREATE TABLE `ingestion_staged_records` (
	`batch_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`record_key` text NOT NULL,
	`values` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`batch_id`, `ordinal`),
	FOREIGN KEY (`batch_id`,`workspace_id`) REFERENCES `ingestion_batches`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ingestion_staged_records_valid_ordinal" CHECK("ingestion_staged_records"."ordinal" between 1 and 1000),
	CONSTRAINT "ingestion_staged_records_key_length" CHECK(length("ingestion_staged_records"."record_key") between 1 and 500),
	CONSTRAINT "ingestion_staged_records_values_shape" CHECK(json_valid("ingestion_staged_records"."values") and json_type("ingestion_staged_records"."values") = 'object' and length(cast("ingestion_staged_records"."values" as blob)) <= 262144)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingestion_staged_records_batch_key_unique` ON `ingestion_staged_records` (`batch_id`,`record_key`);--> statement-breakpoint
CREATE INDEX `ingestion_staged_records_workspace_batch_idx` ON `ingestion_staged_records` (`workspace_id`,`batch_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `source_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`created_by_user_id` text,
	`name` text NOT NULL,
	`adapter_id` text DEFAULT 'http_json' NOT NULL,
	`adapter_configuration` text,
	`endpoint_url` text NOT NULL,
	`credential_id` text,
	`record_path` text DEFAULT '' NOT NULL,
	`record_key_field` text NOT NULL,
	`max_records` integer DEFAULT 1000 NOT NULL,
	`missing_record_mode` text DEFAULT 'preserve' NOT NULL,
	`pagination_mode` text DEFAULT 'none' NOT NULL,
	`cursor_parameter` text,
	`next_cursor_path` text,
	`max_pages` integer DEFAULT 1 NOT NULL,
	`field_mapping` text,
	`status` text DEFAULT 'active' NOT NULL,
	`schedule_interval_minutes` integer,
	`next_run_at` integer,
	`last_run_at` integer,
	`incremental_watermark` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`table_id`,`workspace_id`) REFERENCES `data_tables`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`,`workspace_id`) REFERENCES `credentials`(`id`,`workspace_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "source_definitions_record_limits" CHECK("source_definitions"."max_records" between 1 and 5000),
	CONSTRAINT "source_definitions_supported_adapter" CHECK("source_definitions"."adapter_id" in ('http_json', 'hubspot_contacts')),
	CONSTRAINT "source_definitions_adapter_configuration" CHECK(("source_definitions"."adapter_id" = 'http_json' and "source_definitions"."adapter_configuration" is null and "source_definitions"."incremental_watermark" is null) or ("source_definitions"."adapter_id" = 'hubspot_contacts' and json_valid("source_definitions"."adapter_configuration") and json_type("source_definitions"."adapter_configuration") = 'object' and "source_definitions"."credential_id" is not null and "source_definitions"."missing_record_mode" = 'preserve' and "source_definitions"."pagination_mode" = 'cursor')),
	CONSTRAINT "source_definitions_schedule_interval" CHECK("source_definitions"."schedule_interval_minutes" is null or "source_definitions"."schedule_interval_minutes" >= 5),
	CONSTRAINT "source_definitions_pagination_limits" CHECK("source_definitions"."max_pages" between 1 and 25),
	CONSTRAINT "source_definitions_pagination_configuration" CHECK(("source_definitions"."pagination_mode" = 'none' and "source_definitions"."cursor_parameter" is null and "source_definitions"."next_cursor_path" is null and "source_definitions"."max_pages" = 1) or ("source_definitions"."pagination_mode" = 'cursor' and "source_definitions"."cursor_parameter" is not null and "source_definitions"."next_cursor_path" is not null and "source_definitions"."max_pages" >= 2)),
	CONSTRAINT "source_definitions_manual_has_no_next_run" CHECK("source_definitions"."schedule_interval_minutes" is not null or "source_definitions"."next_run_at" is null),
	CONSTRAINT "source_definitions_valid_status" CHECK("source_definitions"."status" in ('active', 'paused')),
	CONSTRAINT "source_definitions_mapping_json" CHECK("source_definitions"."field_mapping" is null or json_valid("source_definitions"."field_mapping"))
);
--> statement-breakpoint
CREATE INDEX `source_definitions_workspace_table_idx` ON `source_definitions` (`workspace_id`,`table_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `source_definitions_due_idx` ON `source_definitions` (`status`,`next_run_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_definitions_id_workspace_unique` ON `source_definitions` (`id`,`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_definitions_scope_unique` ON `source_definitions` (`id`,`table_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `source_records` (
	`source_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`record_key` text NOT NULL,
	`row_id` text NOT NULL,
	`last_seen_run_id` text,
	`archived_at` integer,
	`archived_by_run_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`source_id`, `record_key`),
	FOREIGN KEY (`last_seen_run_id`) REFERENCES `source_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`archived_by_run_id`) REFERENCES `source_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_id`,`table_id`,`workspace_id`) REFERENCES `source_definitions`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`row_id`,`table_id`,`workspace_id`) REFERENCES `rows`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "source_records_key_length" CHECK(length("source_records"."record_key") between 1 and 500),
	CONSTRAINT "source_records_archive_state" CHECK(("source_records"."archived_at" is null and "source_records"."archived_by_run_id" is null) or ("source_records"."archived_at" is not null and "source_records"."archived_by_run_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_records_source_row_unique` ON `source_records` (`source_id`,`row_id`);--> statement-breakpoint
CREATE INDEX `source_records_workspace_table_idx` ON `source_records` (`workspace_id`,`table_id`);--> statement-breakpoint
CREATE TABLE `source_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`scheduled_for` integer NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`page_count` integer DEFAULT 0 NOT NULL,
	`next_cursor_encrypted` text,
	`incremental_window_start` integer,
	`incremental_window_end` integer,
	`received_record_count` integer DEFAULT 0 NOT NULL,
	`created_row_count` integer DEFAULT 0 NOT NULL,
	`updated_row_count` integer DEFAULT 0 NOT NULL,
	`archived_row_count` integer DEFAULT 0 NOT NULL,
	`restored_row_count` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`source_id`,`table_id`,`workspace_id`) REFERENCES `source_definitions`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "source_runs_valid_state" CHECK("source_runs"."trigger" in ('manual', 'schedule') and "source_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "source_runs_nonnegative_counts" CHECK("source_runs"."attempt" >= 0 and "source_runs"."page_count" >= 0 and "source_runs"."received_record_count" >= 0 and "source_runs"."created_row_count" >= 0 and "source_runs"."updated_row_count" >= 0 and "source_runs"."archived_row_count" >= 0 and "source_runs"."restored_row_count" >= 0),
	CONSTRAINT "source_runs_incremental_window" CHECK(("source_runs"."incremental_window_start" is null and "source_runs"."incremental_window_end" is null) or ("source_runs"."incremental_window_start" is not null and "source_runs"."incremental_window_end" is not null and "source_runs"."incremental_window_start" < "source_runs"."incremental_window_end"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_runs_source_scheduled_unique` ON `source_runs` (`source_id`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `source_runs_workspace_created_idx` ON `source_runs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `source_runs_source_created_idx` ON `source_runs` (`source_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_runs_id_workspace_unique` ON `source_runs` (`id`,`workspace_id`);