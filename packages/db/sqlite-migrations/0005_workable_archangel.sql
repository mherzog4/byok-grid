CREATE TABLE `bulk_run_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`column_id` text NOT NULL,
	`created_by_user_id` text,
	`mode` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`selected_row_count` integer NOT NULL,
	`queued_row_count` integer DEFAULT 0 NOT NULL,
	`skipped_row_count` integer DEFAULT 0 NOT NULL,
	`estimated_provider_requests` integer NOT NULL,
	`estimated_max_output_tokens` integer,
	`selection_snapshot` text DEFAULT '{"kind":"all_rows","searchQuery":null}' NOT NULL,
	`selection_digest` text DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' NOT NULL,
	`cancelled_by_user_id` text,
	`cancelled_at` integer,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`table_id`,`workspace_id`) REFERENCES `data_tables`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`column_id`,`table_id`,`workspace_id`) REFERENCES `columns`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "bulk_run_batches_valid_state" CHECK("bulk_run_batches"."mode" in ('pending', 'all') and "bulk_run_batches"."status" in ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "bulk_run_batches_nonnegative_counts" CHECK("bulk_run_batches"."selected_row_count" >= 0 and "bulk_run_batches"."queued_row_count" >= 0 and "bulk_run_batches"."skipped_row_count" >= 0 and "bulk_run_batches"."estimated_provider_requests" >= 0 and ("bulk_run_batches"."estimated_max_output_tokens" is null or "bulk_run_batches"."estimated_max_output_tokens" >= 0)),
	CONSTRAINT "bulk_run_batches_processed_within_selected" CHECK("bulk_run_batches"."queued_row_count" + "bulk_run_batches"."skipped_row_count" <= "bulk_run_batches"."selected_row_count"),
	CONSTRAINT "bulk_run_batches_selection_shape" CHECK(json_valid("bulk_run_batches"."selection_snapshot") and json_type("bulk_run_batches"."selection_snapshot") = 'object' and length("bulk_run_batches"."selection_digest") = 64 and "bulk_run_batches"."selection_digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "bulk_run_batches_cancellation_state" CHECK(("bulk_run_batches"."status" = 'cancelled' and "bulk_run_batches"."cancelled_at" is not null) or ("bulk_run_batches"."status" <> 'cancelled' and "bulk_run_batches"."cancelled_at" is null and "bulk_run_batches"."cancelled_by_user_id" is null))
);
--> statement-breakpoint
CREATE INDEX `bulk_run_batches_workspace_created_idx` ON `bulk_run_batches` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `bulk_run_batches_status_created_idx` ON `bulk_run_batches` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `bulk_run_batches_id_workspace_unique` ON `bulk_run_batches` (`id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `bulk_run_items` (
	`batch_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`row_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`run_id` text,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`batch_id`, `row_id`),
	FOREIGN KEY (`run_id`) REFERENCES `cell_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`batch_id`,`workspace_id`) REFERENCES `bulk_run_batches`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`row_id`,`table_id`,`workspace_id`) REFERENCES `rows`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "bulk_run_items_nonnegative_sequence" CHECK("bulk_run_items"."sequence" >= 0),
	CONSTRAINT "bulk_run_items_valid_status" CHECK("bulk_run_items"."status" in ('pending', 'queued', 'skipped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bulk_run_items_batch_sequence_unique` ON `bulk_run_items` (`batch_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `bulk_run_items_batch_status_sequence_idx` ON `bulk_run_items` (`batch_id`,`status`,`sequence`);--> statement-breakpoint
CREATE TABLE `cell_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`cell_id` text NOT NULL,
	`credential_id` text,
	`connector_id` text NOT NULL,
	`connector_version` text DEFAULT '1.0.0' NOT NULL,
	`artifact_sha256` text,
	`registry_sha256` text,
	`publisher_key_ids` text DEFAULT '[]' NOT NULL,
	`action_id` text NOT NULL,
	`input` text NOT NULL,
	`input_fingerprint` text NOT NULL,
	`allowed_hosts` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`output` text,
	`error_code` text,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cell_id`,`workspace_id`) REFERENCES `cells`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`,`workspace_id`) REFERENCES `credentials`(`id`,`workspace_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cell_runs_valid_state" CHECK("cell_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled') and "cell_runs"."attempt" >= 0),
	CONSTRAINT "cell_runs_json_arrays" CHECK(json_valid("cell_runs"."publisher_key_ids") and json_type("cell_runs"."publisher_key_ids") = 'array' and json_valid("cell_runs"."allowed_hosts") and json_type("cell_runs"."allowed_hosts") = 'array' and json_valid("cell_runs"."input")),
	CONSTRAINT "cell_runs_connector_digest_shape" CHECK(("cell_runs"."artifact_sha256" is null or (length("cell_runs"."artifact_sha256") = 64 and "cell_runs"."artifact_sha256" not glob '*[^0-9a-f]*')) and ("cell_runs"."registry_sha256" is null or (length("cell_runs"."registry_sha256") = 64 and "cell_runs"."registry_sha256" not glob '*[^0-9a-f]*')))
);
--> statement-breakpoint
CREATE INDEX `cell_runs_cell_created_idx` ON `cell_runs` (`cell_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `cell_runs_workspace_status_idx` ON `cell_runs` (`workspace_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `cell_runs_id_workspace_unique` ON `cell_runs` (`id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`published_at` integer,
	`analytics_claim_id` text,
	`analytics_claimed_at` integer,
	`analytics_projected_at` integer,
	`analytics_attempts` integer DEFAULT 0 NOT NULL,
	`analytics_next_attempt_at` integer,
	`analytics_last_error` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "outbox_payload_json" CHECK(json_valid("outbox_events"."payload") and json_type("outbox_events"."payload") = 'object'),
	CONSTRAINT "outbox_analytics_projection_state" CHECK("outbox_events"."analytics_attempts" >= 0 and (("outbox_events"."analytics_claim_id" is null and "outbox_events"."analytics_claimed_at" is null) or ("outbox_events"."analytics_claim_id" is not null and "outbox_events"."analytics_claimed_at" is not null)) and ("outbox_events"."analytics_last_error" is null or length("outbox_events"."analytics_last_error") <= 500))
);
--> statement-breakpoint
CREATE INDEX `outbox_unpublished_idx` ON `outbox_events` (`published_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `outbox_analytics_projection_idx` ON `outbox_events` (`analytics_projected_at`,`analytics_next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `outbox_workspace_created_idx` ON `outbox_events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `row_settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`row_id` text NOT NULL,
	`row_version` integer NOT NULL,
	`changed_column_ids` text DEFAULT '[]' NOT NULL,
	`consumed_by_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`queued_delivery_count` integer DEFAULT 0 NOT NULL,
	`queued_run_count` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`row_id`,`table_id`,`workspace_id`) REFERENCES `rows`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "row_settlements_valid_version" CHECK("row_settlements"."row_version" > 0),
	CONSTRAINT "row_settlements_changed_columns_json" CHECK(json_valid("row_settlements"."changed_column_ids") and json_type("row_settlements"."changed_column_ids") = 'array'),
	CONSTRAINT "row_settlements_valid_state" CHECK("row_settlements"."status" in ('queued', 'running', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "row_settlements_valid_delivery_count" CHECK("row_settlements"."queued_delivery_count" >= 0),
	CONSTRAINT "row_settlements_valid_run_count" CHECK("row_settlements"."queued_run_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `row_settlements_row_version_unique` ON `row_settlements` (`row_id`,`row_version`);--> statement-breakpoint
CREATE INDEX `row_settlements_workspace_created_idx` ON `row_settlements` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `row_settlements_status_created_idx` ON `row_settlements` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `row_settlements_id_workspace_unique` ON `row_settlements` (`id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `usage_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`provider_units` text,
	`estimated_cost_micros` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`,`workspace_id`) REFERENCES `cell_runs`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_ledger_run_unique` ON `usage_ledger` (`run_id`);--> statement-breakpoint
CREATE INDEX `usage_ledger_workspace_created_idx` ON `usage_ledger` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`destination_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`row_id` text NOT NULL,
	`row_version` integer NOT NULL,
	`trigger_mode` text DEFAULT 'manual' NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`response_status` integer,
	`error_code` text,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`destination_id`,`table_id`,`workspace_id`) REFERENCES `webhook_destinations`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`row_id`,`table_id`,`workspace_id`) REFERENCES `rows`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "webhook_deliveries_valid_state" CHECK("webhook_deliveries"."trigger_mode" in ('manual', 'row_settled') and "webhook_deliveries"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "webhook_deliveries_valid_attempt" CHECK("webhook_deliveries"."attempt" >= 0),
	CONSTRAINT "webhook_deliveries_valid_row_version" CHECK("webhook_deliveries"."row_version" > 0),
	CONSTRAINT "webhook_deliveries_payload_json" CHECK(json_valid("webhook_deliveries"."payload") and json_type("webhook_deliveries"."payload") = 'object'),
	CONSTRAINT "webhook_deliveries_valid_response_status" CHECK("webhook_deliveries"."response_status" is null or "webhook_deliveries"."response_status" between 100 and 599)
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_workspace_created_idx` ON `webhook_deliveries` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_destination_created_idx` ON `webhook_deliveries` (`destination_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_settlement_unique` ON `webhook_deliveries` (`destination_id`,`row_id`,`row_version`) WHERE "webhook_deliveries"."trigger_mode" = 'row_settled';--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_id_workspace_unique` ON `webhook_deliveries` (`id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `webhook_destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`created_by_user_id` text,
	`name` text NOT NULL,
	`endpoint_url` text NOT NULL,
	`signing_credential_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`trigger_mode` text DEFAULT 'manual' NOT NULL,
	`last_delivery_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`table_id`,`workspace_id`) REFERENCES `data_tables`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`signing_credential_id`,`workspace_id`) REFERENCES `credentials`(`id`,`workspace_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "webhook_destinations_valid_state" CHECK("webhook_destinations"."status" in ('active', 'paused') and "webhook_destinations"."trigger_mode" in ('manual', 'row_settled'))
);
--> statement-breakpoint
CREATE INDEX `webhook_destinations_workspace_table_idx` ON `webhook_destinations` (`workspace_id`,`table_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_destinations_id_workspace_unique` ON `webhook_destinations` (`id`,`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_destinations_scope_unique` ON `webhook_destinations` (`id`,`table_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `writeback_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`destination_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`row_id` text NOT NULL,
	`row_version` integer NOT NULL,
	`trigger_mode` text DEFAULT 'manual' NOT NULL,
	`filter_tree_snapshot` text,
	`payload_fingerprint` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`response_status` integer,
	`error_code` text,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`destination_id`,`table_id`,`workspace_id`) REFERENCES `writeback_destinations`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`row_id`,`table_id`,`workspace_id`) REFERENCES `rows`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "writeback_deliveries_valid_state" CHECK("writeback_deliveries"."trigger_mode" in ('manual', 'row_settled') and "writeback_deliveries"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "writeback_deliveries_valid_attempt" CHECK("writeback_deliveries"."attempt" >= 0),
	CONSTRAINT "writeback_deliveries_valid_row_version" CHECK("writeback_deliveries"."row_version" > 0),
	CONSTRAINT "writeback_deliveries_valid_response_status" CHECK("writeback_deliveries"."response_status" is null or "writeback_deliveries"."response_status" between 100 and 599),
	CONSTRAINT "writeback_deliveries_valid_fingerprint" CHECK("writeback_deliveries"."payload_fingerprint" is null or (length("writeback_deliveries"."payload_fingerprint") = 64 and "writeback_deliveries"."payload_fingerprint" not glob '*[^0-9a-f]*')),
	CONSTRAINT "writeback_deliveries_payload_json" CHECK(json_valid("writeback_deliveries"."payload") and json_type("writeback_deliveries"."payload") = 'object'),
	CONSTRAINT "writeback_deliveries_automatic_snapshot" CHECK("writeback_deliveries"."trigger_mode" = 'manual' or ("writeback_deliveries"."payload_fingerprint" is not null and json_valid("writeback_deliveries"."filter_tree_snapshot") and json_type("writeback_deliveries"."filter_tree_snapshot") = 'object'))
);
--> statement-breakpoint
CREATE INDEX `writeback_deliveries_workspace_created_idx` ON `writeback_deliveries` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `writeback_deliveries_destination_created_idx` ON `writeback_deliveries` (`destination_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `writeback_deliveries_settlement_unique` ON `writeback_deliveries` (`destination_id`,`row_id`,`row_version`) WHERE "writeback_deliveries"."trigger_mode" = 'row_settled';--> statement-breakpoint
CREATE UNIQUE INDEX `writeback_deliveries_automatic_payload_unique` ON `writeback_deliveries` (`destination_id`,`row_id`,`payload_fingerprint`) WHERE "writeback_deliveries"."trigger_mode" = 'row_settled';--> statement-breakpoint
CREATE UNIQUE INDEX `writeback_deliveries_id_workspace_unique` ON `writeback_deliveries` (`id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `writeback_destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`created_by_user_id` text,
	`name` text NOT NULL,
	`adapter_id` text DEFAULT 'hubspot_contact' NOT NULL,
	`credential_id` text NOT NULL,
	`record_id_column_id` text NOT NULL,
	`field_mappings` text NOT NULL,
	`filter_tree` text DEFAULT '{"children":[],"combinator":"and"}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`trigger_mode` text DEFAULT 'manual' NOT NULL,
	`last_delivery_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`table_id`,`workspace_id`) REFERENCES `data_tables`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`,`workspace_id`) REFERENCES `credentials`(`id`,`workspace_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`record_id_column_id`,`table_id`,`workspace_id`) REFERENCES `columns`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "writeback_destinations_supported_adapter" CHECK("writeback_destinations"."adapter_id" = 'hubspot_contact'),
	CONSTRAINT "writeback_destinations_json" CHECK(json_valid("writeback_destinations"."field_mappings") and json_type("writeback_destinations"."field_mappings") = 'array' and json_valid("writeback_destinations"."filter_tree") and json_type("writeback_destinations"."filter_tree") = 'object'),
	CONSTRAINT "writeback_destinations_valid_state" CHECK("writeback_destinations"."status" in ('active', 'paused') and "writeback_destinations"."trigger_mode" in ('manual', 'row_settled'))
);
--> statement-breakpoint
CREATE INDEX `writeback_destinations_workspace_table_idx` ON `writeback_destinations` (`workspace_id`,`table_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `writeback_destinations_id_workspace_unique` ON `writeback_destinations` (`id`,`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `writeback_destinations_scope_unique` ON `writeback_destinations` (`id`,`table_id`,`workspace_id`);