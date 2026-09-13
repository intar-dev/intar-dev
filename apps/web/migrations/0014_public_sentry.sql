DROP TABLE `runtime_allocation_locks`;--> statement-breakpoint
ALTER TABLE `runtime_vms` ADD `terminal_attached_at` integer;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `request_idempotency_key` text;--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD `request_scope_json` text;--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_runs_request_idempotency_uidx` ON `scenario_runs` (`user_id`,`request_idempotency_key`);