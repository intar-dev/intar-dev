ALTER TABLE `scenario_runs` ADD `share_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_runs_share_id_uidx` ON `scenario_runs` (`share_id`);