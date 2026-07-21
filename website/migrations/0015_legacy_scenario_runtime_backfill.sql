-- Migration 0009 expected the V6 `cpuMillis` field in every stored scenario
-- VM. Runs completed before the V6 cutover instead persist whole-core
-- `vcpus`, so their otherwise complete runtime records were rejected by the
-- positive-resource guard. Repair only missing ledger rows and
-- preserve the V6 conversion of one legacy vCPU to 1000 millicores.
WITH `legacy_vms` AS (
	SELECT
		run.`run_id`,
		run.`runtime_execution_id`,
		run.`created_at`,
		run.`updated_at`,
		vm.`value` AS `vm_json`,
		CASE
			WHEN cast(json_extract(vm.`value`, '$.provisioning.resources.cpuMillis') AS integer) > 0
				THEN cast(json_extract(vm.`value`, '$.provisioning.resources.cpuMillis') AS integer)
			WHEN cast(json_extract(vm.`value`, '$.provisioning.resources.vcpuCount') AS integer) > 0
				THEN cast(json_extract(vm.`value`, '$.provisioning.resources.vcpuCount') AS integer) * 1000
			WHEN cast(json_extract(vm.`value`, '$.provisioning.resources.vcpus') AS integer) > 0
				THEN cast(json_extract(vm.`value`, '$.provisioning.resources.vcpus') AS integer) * 1000
			ELSE NULL
		END AS `cpu_millis`
	FROM `scenario_runs` run
	JOIN json_each(run.`state_json`, '$.vms') vm
	WHERE run.`runtime_execution_id` IS NOT NULL
)
INSERT OR IGNORE INTO `runtime_vms` (
	`id`, `execution_id`, `vm_id`, `ordinal`, `runtime_vm_name`,
	`image_key_json`, `image_sha256`, `cpu_millis`, `memory_mib`, `disk_mib`,
	`terminal_host`, `terminal_port`, `terminal_username`,
	`terminal_host_key_openssh`, `terminal_private_key_ciphertext_b64`,
	`terminal_private_key_iv_b64`, `terminal_observed_at`,
	`artifact_writes_sealed`, `created_at`, `updated_at`
)
SELECT
	legacy.`run_id` || ':' || json_extract(legacy.`vm_json`, '$.id'),
	legacy.`runtime_execution_id`,
	json_extract(legacy.`vm_json`, '$.id'),
	cast(json_extract(legacy.`vm_json`, '$.ordinal') AS integer),
	json_extract(legacy.`vm_json`, '$.runtimeVmName'),
	json_extract(legacy.`vm_json`, '$.provisioning.imageKey'),
	json_extract(legacy.`vm_json`, '$.provisioning.imageSha256'),
	legacy.`cpu_millis`,
	cast(json_extract(legacy.`vm_json`, '$.provisioning.resources.memoryMib') AS integer),
	cast(json_extract(legacy.`vm_json`, '$.provisioning.resources.diskMib') AS integer),
	CASE WHEN
		json_extract(legacy.`vm_json`, '$.terminalTarget.host') IS NOT NULL AND
		cast(json_extract(legacy.`vm_json`, '$.terminalTarget.port') AS integer) > 0 AND
		json_extract(legacy.`vm_json`, '$.terminalTarget.hostKeyOpenssh') IS NOT NULL AND
		ssh.`private_key_ciphertext_b64` IS NOT NULL
	THEN json_extract(legacy.`vm_json`, '$.terminalTarget.host') ELSE NULL END,
	CASE WHEN
		json_extract(legacy.`vm_json`, '$.terminalTarget.host') IS NOT NULL AND
		cast(json_extract(legacy.`vm_json`, '$.terminalTarget.port') AS integer) > 0 AND
		json_extract(legacy.`vm_json`, '$.terminalTarget.hostKeyOpenssh') IS NOT NULL AND
		ssh.`private_key_ciphertext_b64` IS NOT NULL
	THEN cast(json_extract(legacy.`vm_json`, '$.terminalTarget.port') AS integer) ELSE NULL END,
	CASE WHEN
		json_extract(legacy.`vm_json`, '$.terminalTarget.host') IS NOT NULL AND
		cast(json_extract(legacy.`vm_json`, '$.terminalTarget.port') AS integer) > 0 AND
		json_extract(legacy.`vm_json`, '$.terminalTarget.hostKeyOpenssh') IS NOT NULL AND
		ssh.`private_key_ciphertext_b64` IS NOT NULL
	THEN coalesce(json_extract(legacy.`vm_json`, '$.terminalTarget.username'), 'ubuntu') ELSE NULL END,
	CASE WHEN
		json_extract(legacy.`vm_json`, '$.terminalTarget.host') IS NOT NULL AND
		cast(json_extract(legacy.`vm_json`, '$.terminalTarget.port') AS integer) > 0 AND
		json_extract(legacy.`vm_json`, '$.terminalTarget.hostKeyOpenssh') IS NOT NULL AND
		ssh.`private_key_ciphertext_b64` IS NOT NULL
	THEN json_extract(legacy.`vm_json`, '$.terminalTarget.hostKeyOpenssh') ELSE NULL END,
	CASE WHEN
		json_extract(legacy.`vm_json`, '$.terminalTarget.host') IS NOT NULL AND
		cast(json_extract(legacy.`vm_json`, '$.terminalTarget.port') AS integer) > 0 AND
		json_extract(legacy.`vm_json`, '$.terminalTarget.hostKeyOpenssh') IS NOT NULL AND
		ssh.`private_key_ciphertext_b64` IS NOT NULL
	THEN ssh.`private_key_ciphertext_b64` ELSE NULL END,
	CASE WHEN
		json_extract(legacy.`vm_json`, '$.terminalTarget.host') IS NOT NULL AND
		cast(json_extract(legacy.`vm_json`, '$.terminalTarget.port') AS integer) > 0 AND
		json_extract(legacy.`vm_json`, '$.terminalTarget.hostKeyOpenssh') IS NOT NULL AND
		ssh.`private_key_ciphertext_b64` IS NOT NULL
	THEN ssh.`private_key_iv_b64` ELSE NULL END,
	CASE WHEN
		json_extract(legacy.`vm_json`, '$.terminalTarget.host') IS NOT NULL AND
		cast(json_extract(legacy.`vm_json`, '$.terminalTarget.port') AS integer) > 0 AND
		json_extract(legacy.`vm_json`, '$.terminalTarget.hostKeyOpenssh') IS NOT NULL AND
		ssh.`private_key_ciphertext_b64` IS NOT NULL
	THEN coalesce(
		cast(json_extract(legacy.`vm_json`, '$.terminalTarget.checkedAt') AS integer),
		legacy.`updated_at`
	) ELSE NULL END,
	CASE WHEN json_extract(legacy.`vm_json`, '$.phase') = 'completed' THEN 1 ELSE 0 END,
	legacy.`created_at`,
	legacy.`updated_at`
FROM `legacy_vms` legacy
LEFT JOIN `scenario_run_ssh_keys` ssh
	ON ssh.`run_id` = legacy.`run_id`
	AND ssh.`vm_id` = json_extract(legacy.`vm_json`, '$.id')
WHERE json_type(legacy.`vm_json`, '$.id') = 'text'
	AND json_type(legacy.`vm_json`, '$.runtimeVmName') = 'text'
	AND json_type(legacy.`vm_json`, '$.provisioning.imageKey') = 'object'
	AND json_type(legacy.`vm_json`, '$.provisioning.imageSha256') = 'text'
	AND legacy.`cpu_millis` > 0
	AND cast(json_extract(legacy.`vm_json`, '$.provisioning.resources.memoryMib') AS integer) > 0
	AND cast(json_extract(legacy.`vm_json`, '$.provisioning.resources.diskMib') AS integer) > 0;
--> statement-breakpoint
INSERT OR IGNORE INTO `runtime_vm_access_keys` (
	`runtime_vm_id`, `execution_id`, `public_key_openssh`,
	`private_key_ciphertext_b64`, `private_key_iv_b64`, `created_at`
)
SELECT
	vm.`id`, vm.`execution_id`, ssh.`public_key_openssh`,
	ssh.`private_key_ciphertext_b64`, ssh.`private_key_iv_b64`, ssh.`created_at`
FROM `scenario_run_ssh_keys` ssh
JOIN `scenario_runs` run ON run.`run_id` = ssh.`run_id`
JOIN `runtime_vms` vm
	ON vm.`execution_id` = run.`runtime_execution_id`
	AND vm.`vm_id` = ssh.`vm_id`;
--> statement-breakpoint
INSERT OR IGNORE INTO `runtime_artifacts` (
	`id`, `execution_id`, `runtime_vm_id`, `ordinal`, `kind`, `filename`,
	`content_type`, `size_bytes`, `sha256`, `r2_key`, `upload_status`,
	`created_at`, `uploaded_at`
)
SELECT
	artifact.`id`, run.`runtime_execution_id`, vm.`id`, artifact.`ordinal`,
	artifact.`kind`, artifact.`filename`, artifact.`content_type`,
	artifact.`size_bytes`, artifact.`sha256`, artifact.`r2_key`,
	artifact.`upload_status`, artifact.`created_at`, artifact.`uploaded_at`
FROM `scenario_run_artifacts` artifact
JOIN `scenario_runs` run ON run.`run_id` = artifact.`run_id`
JOIN `runtime_vms` vm
	ON vm.`execution_id` = run.`runtime_execution_id`
	AND vm.`vm_id` = artifact.`vm_id`;
--> statement-breakpoint
INSERT OR IGNORE INTO `runtime_artifact_uploads` (
	`artifact_id`, `r2_upload_id`, `uploaded_parts_json`,
	`next_expected_part`, `updated_at`
)
SELECT
	upload.`artifact_id`, upload.`r2_upload_id`, upload.`uploaded_parts_json`,
	upload.`next_expected_part`, upload.`updated_at`
FROM `scenario_run_artifact_uploads` upload
JOIN `runtime_artifacts` artifact ON artifact.`id` = upload.`artifact_id`;
--> statement-breakpoint
INSERT OR IGNORE INTO `runtime_terminal_sessions` (
	`id`, `execution_id`, `runtime_vm_id`, `ordinal`, `started_at`, `ended_at`,
	`exit_code`, `recording_artifact_id`, `transcript_r2_key`, `created_at`, `updated_at`
)
SELECT
	run.`run_id` || ':' || json_extract(vm.value, '$.id') || ':session:' ||
		cast(json_extract(session.value, '$.index') AS text),
	run.`runtime_execution_id`,
	runtime_vm.`id`,
	cast(json_extract(session.value, '$.index') AS integer),
	cast(json_extract(session.value, '$.startTimestampMs') AS integer),
	cast(json_extract(session.value, '$.startTimestampMs') AS integer) +
		cast(json_extract(session.value, '$.durationMs') AS integer),
	cast(json_extract(session.value, '$.exitCode') AS integer),
	CASE WHEN artifact.`id` IS NOT NULL THEN artifact.`id` ELSE NULL END,
	NULL,
	run.`created_at`,
	run.`updated_at`
FROM `scenario_runs` run
JOIN json_each(run.`state_json`, '$.vms') vm
JOIN json_each(vm.value, '$.sessionTimeline') session
JOIN `runtime_vms` runtime_vm
	ON runtime_vm.`execution_id` = run.`runtime_execution_id`
	AND runtime_vm.`vm_id` = json_extract(vm.value, '$.id')
LEFT JOIN `runtime_artifacts` artifact
	ON artifact.`execution_id` = run.`runtime_execution_id`
	AND artifact.`id` = json_extract(session.value, '$.castArtifactId')
WHERE json_type(session.value, '$.index') = 'integer'
	AND cast(json_extract(session.value, '$.startTimestampMs') AS integer) >= 0
	AND cast(json_extract(session.value, '$.durationMs') AS integer) >= 0;
--> statement-breakpoint
INSERT OR IGNORE INTO `host_resource_reservations` (
	`execution_id`, `host_id`, `cpu_millis`, `memory_mib`,
	`worst_case_disk_mib`, `state`, `expires_at`, `released_at`,
	`created_at`, `updated_at`
)
SELECT
	execution.`id`, execution.`host_id`, sum(vm.`cpu_millis`),
	sum(vm.`memory_mib`), sum(vm.`disk_mib`), 'committed',
	execution.`lease_expires_at`, NULL, execution.`created_at`, execution.`updated_at`
FROM `runtime_executions` execution
JOIN `active_runtime_slots` slot ON slot.`execution_id` = execution.`id`
JOIN `runtime_vms` vm ON vm.`execution_id` = execution.`id`
WHERE execution.`domain_kind` = 'scenario'
	AND execution.`host_id` IS NOT NULL
GROUP BY execution.`id`, execution.`host_id`, execution.`lease_expires_at`,
	execution.`created_at`, execution.`updated_at`;
