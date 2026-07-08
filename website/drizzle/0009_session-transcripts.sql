CREATE TABLE `scenario_run_session_transcripts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`vm_id` text NOT NULL,
	`session_index` integer NOT NULL,
	`transcript` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `scenario_runs`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_run_session_transcripts_session_uidx` ON `scenario_run_session_transcripts` (`run_id`,`vm_id`,`session_index`);