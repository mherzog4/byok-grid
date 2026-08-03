PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflows` (
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
	CONSTRAINT "workflows_valid_state" CHECK("__new_workflows"."state" in ('draft', 'active', 'paused')),
	CONSTRAINT "workflows_positive_revision" CHECK("__new_workflows"."draft_revision" >= 1),
	CONSTRAINT "workflows_draft_graph_json" CHECK(json_valid("__new_workflows"."draft_graph")),
	CONSTRAINT "workflows_draft_digest" CHECK(length("__new_workflows"."draft_digest") = 64 and "__new_workflows"."draft_digest" not glob '*[^0-9a-f]*'),
	CONSTRAINT "workflows_published_state" CHECK(("__new_workflows"."state" = 'draft' and "__new_workflows"."published_version" is null) or ("__new_workflows"."state" <> 'draft' and "__new_workflows"."published_version" >= 1))
);
--> statement-breakpoint
INSERT INTO `__new_workflows`("id", "workspace_id", "name", "state", "draft_graph", "draft_digest", "published_version", "draft_revision", "created_by_user_id", "created_at", "updated_at") SELECT "id", "workspace_id", "name", "state", "draft_graph", "draft_digest", "published_version", "draft_revision", "created_by_user_id", "created_at", "updated_at" FROM `workflows`;--> statement-breakpoint
DROP TABLE `workflows`;--> statement-breakpoint
ALTER TABLE `__new_workflows` RENAME TO `workflows`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_workspace_name_unique` ON `workflows` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `workflows_workspace_updated_idx` ON `workflows` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_id_workspace_unique` ON `workflows` (`id`,`workspace_id`);