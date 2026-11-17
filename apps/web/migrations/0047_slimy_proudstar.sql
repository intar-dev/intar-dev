ALTER TABLE `scenario_revisions` ADD `restore_verified_at` integer;--> statement-breakpoint
ALTER TABLE `scenario_revisions` ADD `restore_verify_run_id` text;--> statement-breakpoint
ALTER TABLE `scenario_revisions` ADD `restore_verify_report_json` text;