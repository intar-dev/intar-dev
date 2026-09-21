PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_agent_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`scope` text,
	`organization_id` text,
	`owner_removal_id` text,
	`owner_removal_completed_at` integer,
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
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_hosts_scope_valid" CHECK("scope" is null OR "scope" in ('personal', 'platform', 'organization')),
	CONSTRAINT "agent_hosts_personal_role_valid" CHECK("scope" is null OR "scope" not in ('personal', 'organization') OR "role" = 'agent'),
	CONSTRAINT "agent_hosts_organization_valid" CHECK(("scope" is 'organization' AND "organization_id" is not null) OR ("scope" is not 'organization' AND "organization_id" is null))
);
--> statement-breakpoint
INSERT INTO `__new_agent_hosts`("id", "user_id", "name", "scope", "organization_id", "owner_removal_id", "owner_removal_completed_at", "credential_generation", "role", "scenario_enabled", "disabled", "connected", "connected_at", "disconnected_at", "last_heartbeat_at", "last_inventory_at", "active_session_id", "last_client_hello_at", "last_server_hello_at", "agent_version", "inventory_json", "created_at", "updated_at") SELECT "id", "user_id", "name", "scope", "organization_id", "owner_removal_id", "owner_removal_completed_at", "credential_generation", "role", "scenario_enabled", "disabled", "connected", "connected_at", "disconnected_at", "last_heartbeat_at", "last_inventory_at", "active_session_id", "last_client_hello_at", "last_server_hello_at", "agent_version", "inventory_json", "created_at", "updated_at" FROM `agent_hosts`;--> statement-breakpoint
DROP TABLE `agent_hosts`;--> statement-breakpoint
ALTER TABLE `__new_agent_hosts` RENAME TO `agent_hosts`;--> statement-breakpoint
CREATE INDEX `agent_hosts_user_idx` ON `agent_hosts` (`user_id`);--> statement-breakpoint
CREATE INDEX `agent_hosts_organization_idx` ON `agent_hosts` (`organization_id`);--> statement-breakpoint
CREATE INDEX `agent_hosts_role_idx` ON `agent_hosts` (`role`,`connected`);--> statement-breakpoint
CREATE INDEX `agent_hosts_connected_idx` ON `agent_hosts` (`connected`,`updated_at`);--> statement-breakpoint
CREATE TABLE `__new_host_enrollments` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`host_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`role` text NOT NULL,
	`source_invite_id` text NOT NULL,
	`source_lease_id` text NOT NULL,
	`granted_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer,
	`credential_hash` text,
	`revoked_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "host_enrollments_scope_valid" CHECK("scope" in ('personal', 'platform', 'organization')),
	CONSTRAINT "host_enrollments_user_managed_role_valid" CHECK("scope" = 'platform' OR "role" = 'agent'),
	CONSTRAINT "host_enrollments_organization_valid" CHECK(("scope" = 'organization' AND "organization_id" is not null) OR ("scope" <> 'organization' AND "organization_id" is null))
);
--> statement-breakpoint
INSERT INTO `__new_host_enrollments`("token_hash", "organization_id", "host_id", "user_id", "name", "scope", "role", "source_invite_id", "source_lease_id", "granted_at", "expires_at", "claimed_at", "credential_hash", "revoked_at") SELECT "token_hash", "organization_id", "host_id", "user_id", "name", "scope", "role", "source_invite_id", "source_lease_id", "granted_at", "expires_at", "claimed_at", "credential_hash", "revoked_at" FROM `host_enrollments`;--> statement-breakpoint
DROP TABLE `host_enrollments`;--> statement-breakpoint
ALTER TABLE `__new_host_enrollments` RENAME TO `host_enrollments`;--> statement-breakpoint
CREATE UNIQUE INDEX `host_enrollments_host_id_unique` ON `host_enrollments` (`host_id`);--> statement-breakpoint
CREATE INDEX `host_enrollments_organization_idx` ON `host_enrollments` (`organization_id`);--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
