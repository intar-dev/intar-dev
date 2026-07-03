CREATE TABLE `image_build_bundles` (
	`rev` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`kino_version` text NOT NULL,
	`meta_json` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `image_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`scenario_id` text NOT NULL,
	`arch` text NOT NULL,
	`rev` text NOT NULL,
	`content_hash` text NOT NULL,
	`kino_version` text NOT NULL,
	`host_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`phase` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`error` text,
	`log_r2_key` text,
	`timings_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`rev`) REFERENCES `image_build_bundles`(`rev`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_builds_scenario_arch_hash_uidx` ON `image_builds` (`scenario_id`,`arch`,`content_hash`);--> statement-breakpoint
CREATE INDEX `image_builds_status_idx` ON `image_builds` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `image_builds_host_idx` ON `image_builds` (`host_id`,`status`);--> statement-breakpoint
CREATE INDEX `image_builds_rev_idx` ON `image_builds` (`rev`);--> statement-breakpoint
ALTER TABLE `agent_hosts` ADD `role` text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
CREATE INDEX `agent_hosts_role_idx` ON `agent_hosts` (`role`,`connected`);