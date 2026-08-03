PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`version` integer NOT NULL,
	`graph` text NOT NULL,
	`graph_digest` text NOT NULL,
	`compiled_plan` text,
	`created_by_user_id` text,
	`published_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workflow_id`,`workspace_id`) REFERENCES `workflows`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workflow_versions_positive" CHECK("__new_workflow_versions"."version" >= 1),
	CONSTRAINT "workflow_versions_graph_json" CHECK(json_valid("__new_workflow_versions"."graph")),
	CONSTRAINT "workflow_versions_compiled_plan_json" CHECK("__new_workflow_versions"."compiled_plan" is null or (json_valid("__new_workflow_versions"."compiled_plan") and json_type("__new_workflow_versions"."compiled_plan") = 'object')),
	CONSTRAINT "workflow_versions_digest" CHECK(length("__new_workflow_versions"."graph_digest") = 64 and "__new_workflow_versions"."graph_digest" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
INSERT INTO `__new_workflow_versions`("id", "workspace_id", "workflow_id", "version", "graph", "graph_digest", "compiled_plan", "created_by_user_id", "published_at", "created_at") SELECT "id", "workspace_id", "workflow_id", "version", "graph", "graph_digest", NULL, "created_by_user_id", "published_at", "created_at" FROM `workflow_versions`;--> statement-breakpoint
DROP TABLE `workflow_versions`;--> statement-breakpoint
ALTER TABLE `__new_workflow_versions` RENAME TO `workflow_versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_versions_workflow_version_unique` ON `workflow_versions` (`workflow_id`,`version`);--> statement-breakpoint
CREATE INDEX `workflow_versions_workspace_published_idx` ON `workflow_versions` (`workspace_id`,`published_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_versions_id_scope_unique` ON `workflow_versions` (`id`,`workflow_id`,`workspace_id`);
