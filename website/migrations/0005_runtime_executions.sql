CREATE TABLE `runtime_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text,
	`host_id` text,
	`domain_kind` text NOT NULL,
	`domain_id` text NOT NULL,
	`generation` integer NOT NULL,
	`source_execution_id` text,
	`checkpoint_id` text,
	`state` text DEFAULT 'queued' NOT NULL,
	`lease_expires_at` integer,
	`archive_requested_at` integer,
	`ended_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `runtime_executions_domain_kind_valid` CHECK (`domain_kind` IN ('scenario', 'workshop')),
	CONSTRAINT `runtime_executions_generation_positive` CHECK (`generation` > 0),
	CONSTRAINT `runtime_executions_state_valid` CHECK (`state` IN ('queued', 'provisioning', 'ready', 'archiving', 'archived', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_executions_domain_generation_uidx` ON `runtime_executions` (`domain_kind`, `domain_id`, `generation`);
--> statement-breakpoint
CREATE INDEX `runtime_executions_user_state_idx` ON `runtime_executions` (`user_id`, `state`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `runtime_executions_organization_state_idx` ON `runtime_executions` (`organization_id`, `state`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `runtime_executions_host_state_idx` ON `runtime_executions` (`host_id`, `state`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `runtime_executions_source_idx` ON `runtime_executions` (`source_execution_id`);
--> statement-breakpoint
CREATE TABLE `runtime_vms` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`vm_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`runtime_vm_name` text NOT NULL,
	`image_key_json` text NOT NULL,
	`image_sha256` text NOT NULL,
	`cpu_millis` integer NOT NULL,
	`memory_mib` integer NOT NULL,
	`disk_mib` integer NOT NULL,
	`terminal_host` text,
	`terminal_port` integer,
	`terminal_username` text,
	`terminal_host_key_openssh` text,
	`terminal_private_key_ciphertext_b64` text,
	`terminal_private_key_iv_b64` text,
	`terminal_observed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `runtime_vms_ordinal_valid` CHECK (`ordinal` >= 0),
	CONSTRAINT `runtime_vms_cpu_positive` CHECK (`cpu_millis` > 0),
	CONSTRAINT `runtime_vms_memory_positive` CHECK (`memory_mib` > 0),
	CONSTRAINT `runtime_vms_disk_positive` CHECK (`disk_mib` > 0),
	CONSTRAINT `runtime_vms_terminal_target_complete` CHECK ((`terminal_host` IS NULL AND `terminal_port` IS NULL AND `terminal_username` IS NULL AND `terminal_host_key_openssh` IS NULL AND `terminal_private_key_ciphertext_b64` IS NULL AND `terminal_private_key_iv_b64` IS NULL AND `terminal_observed_at` IS NULL) OR (`terminal_host` IS NOT NULL AND `terminal_port` > 0 AND `terminal_username` IS NOT NULL AND `terminal_host_key_openssh` IS NOT NULL AND `terminal_private_key_ciphertext_b64` IS NOT NULL AND `terminal_private_key_iv_b64` IS NOT NULL AND `terminal_observed_at` IS NOT NULL)),
	CONSTRAINT `runtime_vms_image_key_json_valid` CHECK (json_valid(`image_key_json`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_vms_execution_vm_uidx` ON `runtime_vms` (`execution_id`, `vm_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_vms_execution_ordinal_uidx` ON `runtime_vms` (`execution_id`, `ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_vms_execution_name_uidx` ON `runtime_vms` (`execution_id`, `runtime_vm_name`);
--> statement-breakpoint
CREATE TABLE `runtime_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`runtime_vm_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`r2_key` text NOT NULL,
	`upload_status` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`uploaded_at` integer,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runtime_vm_id`) REFERENCES `runtime_vms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `runtime_artifacts_ordinal_valid` CHECK (`ordinal` >= 0),
	CONSTRAINT `runtime_artifacts_size_valid` CHECK (`size_bytes` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_artifacts_vm_ordinal_uidx` ON `runtime_artifacts` (`runtime_vm_id`, `ordinal`);
--> statement-breakpoint
CREATE INDEX `runtime_artifacts_execution_idx` ON `runtime_artifacts` (`execution_id`, `runtime_vm_id`, `ordinal`);
--> statement-breakpoint
CREATE INDEX `runtime_artifacts_r2_key_idx` ON `runtime_artifacts` (`r2_key`);
--> statement-breakpoint
CREATE TABLE `runtime_terminal_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`runtime_vm_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`exit_code` integer,
	`recording_artifact_id` text,
	`transcript_r2_key` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runtime_vm_id`) REFERENCES `runtime_vms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recording_artifact_id`) REFERENCES `runtime_artifacts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `runtime_terminal_sessions_ordinal_valid` CHECK (`ordinal` >= 0),
	CONSTRAINT `runtime_terminal_sessions_duration_valid` CHECK (`ended_at` IS NULL OR `ended_at` >= `started_at`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_terminal_sessions_vm_ordinal_uidx` ON `runtime_terminal_sessions` (`runtime_vm_id`, `ordinal`);
--> statement-breakpoint
CREATE INDEX `runtime_terminal_sessions_execution_idx` ON `runtime_terminal_sessions` (`execution_id`, `runtime_vm_id`, `started_at`);
--> statement-breakpoint
CREATE TABLE `active_runtime_slots` (
	`user_id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`acquired_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `active_runtime_slots_execution_uidx` ON `active_runtime_slots` (`execution_id`);
--> statement-breakpoint
CREATE TABLE `host_resource_reservations` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`cpu_millis` integer NOT NULL,
	`memory_mib` integer NOT NULL,
	`worst_case_disk_mib` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer,
	`released_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `host_resource_reservations_cpu_positive` CHECK (`cpu_millis` > 0),
	CONSTRAINT `host_resource_reservations_memory_positive` CHECK (`memory_mib` > 0),
	CONSTRAINT `host_resource_reservations_disk_positive` CHECK (`worst_case_disk_mib` > 0),
	CONSTRAINT `host_resource_reservations_state_valid` CHECK (`state` IN ('pending', 'committed', 'released'))
);
--> statement-breakpoint
CREATE INDEX `host_resource_reservations_host_state_idx` ON `host_resource_reservations` (`host_id`, `state`);
--> statement-breakpoint
CREATE INDEX `host_resource_reservations_expiry_idx` ON `host_resource_reservations` (`state`, `expires_at`);
--> statement-breakpoint
ALTER TABLE `scenario_runs` ADD COLUMN `runtime_execution_id` text REFERENCES `runtime_executions`(`id`) ON DELETE set null;
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_runs_runtime_execution_uidx` ON `scenario_runs` (`runtime_execution_id`);
--> statement-breakpoint
INSERT INTO `runtime_executions` (
	`id`,
	`user_id`,
	`organization_id`,
	`host_id`,
	`domain_kind`,
	`domain_id`,
	`generation`,
	`source_execution_id`,
	`checkpoint_id`,
	`state`,
	`lease_expires_at`,
	`archive_requested_at`,
	`ended_at`,
	`created_at`,
	`updated_at`
)
SELECT
	`run_id`,
	`user_id`,
	`organization_id`,
	`host_id`,
	'scenario',
	`run_id`,
	1,
	NULL,
	NULL,
	CASE
		WHEN `state` = 'queued' THEN 'queued'
		WHEN `state` = 'provisioning' THEN 'provisioning'
		WHEN `state` IN ('teardown_requested', 'tearing_down', 'archiving') THEN 'archiving'
		WHEN `state` = 'completed' THEN 'archived'
		WHEN `state` = 'failed' THEN 'failed'
		ELSE 'ready'
	END,
	NULL,
	CASE
		WHEN `state` IN ('teardown_requested', 'tearing_down', 'archiving', 'completed', 'failed') THEN `updated_at`
		ELSE NULL
	END,
	CASE
		WHEN `state` = 'completed' THEN coalesce(`completed_at`, `updated_at`)
		WHEN `state` = 'failed' THEN coalesce(`failed_at`, `updated_at`)
		ELSE NULL
	END,
	`created_at`,
	`updated_at`
FROM `scenario_runs`;
--> statement-breakpoint
UPDATE `scenario_runs` SET `runtime_execution_id` = `run_id`;
--> statement-breakpoint
INSERT INTO `active_runtime_slots` (`user_id`, `execution_id`, `acquired_at`)
SELECT `user_id`, `run_id`, `created_at`
FROM `scenario_runs`
WHERE `active_key` IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `runtime_executions_identity_immutable`
BEFORE UPDATE OF `user_id`, `organization_id`, `domain_kind`, `domain_id`, `generation`, `source_execution_id` ON `runtime_executions`
WHEN OLD.`user_id` IS NOT NEW.`user_id`
	OR OLD.`organization_id` IS NOT NEW.`organization_id`
	OR OLD.`domain_kind` IS NOT NEW.`domain_kind`
	OR OLD.`domain_id` IS NOT NEW.`domain_id`
	OR OLD.`generation` IS NOT NEW.`generation`
	OR OLD.`source_execution_id` IS NOT NEW.`source_execution_id`
BEGIN
	SELECT RAISE(ABORT, 'runtime execution identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_executions_source_insert_guard`
BEFORE INSERT ON `runtime_executions`
WHEN NEW.`source_execution_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1
		FROM `runtime_executions` source
		WHERE source.`id` = NEW.`source_execution_id`
			AND source.`user_id` = NEW.`user_id`
			AND source.`organization_id` IS NEW.`organization_id`
			AND source.`domain_kind` = NEW.`domain_kind`
			AND source.`domain_id` = NEW.`domain_id`
			AND source.`generation` + 1 = NEW.`generation`
	)
BEGIN
	SELECT RAISE(ABORT, 'runtime recovery source identity mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_vms_specification_immutable`
BEFORE UPDATE OF `execution_id`, `vm_id`, `ordinal`, `runtime_vm_name`, `image_key_json`, `image_sha256`, `cpu_millis`, `memory_mib`, `disk_mib` ON `runtime_vms`
BEGIN
	SELECT RAISE(ABORT, 'runtime VM specifications are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_artifacts_vm_execution_insert_guard`
BEFORE INSERT ON `runtime_artifacts`
WHEN NOT EXISTS (
	SELECT 1 FROM `runtime_vms`
	WHERE `id` = NEW.`runtime_vm_id` AND `execution_id` = NEW.`execution_id`
)
BEGIN
	SELECT RAISE(ABORT, 'runtime artifact VM belongs to another execution');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_artifacts_vm_execution_update_guard`
BEFORE UPDATE OF `execution_id`, `runtime_vm_id` ON `runtime_artifacts`
WHEN NOT EXISTS (
	SELECT 1 FROM `runtime_vms`
	WHERE `id` = NEW.`runtime_vm_id` AND `execution_id` = NEW.`execution_id`
)
BEGIN
	SELECT RAISE(ABORT, 'runtime artifact VM belongs to another execution');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_terminal_sessions_execution_insert_guard`
BEFORE INSERT ON `runtime_terminal_sessions`
WHEN NOT EXISTS (
	SELECT 1 FROM `runtime_vms`
	WHERE `id` = NEW.`runtime_vm_id` AND `execution_id` = NEW.`execution_id`
)
	OR (
		NEW.`recording_artifact_id` IS NOT NULL
		AND NOT EXISTS (
			SELECT 1 FROM `runtime_artifacts`
			WHERE `id` = NEW.`recording_artifact_id` AND `execution_id` = NEW.`execution_id`
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'runtime terminal session identity mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_terminal_sessions_execution_update_guard`
BEFORE UPDATE OF `execution_id`, `runtime_vm_id`, `recording_artifact_id` ON `runtime_terminal_sessions`
WHEN NOT EXISTS (
	SELECT 1 FROM `runtime_vms`
	WHERE `id` = NEW.`runtime_vm_id` AND `execution_id` = NEW.`execution_id`
)
	OR (
		NEW.`recording_artifact_id` IS NOT NULL
		AND NOT EXISTS (
			SELECT 1 FROM `runtime_artifacts`
			WHERE `id` = NEW.`recording_artifact_id` AND `execution_id` = NEW.`execution_id`
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'runtime terminal session identity mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `active_runtime_slots_execution_insert_guard`
BEFORE INSERT ON `active_runtime_slots`
WHEN NOT EXISTS (
	SELECT 1
	FROM `runtime_executions` execution
	WHERE execution.`id` = NEW.`execution_id`
		AND execution.`user_id` = NEW.`user_id`
		AND NOT EXISTS (
			SELECT 1
			FROM `runtime_executions` newer
			WHERE newer.`domain_kind` = execution.`domain_kind`
				AND newer.`domain_id` = execution.`domain_id`
				AND newer.`generation` > execution.`generation`
		)
)
BEGIN
	SELECT RAISE(ABORT, 'active runtime slot requires the current owner generation');
END;
--> statement-breakpoint
CREATE TRIGGER `active_runtime_slots_execution_update_guard`
BEFORE UPDATE OF `user_id`, `execution_id` ON `active_runtime_slots`
WHEN NOT EXISTS (
	SELECT 1
	FROM `runtime_executions` execution
	WHERE execution.`id` = NEW.`execution_id`
		AND execution.`user_id` = NEW.`user_id`
		AND NOT EXISTS (
			SELECT 1
			FROM `runtime_executions` newer
			WHERE newer.`domain_kind` = execution.`domain_kind`
				AND newer.`domain_id` = execution.`domain_id`
				AND newer.`generation` > execution.`generation`
		)
)
BEGIN
	SELECT RAISE(ABORT, 'active runtime slot requires the current owner generation');
END;
--> statement-breakpoint
CREATE TRIGGER `scenario_runs_runtime_slot_insert_conflict`
BEFORE INSERT ON `scenario_runs`
WHEN NEW.`active_key` IS NOT NULL
	AND EXISTS (
		SELECT 1
		FROM `active_runtime_slots`
		WHERE `user_id` = NEW.`user_id`
			AND (
				NEW.`runtime_execution_id` IS NULL
				OR `execution_id` <> NEW.`runtime_execution_id`
			)
	)
BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: scenario_runs.active_key');
END;
--> statement-breakpoint
CREATE TRIGGER `scenario_runs_runtime_slot_update_conflict`
BEFORE UPDATE OF `active_key` ON `scenario_runs`
WHEN NEW.`active_key` IS NOT NULL
	AND OLD.`active_key` IS NOT NEW.`active_key`
	AND EXISTS (
		SELECT 1
		FROM `active_runtime_slots`
		WHERE `user_id` = NEW.`user_id`
			AND `execution_id` <> NEW.`runtime_execution_id`
	)
BEGIN
	SELECT RAISE(ABORT, 'UNIQUE constraint failed: scenario_runs.active_key');
END;
--> statement-breakpoint
CREATE TRIGGER `scenario_runs_runtime_execution_insert_sync`
AFTER INSERT ON `scenario_runs`
BEGIN
	INSERT INTO `runtime_executions` (
		`id`, `user_id`, `organization_id`, `host_id`, `domain_kind`, `domain_id`,
		`generation`, `source_execution_id`, `checkpoint_id`, `state`,
		`lease_expires_at`, `archive_requested_at`, `ended_at`, `created_at`, `updated_at`
	)
	SELECT
		coalesce(NEW.`runtime_execution_id`, NEW.`run_id`),
		NEW.`user_id`,
		NEW.`organization_id`,
		NEW.`host_id`,
		'scenario',
		NEW.`run_id`,
		1,
		NULL,
		NULL,
		CASE
			WHEN NEW.`state` = 'queued' THEN 'queued'
			WHEN NEW.`state` = 'provisioning' THEN 'provisioning'
			WHEN NEW.`state` IN ('teardown_requested', 'tearing_down', 'archiving') THEN 'archiving'
			WHEN NEW.`state` = 'completed' THEN 'archived'
			WHEN NEW.`state` = 'failed' THEN 'failed'
			ELSE 'ready'
		END,
		NULL,
		CASE
			WHEN NEW.`state` IN ('teardown_requested', 'tearing_down', 'archiving', 'completed', 'failed') THEN NEW.`updated_at`
			ELSE NULL
		END,
		CASE
			WHEN NEW.`state` = 'completed' THEN coalesce(NEW.`completed_at`, NEW.`updated_at`)
			WHEN NEW.`state` = 'failed' THEN coalesce(NEW.`failed_at`, NEW.`updated_at`)
			ELSE NULL
		END,
		NEW.`created_at`,
		NEW.`updated_at`
	WHERE NOT EXISTS (
		SELECT 1 FROM `runtime_executions`
		WHERE `id` = coalesce(NEW.`runtime_execution_id`, NEW.`run_id`)
	);

	SELECT RAISE(ABORT, 'scenario runtime execution identity mismatch')
	WHERE NOT EXISTS (
		SELECT 1
		FROM `runtime_executions`
		WHERE `id` = coalesce(NEW.`runtime_execution_id`, NEW.`run_id`)
			AND `user_id` = NEW.`user_id`
			AND `organization_id` IS NEW.`organization_id`
			AND `domain_kind` = 'scenario'
			AND `domain_id` = NEW.`run_id`
			AND `generation` = 1
	);

	UPDATE `scenario_runs`
	SET `runtime_execution_id` = coalesce(NEW.`runtime_execution_id`, NEW.`run_id`)
	WHERE `run_id` = NEW.`run_id` AND `runtime_execution_id` IS NULL;

	INSERT INTO `active_runtime_slots` (`user_id`, `execution_id`, `acquired_at`)
	SELECT NEW.`user_id`, coalesce(NEW.`runtime_execution_id`, NEW.`run_id`), NEW.`created_at`
	WHERE NEW.`active_key` IS NOT NULL
	ON CONFLICT (`user_id`) DO UPDATE SET
		`acquired_at` = `active_runtime_slots`.`acquired_at`
	WHERE `active_runtime_slots`.`execution_id` = excluded.`execution_id`;

	SELECT RAISE(ABORT, 'UNIQUE constraint failed: scenario_runs.active_key')
	WHERE NEW.`active_key` IS NOT NULL
		AND NOT EXISTS (
			SELECT 1 FROM `active_runtime_slots`
			WHERE `user_id` = NEW.`user_id`
				AND `execution_id` = coalesce(NEW.`runtime_execution_id`, NEW.`run_id`)
		);
END;
--> statement-breakpoint
CREATE TRIGGER `scenario_runs_runtime_execution_update_sync`
AFTER UPDATE OF `state`, `active_key`, `completed_at`, `failed_at` ON `scenario_runs`
WHEN OLD.`state` IS NOT NEW.`state`
	OR OLD.`active_key` IS NOT NEW.`active_key`
	OR OLD.`completed_at` IS NOT NEW.`completed_at`
	OR OLD.`failed_at` IS NOT NEW.`failed_at`
BEGIN
	UPDATE `runtime_executions`
	SET
		`host_id` = NEW.`host_id`,
		`state` = CASE
			WHEN NEW.`state` = 'queued' THEN 'queued'
			WHEN NEW.`state` = 'provisioning' THEN 'provisioning'
			WHEN NEW.`state` IN ('teardown_requested', 'tearing_down', 'archiving') THEN 'archiving'
			WHEN NEW.`state` = 'completed' THEN 'archived'
			WHEN NEW.`state` = 'failed' THEN 'failed'
			ELSE 'ready'
		END,
		`archive_requested_at` = CASE
			WHEN NEW.`state` IN ('teardown_requested', 'tearing_down', 'archiving', 'completed', 'failed')
				THEN coalesce(`archive_requested_at`, NEW.`updated_at`)
			ELSE `archive_requested_at`
		END,
		`ended_at` = CASE
			WHEN NEW.`state` = 'completed' THEN coalesce(NEW.`completed_at`, NEW.`updated_at`)
			WHEN NEW.`state` = 'failed' THEN coalesce(NEW.`failed_at`, NEW.`updated_at`)
			ELSE `ended_at`
		END,
		`updated_at` = NEW.`updated_at`
	WHERE `id` = NEW.`runtime_execution_id`;

	DELETE FROM `active_runtime_slots`
	WHERE NEW.`active_key` IS NULL
		AND `execution_id` = NEW.`runtime_execution_id`;

	INSERT INTO `active_runtime_slots` (`user_id`, `execution_id`, `acquired_at`)
	SELECT NEW.`user_id`, NEW.`runtime_execution_id`, NEW.`updated_at`
	WHERE NEW.`active_key` IS NOT NULL
	ON CONFLICT (`user_id`) DO UPDATE SET
		`execution_id` = excluded.`execution_id`
	WHERE `active_runtime_slots`.`execution_id` = excluded.`execution_id`;

	SELECT RAISE(ABORT, 'UNIQUE constraint failed: scenario_runs.active_key')
	WHERE NEW.`active_key` IS NOT NULL
		AND NOT EXISTS (
			SELECT 1 FROM `active_runtime_slots`
			WHERE `user_id` = NEW.`user_id`
				AND `execution_id` = NEW.`runtime_execution_id`
		);
END;
--> statement-breakpoint
CREATE TRIGGER `scenario_runs_runtime_execution_delete_sync`
AFTER DELETE ON `scenario_runs`
BEGIN
	DELETE FROM `runtime_executions`
	WHERE `domain_kind` = 'scenario' AND `domain_id` = OLD.`run_id`;
END;
