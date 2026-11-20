CREATE TABLE `scenario_revision_holds` (
	`scenario_id` text NOT NULL,
	`behaviour_digest` text NOT NULL,
	`held_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`held_by_user_id` text,
	`lifted_at` integer,
	`lifted_by_user_id` text,
	PRIMARY KEY(`scenario_id`, `behaviour_digest`),
	FOREIGN KEY (`scenario_id`) REFERENCES `scenarios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `scenario_revisions` ADD `behaviour_digest` text;--> statement-breakpoint
ALTER TABLE `scenario_revisions` ADD `restore_basis` text;--> statement-breakpoint
ALTER TABLE `scenario_revisions` ADD `restore_digest` text;--> statement-breakpoint
CREATE INDEX `scenario_revisions_behaviour_idx` ON `scenario_revisions` (`scenario_id`,`behaviour_digest`);--> statement-breakpoint
ALTER TABLE `scenario_sources` ADD `promotion` text DEFAULT 'manual' NOT NULL;