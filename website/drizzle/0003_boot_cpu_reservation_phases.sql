-- Boot-quota accounting is a breaking V2-only cutover. An old reservation
-- cannot be classified safely after the fact, so require the operator to
-- disable agent placement and fully drain control-plane, desired, and actual
-- workload state before replacing the ledger schema.
CREATE TABLE IF NOT EXISTS `_intar_boot_cpu_cutover_guard` (
	`ok` integer NOT NULL,
	CONSTRAINT `_intar_boot_cpu_cutover_guard_drained` CHECK (`ok` = 1)
);
--> statement-breakpoint
DELETE FROM `_intar_boot_cpu_cutover_guard`;
--> statement-breakpoint
INSERT INTO `_intar_boot_cpu_cutover_guard` (`ok`)
SELECT CASE WHEN
		EXISTS (
			SELECT 1 FROM `agent_hosts`
			WHERE `role` = 'agent' AND `scenario_enabled` != 0
		)
		OR EXISTS (SELECT 1 FROM `agent_hosts` WHERE `connected` != 0)
		OR EXISTS (SELECT 1 FROM `host_cpu_reservations`)
		OR EXISTS (SELECT 1 FROM `scenario_runs` WHERE `active_key` IS NOT NULL)
		OR EXISTS (
			SELECT 1 FROM `image_builds`
			WHERE `status` IN ('queued', 'assigned', 'building')
		)
		OR EXISTS (
			SELECT 1 FROM `host_desired_state`
			WHERE json_valid(`doc_json`) != 1
				OR coalesce(json_type(`doc_json`, '$.vms'), 'missing') != 'array'
				OR coalesce(json_type(`doc_json`, '$.builds'), 'missing') != 'array'
				OR json_array_length(`doc_json`, '$.builds') != 0
		)
		OR EXISTS (
			SELECT 1
			FROM `host_desired_state`, json_each(`doc_json`, '$.vms') AS `desired_vm`
			WHERE coalesce(json_extract(`desired_vm`.`value`, '$.desired_phase'), '') != 'absent'
		)
		OR EXISTS (
			SELECT 1 FROM `host_actual_state`
			WHERE json_valid(`report_json`) != 1
				OR coalesce(json_type(`report_json`, '$.vms'), 'missing') != 'array'
				OR json_array_length(`report_json`, '$.vms') != 0
				OR coalesce(json_type(`report_json`, '$.builds'), 'missing') != 'array'
				OR json_array_length(`report_json`, '$.builds') != 0
		)
THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `_intar_boot_cpu_cutover_guard`;
--> statement-breakpoint
DROP INDEX `host_cpu_reservations_host_state_idx`;
--> statement-breakpoint
DROP INDEX `host_cpu_reservations_pending_expiry_idx`;
--> statement-breakpoint
ALTER TABLE `host_cpu_reservations` RENAME TO `_host_cpu_reservations_v6`;
--> statement-breakpoint
CREATE TABLE `host_cpu_reservations` (
	`run_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`cpu_millis` integer NOT NULL,
	`steady_cpu_millis` integer NOT NULL,
	`boot_cpu_millis` integer NOT NULL,
	`quota_phase` text NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `host_cpu_reservations_cpu_positive` CHECK (`cpu_millis` > 0),
	CONSTRAINT `host_cpu_reservations_quota_positive` CHECK (`steady_cpu_millis` > 0 AND `boot_cpu_millis` >= `steady_cpu_millis`),
	CONSTRAINT `host_cpu_reservations_quota_phase_valid` CHECK (`quota_phase` in ('boot', 'steady')),
	CONSTRAINT `host_cpu_reservations_current_quota_valid` CHECK ((`quota_phase` = 'boot' AND `cpu_millis` = `boot_cpu_millis`) OR (`quota_phase` = 'steady' AND `cpu_millis` = `steady_cpu_millis`)),
	CONSTRAINT `host_cpu_reservations_state_valid` CHECK (`state` in ('pending', 'committed'))
);
--> statement-breakpoint
DROP TABLE `_host_cpu_reservations_v6`;
--> statement-breakpoint
CREATE INDEX `host_cpu_reservations_host_state_idx` ON `host_cpu_reservations` (`host_id`,`state`);
--> statement-breakpoint
CREATE INDEX `host_cpu_reservations_pending_expiry_idx` ON `host_cpu_reservations` (`state`,`expires_at`);
