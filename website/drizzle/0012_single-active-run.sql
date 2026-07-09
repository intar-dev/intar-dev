-- Collapse active_key from "<user_id>:<scenario_id>" to "<user_id>" so the
-- unique index enforces one active run per user across all scenarios.
-- If a user somehow has several active runs, keep only the newest one active;
-- the deactivated runs are cleaned up by the run-lease expiry path.
UPDATE scenario_runs
SET active_key = NULL
WHERE active_key IS NOT NULL
  AND run_id NOT IN (
    SELECT run_id
    FROM (
      SELECT run_id, user_id, MAX(created_at)
      FROM scenario_runs
      WHERE active_key IS NOT NULL
      GROUP BY user_id
    )
  );--> statement-breakpoint
UPDATE scenario_runs
SET active_key = user_id
WHERE active_key IS NOT NULL;
