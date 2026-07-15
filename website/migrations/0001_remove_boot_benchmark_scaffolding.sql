-- The production Worker no longer uses the one-off boot-benchmark admission
-- path. Remove its exclusive lease table and every trigger that existed only
-- to isolate disabled hosts during that benchmark.
DROP TRIGGER IF EXISTS `host_benchmark_lease_requires_scheduling_disabled`;
DROP TRIGGER IF EXISTS `host_benchmark_lease_requires_zero_reservations`;
DROP TRIGGER IF EXISTS `host_benchmark_lease_blocks_scenario_enable`;
DROP TRIGGER IF EXISTS `host_benchmark_lease_identity_is_immutable`;
DROP TRIGGER IF EXISTS `host_benchmark_lease_blocks_cross_run_reservation_insert`;
DROP TRIGGER IF EXISTS `host_benchmark_lease_blocks_cross_run_reservation_update`;
DROP TRIGGER IF EXISTS `host_benchmark_lease_freezes_cache_and_build_desired_state`;
DROP TRIGGER IF EXISTS `host_benchmark_lease_blocks_foreign_desired_vm`;
DROP TRIGGER IF EXISTS `host_benchmark_lease_blocks_desired_state_delete`;
DROP TRIGGER IF EXISTS `host_benchmark_lease_contract_is_valid`;
DROP TRIGGER IF EXISTS `host_benchmark_lease_contract_is_immutable`;
DROP TABLE IF EXISTS `host_benchmark_leases`;

-- Stop legacy benchmark measurements from surviving ordinary read/modify/write
-- cycles in otherwise-current run documents.
UPDATE `scenario_runs`
SET `state_json` = json_set(
	`state_json`,
	'$.vms',
	(
		SELECT json_group_array(
			json_remove(
				`value`,
				'$.bootEvidence',
				'$.workerDesiredDispatchAt',
				'$.workerDesiredDispatchVersion',
				'$.workerTerminalReportReceivedAt',
				'$.workerTerminalProjectionAckAt',
				'$.workerTerminalReceiptToProjectionAckMs',
				'$.workerTerminalProjectionGeneration',
				'$.workerTerminalDesiredVersion'
			)
		)
		FROM json_each(`scenario_runs`.`state_json`, '$.vms')
	)
)
WHERE json_type(`state_json`, '$.vms') = 'array'
	AND EXISTS (
		SELECT 1
		FROM json_each(`scenario_runs`.`state_json`, '$.vms')
		WHERE json_type(`value`, '$.bootEvidence') IS NOT NULL
			OR json_type(`value`, '$.workerDesiredDispatchAt') IS NOT NULL
			OR json_type(`value`, '$.workerDesiredDispatchVersion') IS NOT NULL
			OR json_type(`value`, '$.workerTerminalReportReceivedAt') IS NOT NULL
			OR json_type(`value`, '$.workerTerminalProjectionAckAt') IS NOT NULL
			OR json_type(`value`, '$.workerTerminalReceiptToProjectionAckMs') IS NOT NULL
			OR json_type(`value`, '$.workerTerminalProjectionGeneration') IS NOT NULL
			OR json_type(`value`, '$.workerTerminalDesiredVersion') IS NOT NULL
	);
