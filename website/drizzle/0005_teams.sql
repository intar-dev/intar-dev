CREATE TABLE `scenario_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`scenario_id` text NOT NULL,
	`assigned_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_assignments_org_scenario_uidx` ON `scenario_assignments` (`organization_id`,`scenario_id`);--> statement-breakpoint
CREATE TABLE `team_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`github_username` text NOT NULL,
	`invited_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`accepted_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_invites_org_username_uidx` ON `team_invites` (`organization_id`,`github_username`);--> statement-breakpoint
CREATE INDEX `team_invites_username_idx` ON `team_invites` (`github_username`,`status`);