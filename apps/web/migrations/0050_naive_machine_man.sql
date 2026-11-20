CREATE TABLE `pipeline_upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`scope_key` text NOT NULL,
	`github_repository_id` integer NOT NULL,
	`github_repository` text NOT NULL,
	`ref` text NOT NULL,
	`sha` text NOT NULL,
	`rev` text NOT NULL,
	`run_id` text NOT NULL,
	`run_attempt` integer NOT NULL,
	`runner_environment` text NOT NULL,
	`job_workflow_sha` text NOT NULL,
	`bytes_put` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`scope_key`) REFERENCES `scenario_sources`(`scope_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_upload_sessions_token_hash_uidx` ON `pipeline_upload_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `pipeline_upload_sessions_scope_expires_idx` ON `pipeline_upload_sessions` (`scope_key`,`expires_at`);--> statement-breakpoint
CREATE TABLE `scope_machine_images` (
	`scope_key` text NOT NULL,
	`build_key` text NOT NULL,
	`architecture` text NOT NULL,
	`image_digest` text NOT NULL,
	`image_format` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`github_repository_id` integer NOT NULL,
	`github_repository` text NOT NULL,
	`sha` text NOT NULL,
	`run_id` text NOT NULL,
	`run_attempt` integer NOT NULL,
	`runner_environment` text NOT NULL,
	`job_workflow_sha` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`scope_key`, `build_key`, `architecture`),
	CONSTRAINT "scope_machine_images_architecture_check" CHECK("scope_machine_images"."architecture" IN ('amd64', 'arm64'))
);
--> statement-breakpoint
CREATE INDEX `scope_machine_images_digest_idx` ON `scope_machine_images` (`image_digest`);--> statement-breakpoint
ALTER TABLE `bundles` ADD `image_producer` text DEFAULT 'builder' NOT NULL;--> statement-breakpoint
ALTER TABLE `scenario_sources` ADD `image_producer` text DEFAULT 'builder' NOT NULL;--> statement-breakpoint
ALTER TABLE `scenario_sources` ADD `allow_self_hosted_runners` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `scenario_revisions_rev_idx` ON `scenario_revisions` (`rev`);