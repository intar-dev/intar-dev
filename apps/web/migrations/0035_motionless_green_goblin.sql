CREATE TABLE `scenario_source_commits` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_key` text NOT NULL,
	`purpose` text NOT NULL,
	`sha` text NOT NULL,
	`rev` text NOT NULL,
	`via` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`detail` text,
	`diagnostics_json` text,
	`compile_host_id` text,
	`compile_assigned_at` integer,
	`check_run_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`scope_key`) REFERENCES `scenario_sources`(`scope_key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`compile_host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "scenario_source_commits_purpose_check" CHECK("scenario_source_commits"."purpose" IN ('deploy', 'validate')),
	CONSTRAINT "scenario_source_commits_via_check" CHECK("scenario_source_commits"."via" IN ('push', 'pull')),
	CONSTRAINT "scenario_source_commits_state_check" CHECK("scenario_source_commits"."state" IN ('fetching', 'compiling', 'ingesting', 'building', 'waiting', 'promoting', 'awaiting_promote', 'live', 'failed', 'invalid', 'superseded', 'validated'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_source_commits_scope_rev_purpose_uidx` ON `scenario_source_commits` (`scope_key`,`rev`,`purpose`);--> statement-breakpoint
CREATE INDEX `scenario_source_commits_state_updated_idx` ON `scenario_source_commits` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `scenario_sources` (
	`scope_key` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`github_installation_id` integer NOT NULL,
	`github_repository_id` integer NOT NULL,
	`github_repository` text NOT NULL,
	`default_branch` text NOT NULL,
	`mode` text DEFAULT 'pull' NOT NULL,
	`head_sha` text,
	`head_observed_at` integer DEFAULT 0 NOT NULL,
	`poked_at` integer,
	`polled_at` integer,
	`target_rev` text,
	`live_rev` text,
	`live_sha` text,
	`live_at` integer,
	`paused_at` integer,
	`pause_reason` text,
	`disconnected_at` integer,
	`disconnect_reason` text,
	`bound_by_user_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bound_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "scenario_sources_scope_check" CHECK(("scenario_sources"."scope_key" = 'public' AND "scenario_sources"."organization_id" IS NULL) OR ("scenario_sources"."scope_key" = 'organization:' || "scenario_sources"."organization_id" AND "scenario_sources"."organization_id" IS NOT NULL)),
	CONSTRAINT "scenario_sources_mode_check" CHECK("scenario_sources"."mode" IN ('push', 'pull')),
	CONSTRAINT "scenario_sources_pause_reason_check" CHECK("scenario_sources"."pause_reason" IN ('admin', 'binder_lost_admin', 'suspended'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_sources_organization_uidx` ON `scenario_sources` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_sources_connected_repository_uidx` ON `scenario_sources` (`github_repository_id`) WHERE "scenario_sources"."disconnected_at" IS NULL;