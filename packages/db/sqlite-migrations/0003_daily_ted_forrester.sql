CREATE TABLE `column_dependencies` (
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`column_id` text NOT NULL,
	`depends_on_column_id` text NOT NULL,
	PRIMARY KEY(`column_id`, `depends_on_column_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`column_id`,`table_id`,`workspace_id`) REFERENCES `columns`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_column_id`,`table_id`,`workspace_id`) REFERENCES `columns`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "column_dependencies_not_self" CHECK("column_dependencies"."column_id" <> "column_dependencies"."depends_on_column_id")
);
--> statement-breakpoint
CREATE TABLE `connector_revocations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`target` text NOT NULL,
	`target_key` text NOT NULL,
	`reason` text NOT NULL,
	`created_by_user_id` text,
	`lifted_at` integer,
	`lifted_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`lifted_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "connector_revocations_target_json" CHECK(json_valid("connector_revocations"."target") and json_type("connector_revocations"."target") = 'object'),
	CONSTRAINT "connector_revocations_reason_length" CHECK(length("connector_revocations"."reason") between 8 and 500),
	CONSTRAINT "connector_revocations_lift_actor" CHECK("connector_revocations"."lifted_at" is not null or "connector_revocations"."lifted_by_user_id" is null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_revocations_workspace_active_target_unique` ON `connector_revocations` (`workspace_id`,`target_key`) WHERE "connector_revocations"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX `connector_revocations_workspace_created_idx` ON `connector_revocations` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`connector_id` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`revoked_at` integer,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "credentials_encrypted_value_json" CHECK(json_valid("credentials"."encrypted_value") and json_type("credentials"."encrypted_value") = 'object')
);
--> statement-breakpoint
CREATE INDEX `credentials_workspace_connector_idx` ON `credentials` (`workspace_id`,`connector_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_id_workspace_unique` ON `credentials` (`id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`created_by_user_id` text,
	`filename` text NOT NULL,
	`status` text DEFAULT 'staging' NOT NULL,
	`headers` text DEFAULT '[]' NOT NULL,
	`column_mapping` text,
	`uploaded_bytes` integer DEFAULT 0 NOT NULL,
	`staged_row_count` integer DEFAULT 0 NOT NULL,
	`imported_row_count` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`table_id`,`workspace_id`) REFERENCES `data_tables`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "import_jobs_valid_status" CHECK("import_jobs"."status" in ('staging', 'queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "import_jobs_headers_json" CHECK(json_valid("import_jobs"."headers") and json_type("import_jobs"."headers") = 'array'),
	CONSTRAINT "import_jobs_mapping_json" CHECK("import_jobs"."column_mapping" is null or json_valid("import_jobs"."column_mapping")),
	CONSTRAINT "import_jobs_nonnegative_counts" CHECK("import_jobs"."uploaded_bytes" >= 0 and "import_jobs"."staged_row_count" >= 0 and "import_jobs"."imported_row_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `import_jobs_workspace_created_idx` ON `import_jobs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `import_jobs_status_created_idx` ON `import_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `import_jobs_id_workspace_unique` ON `import_jobs` (`id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `import_staged_rows` (
	`import_job_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`row_number` integer NOT NULL,
	`values` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`import_job_id`, `row_number`),
	FOREIGN KEY (`import_job_id`,`workspace_id`) REFERENCES `import_jobs`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "import_staged_rows_positive_number" CHECK("import_staged_rows"."row_number" > 0),
	CONSTRAINT "import_staged_rows_values_json" CHECK(json_valid("import_staged_rows"."values") and json_type("import_staged_rows"."values") = 'array')
);
--> statement-breakpoint
CREATE INDEX `import_staged_rows_workspace_job_idx` ON `import_staged_rows` (`workspace_id`,`import_job_id`,`row_number`);--> statement-breakpoint
CREATE TABLE `schema_lifecycle_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`column_id` text,
	`actor_user_id` text,
	`action` text NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "schema_lifecycle_events_valid_action" CHECK("schema_lifecycle_events"."action" in ('column_archived', 'column_restored', 'column_type_converted', 'table_archived', 'table_restored')),
	CONSTRAINT "schema_lifecycle_events_column_scope" CHECK(("schema_lifecycle_events"."action" like 'column_%' and "schema_lifecycle_events"."column_id" is not null) or ("schema_lifecycle_events"."action" like 'table_%' and "schema_lifecycle_events"."column_id" is null)),
	CONSTRAINT "schema_lifecycle_events_snapshot_json" CHECK(json_valid("schema_lifecycle_events"."snapshot"))
);
--> statement-breakpoint
CREATE INDEX `schema_lifecycle_events_workspace_created_idx` ON `schema_lifecycle_events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `schema_lifecycle_events_resource_created_idx` ON `schema_lifecycle_events` (`table_id`,`column_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspace_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by_user_id` text,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`accepted_by_user_id` text,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`accepted_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "workspace_invitations_no_owner" CHECK("workspace_invitations"."role" <> 'owner'),
	CONSTRAINT "workspace_invitations_token_hash_length" CHECK(length("workspace_invitations"."token_hash") = 64 and "workspace_invitations"."token_hash" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invitations_token_hash_unique` ON `workspace_invitations` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invitations_active_email_unique` ON `workspace_invitations` (`workspace_id`,`email`) WHERE "workspace_invitations"."accepted_at" is null and "workspace_invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX `workspace_invitations_workspace_created_idx` ON `workspace_invitations` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspace_keys` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`wrapped_key` text NOT NULL,
	`key_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspace_purge_holds` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`placed_by` text NOT NULL,
	`placed_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_purge_holds_reason_length" CHECK(length("workspace_purge_holds"."reason") between 8 and 500),
	CONSTRAINT "workspace_purge_holds_actor_length" CHECK(length("workspace_purge_holds"."placed_by") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE `workspace_purge_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_user_id` text,
	`reason` text NOT NULL,
	`preview_digest` text NOT NULL,
	`impact` text NOT NULL,
	`purged_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`analytics_erase_claim_id` text,
	`analytics_erase_claimed_at` integer,
	`analytics_erase_attempts` integer DEFAULT 0 NOT NULL,
	`analytics_erase_next_attempt_at` integer,
	`analytics_erase_last_error` text,
	`analytics_erased_at` integer,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "workspace_purge_receipts_reason" CHECK("workspace_purge_receipts"."reason" in ('duplicate_workspace', 'test_data', 'user_requested', 'other')),
	CONSTRAINT "workspace_purge_receipts_digest" CHECK(length("workspace_purge_receipts"."preview_digest") = 64 and "workspace_purge_receipts"."preview_digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "workspace_purge_receipts_impact_shape" CHECK(json_valid("workspace_purge_receipts"."impact") and json_type("workspace_purge_receipts"."impact") = 'object'),
	CONSTRAINT "workspace_purge_receipts_analytics_state" CHECK("workspace_purge_receipts"."analytics_erase_attempts" >= 0 and (("workspace_purge_receipts"."analytics_erase_claim_id" is null and "workspace_purge_receipts"."analytics_erase_claimed_at" is null) or ("workspace_purge_receipts"."analytics_erase_claim_id" is not null and "workspace_purge_receipts"."analytics_erase_claimed_at" is not null)) and ("workspace_purge_receipts"."analytics_erase_last_error" is null or length("workspace_purge_receipts"."analytics_erase_last_error") <= 500))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_purge_receipts_workspace_unique` ON `workspace_purge_receipts` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `workspace_purge_receipts_purged_at_idx` ON `workspace_purge_receipts` (`purged_at`);--> statement-breakpoint
CREATE INDEX `workspace_purge_receipts_analytics_erase_idx` ON `workspace_purge_receipts` (`analytics_erased_at`,`analytics_erase_next_attempt_at`,`purged_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`value_type` text NOT NULL,
	`position` text NOT NULL,
	`configuration` text DEFAULT '{}' NOT NULL,
	`archived_at` integer,
	`archived_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`archived_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`table_id`,`workspace_id`) REFERENCES `data_tables`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "columns_valid_kind" CHECK("__new_columns"."kind" in ('input', 'formula', 'connector', 'function')),
	CONSTRAINT "columns_valid_value_type" CHECK("__new_columns"."value_type" in ('empty', 'text', 'number', 'boolean', 'timestamp', 'json')),
	CONSTRAINT "columns_configuration_json" CHECK(json_valid("__new_columns"."configuration"))
);
--> statement-breakpoint
INSERT INTO `__new_columns`("id", "workspace_id", "table_id", "name", "kind", "value_type", "position", "configuration", "archived_at", "archived_by_user_id", "created_at", "updated_at") SELECT "id", "workspace_id", "table_id", "name", "kind", "value_type", "position", "configuration", "archived_at", "archived_by_user_id", "created_at", "updated_at" FROM `columns`;--> statement-breakpoint
DROP TABLE `columns`;--> statement-breakpoint
ALTER TABLE `__new_columns` RENAME TO `columns`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `columns_table_position_idx` ON `columns` (`table_id`,`position`);--> statement-breakpoint
CREATE INDEX `columns_table_archived_position_idx` ON `columns` (`table_id`,`archived_at`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `columns_table_name_unique` ON `columns` (`table_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `columns_id_table_workspace_unique` ON `columns` (`id`,`table_id`,`workspace_id`);