CREATE TABLE `runtime_operation_gates` (
	`key` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scenario_catalog_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`organization_id` text,
	`scenario_id` text NOT NULL,
	`build_id` text NOT NULL,
	`manifest_json` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scenario_catalog_candidates_revision_idx` ON `scenario_catalog_candidates` (`revision`);--> statement-breakpoint
CREATE TABLE `scenario_catalog_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`organization_id` text,
	`snapshot_json` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scenario_catalog_snapshots_created_idx` ON `scenario_catalog_snapshots` (`created_at`);--> statement-breakpoint
ALTER TABLE `image_builds` ADD `catalog_channel` text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE `image_builds` ADD `published_manifest_json` text;--> statement-breakpoint
ALTER TABLE `image_builds` DROP COLUMN `kino_version`;--> statement-breakpoint
ALTER TABLE `vm_scenario_vms` ADD `chunk_manifest_sha256` text;--> statement-breakpoint
ALTER TABLE `vm_scenario_vms` ADD `guest_bootstrap_abi` integer;--> statement-breakpoint
ALTER TABLE `vm_scenarios` ADD `source_revision` text;--> statement-breakpoint
ALTER TABLE `image_build_bundles` DROP COLUMN `kino_version`;