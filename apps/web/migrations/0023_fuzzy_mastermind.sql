PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_agent_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`scope` text,
	`owner_removal_id` text,
	`credential_generation` integer DEFAULT 0 NOT NULL,
	`role` text DEFAULT 'agent' NOT NULL,
	`scenario_enabled` integer DEFAULT true NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`connected` integer DEFAULT false NOT NULL,
	`connected_at` integer,
	`disconnected_at` integer,
	`last_heartbeat_at` integer,
	`last_inventory_at` integer,
	`active_session_id` text,
	`last_client_hello_at` integer,
	`last_server_hello_at` integer,
	`agent_version` text,
	`inventory_json` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_hosts_scope_valid" CHECK("scope" is null OR "scope" in ('personal', 'platform')),
	CONSTRAINT "agent_hosts_personal_role_valid" CHECK("scope" is null OR "scope" <> 'personal' OR "role" = 'agent')
);
--> statement-breakpoint
INSERT INTO `__new_agent_hosts`("id", "user_id", "name", "scope", "owner_removal_id", "credential_generation", "role", "scenario_enabled", "disabled", "connected", "connected_at", "disconnected_at", "last_heartbeat_at", "last_inventory_at", "active_session_id", "last_client_hello_at", "last_server_hello_at", "agent_version", "inventory_json", "created_at", "updated_at") SELECT "id", "user_id", "name", "scope", "owner_removal_id", "credential_generation", "role", "scenario_enabled", "disabled", "connected", "connected_at", "disconnected_at", "last_heartbeat_at", "last_inventory_at", "active_session_id", "last_client_hello_at", "last_server_hello_at", "agent_version", "inventory_json", "created_at", "updated_at" FROM `agent_hosts`;--> statement-breakpoint
DROP TABLE `agent_hosts`;--> statement-breakpoint
ALTER TABLE `__new_agent_hosts` RENAME TO `agent_hosts`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE INDEX `agent_hosts_user_idx` ON `agent_hosts` (`user_id`);--> statement-breakpoint
CREATE INDEX `agent_hosts_role_idx` ON `agent_hosts` (`role`,`connected`);--> statement-breakpoint
CREATE INDEX `agent_hosts_connected_idx` ON `agent_hosts` (`connected`,`updated_at`);