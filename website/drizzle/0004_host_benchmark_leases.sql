CREATE TABLE IF NOT EXISTS `host_benchmark_leases` (
	`host_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`user_id` text NOT NULL,
	`acquired_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `host_benchmark_leases_identity_nonempty` CHECK (length(`host_id`) > 0 AND length(`run_id`) > 0 AND length(`user_id`) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `host_benchmark_leases_run_uidx` ON `host_benchmark_leases` (`run_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `host_benchmark_leases_user_idx` ON `host_benchmark_leases` (`user_id`,`acquired_at`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `host_benchmark_lease_requires_scheduling_disabled`
BEFORE INSERT ON `host_benchmark_leases`
WHEN NOT EXISTS (
	SELECT 1
	FROM `agent_hosts`
	WHERE `id` = NEW.`host_id`
		AND `scenario_enabled` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'benchmark lease requires scenario scheduling to remain disabled');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `host_benchmark_lease_requires_zero_reservations`
BEFORE INSERT ON `host_benchmark_leases`
WHEN EXISTS (
	SELECT 1
	FROM `host_cpu_reservations`
	WHERE `host_id` = NEW.`host_id`
)
BEGIN
	SELECT RAISE(ABORT, 'benchmark lease requires a host with zero CPU reservations');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `host_benchmark_lease_blocks_scenario_enable`
BEFORE UPDATE OF `scenario_enabled` ON `agent_hosts`
WHEN NEW.`scenario_enabled` != 0
	AND EXISTS (
		SELECT 1
		FROM `host_benchmark_leases`
		WHERE `host_id` = NEW.`id`
	)
BEGIN
	SELECT RAISE(ABORT, 'scenario scheduling cannot be enabled while a benchmark lease exists');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `host_benchmark_lease_identity_is_immutable`
BEFORE UPDATE OF `host_id`, `run_id`, `user_id` ON `host_benchmark_leases`
WHEN NEW.`host_id` IS NOT OLD.`host_id`
	OR NEW.`run_id` IS NOT OLD.`run_id`
	OR NEW.`user_id` IS NOT OLD.`user_id`
BEGIN
	SELECT RAISE(ABORT, 'benchmark lease identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `host_benchmark_lease_blocks_cross_run_reservation_insert`
BEFORE INSERT ON `host_cpu_reservations`
WHEN EXISTS (
	SELECT 1
	FROM `host_benchmark_leases`
	WHERE (`host_id` = NEW.`host_id` AND `run_id` != NEW.`run_id`)
		OR (`run_id` = NEW.`run_id` AND `host_id` != NEW.`host_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'CPU reservation conflicts with an exclusive benchmark lease');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `host_benchmark_lease_blocks_cross_run_reservation_update`
BEFORE UPDATE OF `host_id`, `run_id` ON `host_cpu_reservations`
WHEN EXISTS (
	SELECT 1
	FROM `host_benchmark_leases`
	WHERE (`host_id` = NEW.`host_id` AND `run_id` != NEW.`run_id`)
		OR (`run_id` = NEW.`run_id` AND `host_id` != NEW.`host_id`)
)
BEGIN
	SELECT RAISE(ABORT, 'CPU reservation conflicts with an exclusive benchmark lease');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `host_benchmark_lease_freezes_cache_and_build_desired_state`
BEFORE UPDATE OF `doc_json` ON `host_desired_state`
WHEN EXISTS (
	SELECT 1
	FROM `host_benchmark_leases`
	WHERE `host_id` = NEW.`host_id`
)
	AND (
		coalesce(json_extract(OLD.`doc_json`, '$.cached_images'), '[]') IS NOT coalesce(json_extract(NEW.`doc_json`, '$.cached_images'), '[]')
		OR coalesce(json_extract(OLD.`doc_json`, '$.builds'), '[]') IS NOT coalesce(json_extract(NEW.`doc_json`, '$.builds'), '[]')
	)
BEGIN
	SELECT RAISE(ABORT, 'benchmark lease freezes desired image-cache and build work');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `host_benchmark_lease_blocks_foreign_desired_vm`
BEFORE UPDATE OF `doc_json` ON `host_desired_state`
WHEN EXISTS (
	SELECT 1
	FROM `host_benchmark_leases` AS `lease`
	JOIN json_each(NEW.`doc_json`, '$.vms') AS `desired_vm`
	WHERE `lease`.`host_id` = NEW.`host_id`
		AND coalesce(json_extract(`desired_vm`.`value`, '$.desired_phase'), '') = 'running'
		AND coalesce(json_extract(`desired_vm`.`value`, '$.run_id'), '') != `lease`.`run_id`
)
BEGIN
	SELECT RAISE(ABORT, 'benchmark lease blocks foreign desired VMs');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `host_desired_running_vm_requires_active_run_insert`
BEFORE INSERT ON `host_desired_state`
WHEN EXISTS (
	SELECT 1 FROM `agent_hosts`
	WHERE `id` = NEW.`host_id` AND `scenario_enabled` = 0
)
	AND EXISTS (
	SELECT 1
	FROM json_each(NEW.`doc_json`, '$.vms') AS `desired_vm`
	WHERE coalesce(json_extract(`desired_vm`.`value`, '$.desired_phase'), '') = 'running'
		AND NOT EXISTS (
			SELECT 1
			FROM `scenario_runs`
			WHERE `run_id` = coalesce(json_extract(`desired_vm`.`value`, '$.run_id'), '')
				AND `host_id` = NEW.`host_id`
				AND `active_key` IS NOT NULL
				AND `completed_at` IS NULL
				AND `failed_at` IS NULL
		)
)
BEGIN
	SELECT RAISE(ABORT, 'running desired VM requires an active run on the same host');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `host_desired_running_vm_requires_active_run_update`
BEFORE UPDATE OF `doc_json` ON `host_desired_state`
WHEN EXISTS (
	SELECT 1 FROM `agent_hosts`
	WHERE `id` = NEW.`host_id` AND `scenario_enabled` = 0
)
	AND EXISTS (
	SELECT 1
	FROM json_each(NEW.`doc_json`, '$.vms') AS `desired_vm`
	WHERE coalesce(json_extract(`desired_vm`.`value`, '$.desired_phase'), '') = 'running'
		AND NOT EXISTS (
			SELECT 1
			FROM `scenario_runs`
			WHERE `run_id` = coalesce(json_extract(`desired_vm`.`value`, '$.run_id'), '')
				AND `host_id` = NEW.`host_id`
				AND `active_key` IS NOT NULL
				AND `completed_at` IS NULL
				AND `failed_at` IS NULL
		)
)
BEGIN
	SELECT RAISE(ABORT, 'running desired VM requires an active run on the same host');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `host_benchmark_lease_blocks_desired_state_delete`
BEFORE DELETE ON `host_desired_state`
WHEN EXISTS (
	SELECT 1
	FROM `host_benchmark_leases`
	WHERE `host_id` = OLD.`host_id`
)
BEGIN
	SELECT RAISE(ABORT, 'benchmark lease blocks desired-state deletion');
END;
