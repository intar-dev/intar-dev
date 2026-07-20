ALTER TABLE `workshop_workspaces` ADD COLUMN `application_route_ids_json` text DEFAULT '[]' NOT NULL CHECK (json_valid(`application_route_ids_json`));
--> statement-breakpoint
CREATE TABLE `runtime_allocation_locks` (
	`key` text PRIMARY KEY NOT NULL,
	`owner_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT `runtime_allocation_locks_expiry_valid` CHECK (`expires_at` > 0)
);
--> statement-breakpoint
CREATE INDEX `runtime_allocation_locks_expiry_idx` ON `runtime_allocation_locks` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `runtime_vm_access_keys` (
	`runtime_vm_id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`public_key_openssh` text NOT NULL,
	`private_key_ciphertext_b64` text NOT NULL,
	`private_key_iv_b64` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`runtime_vm_id`) REFERENCES `runtime_vms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runtime_vm_access_keys_execution_idx` ON `runtime_vm_access_keys` (`execution_id`);
--> statement-breakpoint
CREATE TABLE `runtime_vm_actual_state` (
	`runtime_vm_id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`host_id` text NOT NULL,
	`phase` text NOT NULL,
	`desired_version` integer,
	`report_json` text NOT NULL,
	`observed_at` integer NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`runtime_vm_id`) REFERENCES `runtime_vms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `runtime_vm_actual_state_phase_valid` CHECK (`phase` IN ('pending', 'pulling_image', 'creating_disks', 'booting', 'running', 'ready', 'solved', 'stopping', 'stopped', 'failed', 'absent')),
	CONSTRAINT `runtime_vm_actual_state_desired_version_valid` CHECK (`desired_version` IS NULL OR `desired_version` >= 0),
	CONSTRAINT `runtime_vm_actual_state_report_json_valid` CHECK (json_valid(`report_json`))
);
--> statement-breakpoint
CREATE INDEX `runtime_vm_actual_state_execution_idx` ON `runtime_vm_actual_state` (`execution_id`, `phase`);
--> statement-breakpoint
CREATE INDEX `runtime_vm_actual_state_host_observed_idx` ON `runtime_vm_actual_state` (`host_id`, `observed_at`);
--> statement-breakpoint
CREATE TRIGGER `runtime_vm_access_keys_identity_insert_guard`
BEFORE INSERT ON `runtime_vm_access_keys`
WHEN NOT EXISTS (
	SELECT 1 FROM `runtime_vms`
	WHERE `id` = NEW.`runtime_vm_id` AND `execution_id` = NEW.`execution_id`
)
BEGIN
	SELECT RAISE(ABORT, 'runtime VM access key execution mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_vm_access_keys_identity_update_guard`
BEFORE UPDATE OF `runtime_vm_id`, `execution_id` ON `runtime_vm_access_keys`
WHEN NOT EXISTS (
	SELECT 1 FROM `runtime_vms`
	WHERE `id` = NEW.`runtime_vm_id` AND `execution_id` = NEW.`execution_id`
)
BEGIN
	SELECT RAISE(ABORT, 'runtime VM access key execution mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_vm_actual_state_identity_insert_guard`
BEFORE INSERT ON `runtime_vm_actual_state`
WHEN NOT EXISTS (
	SELECT 1 FROM `runtime_vms`
	WHERE `id` = NEW.`runtime_vm_id` AND `execution_id` = NEW.`execution_id`
)
BEGIN
	SELECT RAISE(ABORT, 'runtime VM actual-state execution mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_vm_actual_state_identity_update_guard`
BEFORE UPDATE OF `runtime_vm_id`, `execution_id` ON `runtime_vm_actual_state`
WHEN NOT EXISTS (
	SELECT 1 FROM `runtime_vms`
	WHERE `id` = NEW.`runtime_vm_id` AND `execution_id` = NEW.`execution_id`
)
BEGIN
	SELECT RAISE(ABORT, 'runtime VM actual-state execution mismatch');
END;
