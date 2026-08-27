DROP INDEX `scenario_runs_admin_archive_page_idx`;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `archive_entered_at` integer;--> statement-breakpoint
UPDATE `scenario_runs`
SET `archive_entered_at` = coalesce(
  `delete_requested_at`,
  `failed_at`,
  `completed_at`,
  `updated_at`,
  `created_at`
)
WHERE `archive_entered_at` IS NULL
  AND `state` IN ('archiving', 'completed', 'failed');--> statement-breakpoint
CREATE INDEX `scenario_runs_admin_archive_page_idx`
ON `scenario_runs` (coalesce(`archive_entered_at`, `created_at`), `run_id`)
WHERE `hidden_at` IS NULL
  AND `state` IN ('archiving', 'completed', 'failed');
