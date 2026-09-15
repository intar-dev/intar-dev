PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_host_cpu_reservations` (
	`run_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`cpu_millis` integer NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "host_cpu_reservations_cpu_positive" CHECK("cpu_millis" > 0),
	CONSTRAINT "host_cpu_reservations_state_valid" CHECK("state" in ('pending', 'committed'))
);
--> statement-breakpoint
INSERT INTO `__new_host_cpu_reservations`("run_id", "host_id", "cpu_millis", "state", "expires_at", "created_at", "updated_at") SELECT "run_id", "host_id", "cpu_millis", "state", "expires_at", "created_at", "updated_at" FROM `host_cpu_reservations`;--> statement-breakpoint
DROP TABLE `host_cpu_reservations`;--> statement-breakpoint
ALTER TABLE `__new_host_cpu_reservations` RENAME TO `host_cpu_reservations`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE INDEX `host_cpu_reservations_host_state_idx` ON `host_cpu_reservations` (`host_id`,`state`);--> statement-breakpoint
CREATE INDEX `host_cpu_reservations_pending_expiry_idx` ON `host_cpu_reservations` (`state`,`expires_at`);--> statement-breakpoint
ALTER TABLE `vm_scenario_vms` DROP COLUMN `vcpu_count`;