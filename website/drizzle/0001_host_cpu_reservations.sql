-- V6 is a drain-first break. Refuse to rewrite bridge documents while the
-- control plane still has a connected bridge client, enabled scenario
-- placement, an active run/build, a desired VM that is not an absent
-- tombstone, or a host report that has not drained. The guard table is
-- intentionally retryable: a failed CHECK leaves it behind, and the next
-- attempt clears it before checking the invariants again.
CREATE TABLE IF NOT EXISTS `_intar_v6_cutover_guard` (
	`ok` integer NOT NULL,
	CONSTRAINT `_intar_v6_cutover_guard_drained` CHECK (`ok` = 1)
);
--> statement-breakpoint
DELETE FROM `_intar_v6_cutover_guard`;
--> statement-breakpoint
INSERT INTO `_intar_v6_cutover_guard` (`ok`)
SELECT CASE WHEN
	EXISTS (
		SELECT 1 FROM `agent_hosts`
		WHERE `connected` != 0
			OR (`role` = 'agent' AND `scenario_enabled` != 0)
	)
	OR EXISTS (SELECT 1 FROM `scenario_runs` WHERE `active_key` IS NOT NULL)
	OR EXISTS (
		SELECT 1 FROM `image_builds`
		WHERE `status` IN ('queued', 'assigned', 'building')
	)
	OR EXISTS (
		SELECT 1 FROM `host_desired_state`
		WHERE json_valid(`doc_json`) != 1
			OR coalesce(json_extract(`doc_json`, '$.schema_version'), -1) != 2
			OR coalesce(json_extract(`doc_json`, '$.host_id'), '') != `host_id`
			OR coalesce(json_extract(`doc_json`, '$.version'), -1) != `version`
			OR coalesce(json_type(`doc_json`, '$.cached_images'), 'missing') != 'array'
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
			OR coalesce(json_extract(`report_json`, '$.schema_version'), -1) != 2
			OR coalesce(json_extract(`report_json`, '$.host_id'), '') != `host_id`
			OR coalesce(json_type(`report_json`, '$.vms'), 'missing') != 'array'
			OR coalesce(json_type(`report_json`, '$.builds'), 'missing') != 'array'
			OR json_array_length(`report_json`, '$.vms') != 0
			OR json_array_length(`report_json`, '$.builds') != 0
	)
THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `_intar_v6_cutover_guard`;
--> statement-breakpoint
CREATE TABLE `host_cpu_reservations` (
	`run_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`cpu_millis` integer NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `host_cpu_reservations_cpu_positive` CHECK (`cpu_millis` > 0),
	CONSTRAINT `host_cpu_reservations_state_valid` CHECK (`state` in ('pending', 'committed'))
);
--> statement-breakpoint
CREATE INDEX `host_cpu_reservations_host_state_idx` ON `host_cpu_reservations` (`host_id`,`state`);
--> statement-breakpoint
CREATE INDEX `host_cpu_reservations_pending_expiry_idx` ON `host_cpu_reservations` (`state`,`expires_at`);
--> statement-breakpoint
ALTER TABLE `vm_scenario_vms` ADD `cpu_millis` integer DEFAULT 1000 NOT NULL;
--> statement-breakpoint
ALTER TABLE `vm_scenario_vms` ADD `vcpu_count` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE `vm_scenario_vms`
SET `cpu_millis` = `cpu` * 1000,
    `vcpu_count` = `cpu`;
--> statement-breakpoint
ALTER TABLE `vm_scenario_vms` DROP COLUMN `cpu`;
--> statement-breakpoint
-- Old schema-version-2 documents contain cpu_count, including absent VM
-- tombstones. They must never cross the V6 boundary. Preserve the monotonic
-- desired version, but replace every drained row with an empty schema-3
-- document and discard old actual reports so each upgraded host reports a
-- fresh, capability-bearing state before it becomes schedulable.
UPDATE `host_desired_state`
SET `version` = `version` + 1,
	`doc_json` = json_object(
		'schema_version', 3,
		'host_id', `host_id`,
		'version', `version` + 1,
		'generated_at_unix_ms', cast(unixepoch('subsecond') * 1000 as integer),
		'cached_images', json('[]'),
		'vms', json('[]'),
		'builds', json('[]')
	),
	`updated_at` = cast(unixepoch('subsecond') * 1000 as integer);
--> statement-breakpoint
DELETE FROM `host_actual_state`;
