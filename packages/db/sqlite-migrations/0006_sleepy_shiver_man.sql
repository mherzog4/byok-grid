PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_outbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`published_at` integer,
	`dispatch_claim_id` text,
	`dispatch_claimed_at` integer,
	`dispatch_attempts` integer DEFAULT 0 NOT NULL,
	`dispatch_next_attempt_at` integer,
	`dispatch_last_error` text,
	`analytics_claim_id` text,
	`analytics_claimed_at` integer,
	`analytics_projected_at` integer,
	`analytics_attempts` integer DEFAULT 0 NOT NULL,
	`analytics_next_attempt_at` integer,
	`analytics_last_error` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "outbox_payload_json" CHECK(json_valid("__new_outbox_events"."payload") and json_type("__new_outbox_events"."payload") = 'object'),
	CONSTRAINT "outbox_dispatch_state" CHECK("__new_outbox_events"."dispatch_attempts" >= 0 and (("__new_outbox_events"."dispatch_claim_id" is null and "__new_outbox_events"."dispatch_claimed_at" is null) or ("__new_outbox_events"."dispatch_claim_id" is not null and "__new_outbox_events"."dispatch_claimed_at" is not null)) and ("__new_outbox_events"."dispatch_last_error" is null or length("__new_outbox_events"."dispatch_last_error") <= 500)),
	CONSTRAINT "outbox_analytics_projection_state" CHECK("__new_outbox_events"."analytics_attempts" >= 0 and (("__new_outbox_events"."analytics_claim_id" is null and "__new_outbox_events"."analytics_claimed_at" is null) or ("__new_outbox_events"."analytics_claim_id" is not null and "__new_outbox_events"."analytics_claimed_at" is not null)) and ("__new_outbox_events"."analytics_last_error" is null or length("__new_outbox_events"."analytics_last_error") <= 500))
);
--> statement-breakpoint
INSERT INTO `__new_outbox_events`("id", "workspace_id", "aggregate_type", "aggregate_id", "event_type", "payload", "created_at", "published_at", "dispatch_claim_id", "dispatch_claimed_at", "dispatch_attempts", "dispatch_next_attempt_at", "dispatch_last_error", "analytics_claim_id", "analytics_claimed_at", "analytics_projected_at", "analytics_attempts", "analytics_next_attempt_at", "analytics_last_error") SELECT "id", "workspace_id", "aggregate_type", "aggregate_id", "event_type", "payload", "created_at", "published_at", NULL, NULL, 0, NULL, NULL, "analytics_claim_id", "analytics_claimed_at", "analytics_projected_at", "analytics_attempts", "analytics_next_attempt_at", "analytics_last_error" FROM `outbox_events`;--> statement-breakpoint
DROP TABLE `outbox_events`;--> statement-breakpoint
ALTER TABLE `__new_outbox_events` RENAME TO `outbox_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `outbox_unpublished_idx` ON `outbox_events` (`published_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `outbox_dispatch_idx` ON `outbox_events` (`published_at`,`dispatch_next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `outbox_analytics_projection_idx` ON `outbox_events` (`analytics_projected_at`,`analytics_next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `outbox_workspace_created_idx` ON `outbox_events` (`workspace_id`,`created_at`);
