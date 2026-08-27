CREATE INDEX `scenario_runs_admin_archive_page_idx`
ON `scenario_runs` (coalesce(`delete_requested_at`, `created_at`), `run_id`)
WHERE `hidden_at` IS NULL
  AND `state` IN ('archiving', 'completed', 'failed');
