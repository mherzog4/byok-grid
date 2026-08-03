CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`workflow_version` integer NOT NULL,
	`graph_digest` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`requested_by_user_id` text,
	`input` text DEFAULT '{}' NOT NULL,
	`error_code` text,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workflow_id`,`workflow_version`,`workspace_id`) REFERENCES `workflow_versions`(`workflow_id`,`version`,`workspace_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "workflow_runs_valid_status" CHECK("workflow_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "workflow_runs_positive_version" CHECK("workflow_runs"."workflow_version" >= 1),
	CONSTRAINT "workflow_runs_graph_digest" CHECK(length("workflow_runs"."graph_digest") = 64 and "workflow_runs"."graph_digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "workflow_runs_input_json" CHECK(json_valid("workflow_runs"."input") and json_type("workflow_runs"."input") = 'object'),
	CONSTRAINT "workflow_runs_error_lengths" CHECK(("workflow_runs"."error_code" is null or length("workflow_runs"."error_code") between 1 and 120) and ("workflow_runs"."error_message" is null or length("workflow_runs"."error_message") between 1 and 500))
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_workspace_created_idx` ON `workflow_runs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `workflow_runs_status_updated_idx` ON `workflow_runs` (`status`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_runs_id_workspace_unique` ON `workflow_runs` (`id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `workflow_step_runs` (
	`run_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`step_id` text NOT NULL,
	`step_kind` text NOT NULL,
	`status` text DEFAULT 'blocked' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`claim_id` text,
	`claimed_at` integer,
	`next_attempt_at` integer,
	`input` text,
	`output` text,
	`error_code` text,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`run_id`, `step_id`),
	FOREIGN KEY (`run_id`,`workspace_id`) REFERENCES `workflow_runs`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workflow_step_runs_valid_status" CHECK("workflow_step_runs"."status" in ('blocked', 'ready', 'running', 'succeeded', 'failed', 'skipped', 'cancelled') and "workflow_step_runs"."attempt" >= 0),
	CONSTRAINT "workflow_step_runs_claim_state" CHECK((("workflow_step_runs"."claim_id" is null and "workflow_step_runs"."claimed_at" is null) or ("workflow_step_runs"."claim_id" is not null and "workflow_step_runs"."claimed_at" is not null)) and ("workflow_step_runs"."status" = 'running' or ("workflow_step_runs"."claim_id" is null and "workflow_step_runs"."claimed_at" is null))),
	CONSTRAINT "workflow_step_runs_json" CHECK(("workflow_step_runs"."input" is null or json_valid("workflow_step_runs"."input")) and ("workflow_step_runs"."output" is null or json_valid("workflow_step_runs"."output"))),
	CONSTRAINT "workflow_step_runs_error_lengths" CHECK(("workflow_step_runs"."error_code" is null or length("workflow_step_runs"."error_code") between 1 and 120) and ("workflow_step_runs"."error_message" is null or length("workflow_step_runs"."error_message") between 1 and 500))
);
--> statement-breakpoint
CREATE INDEX `workflow_step_runs_claim_idx` ON `workflow_step_runs` (`status`,`next_attempt_at`,`claimed_at`,`updated_at`);--> statement-breakpoint
CREATE INDEX `workflow_step_runs_workspace_run_idx` ON `workflow_step_runs` (`workspace_id`,`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_step_runs_scope_unique` ON `workflow_step_runs` (`run_id`,`step_id`,`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_versions_execution_scope_unique` ON `workflow_versions` (`workflow_id`,`version`,`workspace_id`);