CREATE TABLE `scenario_course_catalogs` (
	`scope_key` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`courses_json` text NOT NULL,
	`source_revision` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `scenario_course_catalogs_scope_check` CHECK (
		(`scope_key` = 'public' AND `organization_id` IS NULL)
		OR (`scope_key` = 'organization:' || `organization_id` AND `organization_id` IS NOT NULL)
	),
	CONSTRAINT `scenario_course_catalogs_courses_json_check` CHECK (json_valid(`courses_json`))
);
CREATE UNIQUE INDEX `scenario_course_catalogs_organization_uidx`
	ON `scenario_course_catalogs` (`organization_id`);
