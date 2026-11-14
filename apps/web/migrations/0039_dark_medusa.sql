CREATE TABLE `bundles` (
	`rev` text PRIMARY KEY NOT NULL,
	`scope_key` text NOT NULL,
	`organization_id` text,
	`compiler_version` text NOT NULL,
	`r2_key` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `bundles_organization_idx` ON `bundles` (`organization_id`);--> statement-breakpoint
CREATE TABLE `machine_builds` (
	`build_key` text PRIMARY KEY NOT NULL,
	`image_format` text NOT NULL,
	`bundle_rev` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`image_digest` text,
	`attempt` integer DEFAULT 0 NOT NULL,
	`host_id` text,
	`log_key` text,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "machine_builds_state_check" CHECK("machine_builds"."state" IN ('queued', 'assigned', 'building', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `machine_builds_state_idx` ON `machine_builds` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `organization_entitlements` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`public_play_granted_at` integer,
	`granted_by` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `registry_manifest_blobs` (
	`manifest_digest` text NOT NULL,
	`blob_digest` text NOT NULL,
	PRIMARY KEY(`manifest_digest`, `blob_digest`),
	FOREIGN KEY (`manifest_digest`) REFERENCES `registry_manifests`(`digest`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `registry_manifests` (
	`digest` text PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`artifact_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scenario_revisions` (
	`scenario_id` text NOT NULL,
	`rev` text NOT NULL,
	`guest_contract` integer NOT NULL,
	`doc_json` text NOT NULL,
	`content_digest` text,
	`state` text NOT NULL,
	`verify_run_id` text,
	`verify_report_json` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`scenario_id`, `rev`),
	FOREIGN KEY (`scenario_id`) REFERENCES `scenarios`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "scenario_revisions_state_check" CHECK("scenario_revisions"."state" IN ('building', 'ready', 'verified', 'failed')),
	CONSTRAINT "scenario_revisions_doc_json_check" CHECK(json_valid("scenario_revisions"."doc_json"))
);
--> statement-breakpoint
CREATE TABLE `scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`slug` text NOT NULL,
	`organization_id` text,
	`scope_key` text NOT NULL,
	`enabled` integer NOT NULL,
	`play` integer NOT NULL,
	`live_rev` text,
	`candidate_rev` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "scenarios_id_check" CHECK("scenarios"."id" = "scenarios"."namespace" || '/' || "scenarios"."slug")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenarios_namespace_slug_uidx` ON `scenarios` (`namespace`,`slug`);--> statement-breakpoint
CREATE INDEX `scenarios_organization_idx` ON `scenarios` (`organization_id`);--> statement-breakpoint
ALTER TABLE `agent_hosts` ADD `last_refusal_code` text;--> statement-breakpoint
ALTER TABLE `agent_hosts` ADD `last_refusal_at` integer;--> statement-breakpoint
ALTER TABLE `agent_hosts` ADD `last_refused_agent_version` text;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `scenario_rev` text;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `tasks_json` text;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `launch_source` text;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `ref` text;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `end_reason` text;