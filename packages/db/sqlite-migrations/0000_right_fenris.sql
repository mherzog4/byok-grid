CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `accounts_user_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_provider_account_unique` ON `accounts` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `cells` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`row_id` text NOT NULL,
	`column_id` text NOT NULL,
	`value_type` text DEFAULT 'empty' NOT NULL,
	`value_text` text,
	`value_number` real,
	`value_boolean` integer,
	`value_timestamp` integer,
	`value_json` text,
	`search_text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`,`workspace_id`) REFERENCES `data_tables`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`row_id`,`table_id`,`workspace_id`) REFERENCES `rows`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`column_id`,`table_id`,`workspace_id`) REFERENCES `columns`(`id`,`table_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cells_valid_value_type" CHECK("cells"."value_type" in ('empty', 'text', 'number', 'boolean', 'timestamp', 'json')),
	CONSTRAINT "cells_valid_status" CHECK("cells"."status" in ('idle', 'stale', 'queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "cells_positive_version" CHECK("cells"."version" >= 1),
	CONSTRAINT "cells_search_text_bound" CHECK(length("cells"."search_text") <= 8192)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cells_row_column_unique` ON `cells` (`row_id`,`column_id`);--> statement-breakpoint
CREATE INDEX `cells_text_sort_idx` ON `cells` (`column_id`,`value_text`,`row_id`);--> statement-breakpoint
CREATE INDEX `cells_number_sort_idx` ON `cells` (`column_id`,`value_number`,`row_id`);--> statement-breakpoint
CREATE INDEX `cells_timestamp_sort_idx` ON `cells` (`column_id`,`value_timestamp`,`row_id`);--> statement-breakpoint
CREATE INDEX `cells_boolean_sort_idx` ON `cells` (`column_id`,`value_boolean`,`row_id`);--> statement-breakpoint
CREATE INDEX `cells_status_filter_idx` ON `cells` (`column_id`,`status`,`row_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cells_id_workspace_unique` ON `cells` (`id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `columns` (
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
	CONSTRAINT "columns_valid_kind" CHECK("columns"."kind" in ('input', 'formula', 'connector', 'function')),
	CONSTRAINT "columns_valid_value_type" CHECK("columns"."value_type" in ('empty', 'text', 'number', 'boolean', 'timestamp', 'json')),
	CONSTRAINT "columns_configuration_json" CHECK(json_valid("columns"."configuration"))
);
--> statement-breakpoint
CREATE INDEX `columns_table_position_idx` ON `columns` (`table_id`,`position`);--> statement-breakpoint
CREATE INDEX `columns_table_archived_position_idx` ON `columns` (`table_id`,`archived_at`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `columns_table_name_unique` ON `columns` (`table_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `columns_id_table_workspace_unique` ON `columns` (`id`,`table_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `data_tables` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`archived_at` integer,
	`archived_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`archived_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `data_tables_workspace_idx` ON `data_tables` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `data_tables_workspace_archived_idx` ON `data_tables` (`workspace_id`,`archived_at`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `data_tables_id_workspace_unique` ON `data_tables` (`id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limits_key_unique` ON `rate_limits` (`key`);--> statement-breakpoint
CREATE TABLE `rows` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`position` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`archived_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`,`workspace_id`) REFERENCES `data_tables`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "rows_positive_version" CHECK("rows"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `rows_table_archived_position_idx` ON `rows` (`table_id`,`archived_at`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `rows_id_table_workspace_unique` ON `rows` (`id`,`table_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `saved_grid_views` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`table_id` text NOT NULL,
	`name` text NOT NULL,
	`filters` text DEFAULT '{"children":[],"combinator":"and"}' NOT NULL,
	`sort` text,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`table_id`,`workspace_id`) REFERENCES `data_tables`(`id`,`workspace_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "saved_grid_views_filters_json" CHECK(json_valid("saved_grid_views"."filters")),
	CONSTRAINT "saved_grid_views_name_length" CHECK(length("saved_grid_views"."name") between 1 and 80)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_grid_views_table_name_unique` ON `saved_grid_views` (`table_id`,`name`);--> statement-breakpoint
CREATE INDEX `saved_grid_views_workspace_table_created_idx` ON `saved_grid_views` (`workspace_id`,`table_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `saved_grid_views_id_table_workspace_unique` ON `saved_grid_views` (`id`,`table_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_members_valid_role" CHECK("workspace_members"."role" in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `cells_search_fts` USING fts5(
	`search_text`,
	content='cells',
	content_rowid='rowid',
	tokenize='trigram'
);
--> statement-breakpoint
CREATE TRIGGER `cells_search_insert`
AFTER INSERT ON `cells`
BEGIN
	UPDATE `cells`
	SET `search_text` = substr(
		CASE NEW.`value_type`
			WHEN 'text' THEN coalesce(NEW.`value_text`, '')
			WHEN 'number' THEN coalesce(cast(NEW.`value_number` AS text), '')
			WHEN 'boolean' THEN CASE
				WHEN NEW.`value_boolean` = 1 THEN 'true'
				WHEN NEW.`value_boolean` = 0 THEN 'false'
				ELSE ''
			END
			WHEN 'timestamp' THEN coalesce(
				strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`value_timestamp` / 1000.0, 'unixepoch'),
				''
			)
			WHEN 'json' THEN coalesce(NEW.`value_json`, '')
			ELSE ''
		END,
		1,
		8192
	)
	WHERE rowid = NEW.rowid;

	INSERT INTO `cells_search_fts`(rowid, `search_text`)
	SELECT rowid, `search_text` FROM `cells` WHERE rowid = NEW.rowid;
END;
--> statement-breakpoint
CREATE TRIGGER `cells_search_update`
AFTER UPDATE OF `value_type`, `value_text`, `value_number`, `value_boolean`, `value_timestamp`, `value_json` ON `cells`
BEGIN
	INSERT INTO `cells_search_fts`(`cells_search_fts`, rowid, `search_text`)
	VALUES ('delete', OLD.rowid, OLD.`search_text`);

	UPDATE `cells`
	SET `search_text` = substr(
		CASE NEW.`value_type`
			WHEN 'text' THEN coalesce(NEW.`value_text`, '')
			WHEN 'number' THEN coalesce(cast(NEW.`value_number` AS text), '')
			WHEN 'boolean' THEN CASE
				WHEN NEW.`value_boolean` = 1 THEN 'true'
				WHEN NEW.`value_boolean` = 0 THEN 'false'
				ELSE ''
			END
			WHEN 'timestamp' THEN coalesce(
				strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`value_timestamp` / 1000.0, 'unixepoch'),
				''
			)
			WHEN 'json' THEN coalesce(NEW.`value_json`, '')
			ELSE ''
		END,
		1,
		8192
	)
	WHERE rowid = NEW.rowid;

	INSERT INTO `cells_search_fts`(rowid, `search_text`)
	SELECT rowid, `search_text` FROM `cells` WHERE rowid = NEW.rowid;
END;
--> statement-breakpoint
CREATE TRIGGER `cells_search_delete`
AFTER DELETE ON `cells`
BEGIN
	INSERT INTO `cells_search_fts`(`cells_search_fts`, rowid, `search_text`)
	VALUES ('delete', OLD.rowid, OLD.`search_text`);
END;
