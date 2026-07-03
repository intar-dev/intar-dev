DELETE FROM `scenario_run_artifact_uploads`;--> statement-breakpoint
DELETE FROM `scenario_run_artifacts`;--> statement-breakpoint
DELETE FROM `scenario_run_probe_snapshots`;--> statement-breakpoint
DELETE FROM `scenario_run_ssh_keys`;--> statement-breakpoint
DELETE FROM `scenario_runs`;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `tags_json` text NOT NULL DEFAULT '[]';--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `hints_json` text NOT NULL DEFAULT '[]';--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `solution_markdown` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `revealed_hints_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `solution_revealed_at` integer;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `solution_assisted` integer DEFAULT false NOT NULL;
