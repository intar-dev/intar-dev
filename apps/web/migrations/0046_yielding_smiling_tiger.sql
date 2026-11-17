PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
DROP TABLE `image_build_bundles`;--> statement-breakpoint
DROP TABLE `image_build_coordination_locks`;--> statement-breakpoint
DROP TABLE `image_builds`;--> statement-breakpoint
DROP TABLE `scenario_catalog_candidates`;--> statement-breakpoint
DROP TABLE `scenario_catalog_snapshots`;--> statement-breakpoint
DROP TABLE `scenario_run_probe_snapshots`;--> statement-breakpoint
DROP TABLE `vm_scenario_probes`;--> statement-breakpoint
DROP TABLE `vm_scenario_vms`;--> statement-breakpoint
DROP TABLE `vm_scenarios`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runtime_vms` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`vm_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`runtime_vm_name` text NOT NULL,
	`image_digest` text NOT NULL,
	`spec_digest` text NOT NULL,
	`kino_digest` text NOT NULL,
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
	`terminal_attached_at` integer,
	`artifact_writes_sealed` integer DEFAULT false NOT NULL,
	`archive_stage_rank` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runtime_vms_ordinal_valid" CHECK("ordinal" >= 0),
	CONSTRAINT "runtime_vms_cpu_positive" CHECK("cpu_millis" > 0),
	CONSTRAINT "runtime_vms_memory_positive" CHECK("memory_mib" > 0),
	CONSTRAINT "runtime_vms_disk_positive" CHECK("disk_mib" > 0),
	CONSTRAINT "runtime_vms_digests_valid" CHECK(length("image_digest") = 71 AND substr("image_digest", 1, 7) = 'sha256:' AND length("spec_digest") = 71 AND substr("spec_digest", 1, 7) = 'sha256:' AND length("kino_digest") = 71 AND substr("kino_digest", 1, 7) = 'sha256:'),
	CONSTRAINT "runtime_vms_terminal_target_complete" CHECK(("terminal_host" is null AND "terminal_port" is null AND "terminal_username" is null AND "terminal_host_key_openssh" is null AND "terminal_private_key_ciphertext_b64" is null AND "terminal_private_key_iv_b64" is null AND "terminal_observed_at" is null) OR ("terminal_host" is not null AND "terminal_port" > 0 AND "terminal_username" is not null AND "terminal_host_key_openssh" is not null AND "terminal_private_key_ciphertext_b64" is not null AND "terminal_private_key_iv_b64" is not null AND "terminal_observed_at" is not null)),
	CONSTRAINT "runtime_vms_artifact_writes_sealed_valid" CHECK("artifact_writes_sealed" in (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_runtime_vms`("id", "execution_id", "vm_id", "ordinal", "runtime_vm_name", "image_digest", "spec_digest", "kino_digest", "cpu_millis", "memory_mib", "disk_mib", "terminal_host", "terminal_port", "terminal_username", "terminal_host_key_openssh", "terminal_private_key_ciphertext_b64", "terminal_private_key_iv_b64", "terminal_observed_at", "terminal_attached_at", "artifact_writes_sealed", "archive_stage_rank", "created_at", "updated_at") SELECT "id", "execution_id", "vm_id", "ordinal", "runtime_vm_name", "image_digest", "spec_digest", "kino_digest", "cpu_millis", "memory_mib", "disk_mib", "terminal_host", "terminal_port", "terminal_username", "terminal_host_key_openssh", "terminal_private_key_ciphertext_b64", "terminal_private_key_iv_b64", "terminal_observed_at", "terminal_attached_at", "artifact_writes_sealed", "archive_stage_rank", "created_at", "updated_at" FROM `runtime_vms`;--> statement-breakpoint
DROP TABLE `runtime_vms`;--> statement-breakpoint
ALTER TABLE `__new_runtime_vms` RENAME TO `runtime_vms`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_vms_execution_vm_uidx` ON `runtime_vms` (`execution_id`,`vm_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_vms_execution_ordinal_uidx` ON `runtime_vms` (`execution_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_vms_execution_name_uidx` ON `runtime_vms` (`execution_id`,`runtime_vm_name`);--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
