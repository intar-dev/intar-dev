CREATE TABLE `image_registry_admission` (
	`key` text PRIMARY KEY NOT NULL,
	`protocol_version` integer NOT NULL,
	`enforcement` text DEFAULT 'report_only' NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`sweep_token` text,
	`sweep_owner` text,
	`sweep_started_at` integer,
	`sweep_heartbeat_at` integer,
	`sweep_expires_at` integer,
	`pause_reason` text,
	`paused_at` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `image_registry_gc_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`sweep_token` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`started_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL,
	`finished_at` integer,
	`scanned_objects` integer DEFAULT 0 NOT NULL,
	`deleted_objects` integer DEFAULT 0 NOT NULL,
	`blocked_objects` integer DEFAULT 0 NOT NULL,
	`bytes_reclaimed` integer DEFAULT 0 NOT NULL,
	`error` text,
	`detail_json` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_registry_gc_runs_sweep_uidx` ON `image_registry_gc_runs` (`sweep_token`);--> statement-breakpoint
CREATE INDEX `image_registry_gc_runs_state_idx` ON `image_registry_gc_runs` (`state`,`started_at`);--> statement-breakpoint
CREATE TABLE `image_registry_operation_writers` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`operation` text NOT NULL,
	`epoch` integer NOT NULL,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`released_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `image_registry_upload_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `image_registry_operation_writers_open_idx` ON `image_registry_operation_writers` (`released_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `image_registry_operation_writers_session_idx` ON `image_registry_operation_writers` (`session_id`);--> statement-breakpoint
CREATE INDEX `image_registry_operation_writers_operation_idx` ON `image_registry_operation_writers` (`operation`,`created_at`);--> statement-breakpoint
CREATE TABLE `image_registry_upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`intent` text,
	`epoch` integer NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`closed_at` integer,
	`close_reason` text
);
--> statement-breakpoint
CREATE INDEX `image_registry_upload_sessions_state_idx` ON `image_registry_upload_sessions` (`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `image_registry_upload_sessions_owner_idx` ON `image_registry_upload_sessions` (`owner_kind`,`owner_id`,`state`);--> statement-breakpoint
ALTER TABLE `image_builds` ADD `artifacts_retired_at` integer;