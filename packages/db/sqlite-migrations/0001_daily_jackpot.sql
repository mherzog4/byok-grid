CREATE TABLE `workflow_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`version` integer NOT NULL,
	`graph` text NOT NULL,
	`graph_digest` text NOT NULL,
	`created_by_user_id` text,
	`published_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workflow_id`,`workspace_id`) REFERENCES `workflows`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workflow_versions_positive" CHECK("workflow_versions"."version" >= 1),
	CONSTRAINT "workflow_versions_graph_json" CHECK(json_valid("workflow_versions"."graph")),
	CONSTRAINT "workflow_versions_digest" CHECK(length("workflow_versions"."graph_digest") = 64 and "workflow_versions"."graph_digest" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_versions_workflow_version_unique` ON `workflow_versions` (`workflow_id`,`version`);--> statement-breakpoint
CREATE INDEX `workflow_versions_workspace_published_idx` ON `workflow_versions` (`workspace_id`,`published_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_versions_id_scope_unique` ON `workflow_versions` (`id`,`workflow_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`draft_graph` text NOT NULL,
	`draft_digest` text NOT NULL,
	`published_version` integer,
	`draft_revision` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "workflows_valid_state" CHECK("workflows"."state" in ('draft', 'active', 'paused')),
	CONSTRAINT "workflows_positive_revision" CHECK("workflows"."draft_revision" >= 1),
	CONSTRAINT "workflows_draft_graph_json" CHECK(json_valid("workflows"."draft_graph")),
	CONSTRAINT "workflows_draft_digest" CHECK(length("workflows"."draft_digest") = 64 and "workflows"."draft_digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "workflows_published_state" CHECK(("workflows"."state" = 'draft' and "workflows"."published_version" is null) or ("workflows"."state" <> 'draft' and "workflows"."published_version" >= 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_workspace_name_unique` ON `workflows` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `workflows_workspace_updated_idx` ON `workflows` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_id_workspace_unique` ON `workflows` (`id`,`workspace_id`);
