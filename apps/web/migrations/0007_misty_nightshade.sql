ALTER TABLE `access_events` ADD `run_id` text;--> statement-breakpoint
CREATE INDEX `access_events_run_idx` ON `access_events` (`run_id`,`created_at`);