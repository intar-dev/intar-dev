UPDATE `vm_scenarios`
SET `enabled` = false,
    `enabled_at` = NULL,
    `updated_at` = cast(unixepoch('subsecond') * 1000 as integer);--> statement-breakpoint
CREATE TABLE `course_unit_completions` (
	`user_id` text NOT NULL,
	`scope_key` text NOT NULL,
	`course_id` text NOT NULL,
	`lecture_id` text NOT NULL,
	`source_run_id` text,
	`completed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_run_id`) REFERENCES `scenario_runs`(`run_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_unit_completions_unit_uidx` ON `course_unit_completions` (`user_id`,`scope_key`,`course_id`,`lecture_id`);--> statement-breakpoint
CREATE INDEX `course_unit_completions_scope_course_idx` ON `course_unit_completions` (`scope_key`,`course_id`,`lecture_id`);--> statement-breakpoint
CREATE TABLE `course_catalogs` (
	`scope_key` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`catalog_json` text NOT NULL,
	`source_revision` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "course_catalogs_scope_check" CHECK(("course_catalogs"."scope_key" = 'public' AND "course_catalogs"."organization_id" IS NULL) OR ("course_catalogs"."scope_key" = 'organization:' || "course_catalogs"."organization_id" AND "course_catalogs"."organization_id" IS NOT NULL)),
	CONSTRAINT "course_catalogs_catalog_json_check" CHECK(json_valid("course_catalogs"."catalog_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `course_catalogs_organization_uidx` ON `course_catalogs` (`organization_id`);--> statement-breakpoint
DROP TABLE `scenario_course_catalogs`;--> statement-breakpoint
DROP TABLE `scenario_sources`;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `course_scope_key` text;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `course_id` text;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `course_title` text;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `lecture_id` text;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `lecture_title` text;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `lecture_summary` text;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `lecture_body_markdown` text;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `lecture_ordinal` integer;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `lecture_count` integer;--> statement-breakpoint
CREATE INDEX `scenario_runs_course_unit_idx` ON `scenario_runs` (`user_id`,`course_scope_key`,`course_id`,`lecture_id`,`created_at`);
