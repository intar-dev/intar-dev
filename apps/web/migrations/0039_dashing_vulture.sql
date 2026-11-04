CREATE TABLE `learner_run_starts` (
	`run_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `learner_run_starts_user_idx` ON `learner_run_starts` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `launch_source` text;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `ref` text;