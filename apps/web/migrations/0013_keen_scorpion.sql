DELETE FROM `runtime_executions` WHERE `domain_kind` <> 'scenario';--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE `gcp_connection_details`;--> statement-breakpoint
DROP TABLE `hetzner_connection_details`;--> statement-breakpoint
DROP TABLE `provider_audit_events`;--> statement-breakpoint
DROP TABLE `provider_connections`;--> statement-breakpoint
DROP TABLE `provider_credential_versions`;--> statement-breakpoint
DROP TABLE `provider_price_line_items`;--> statement-breakpoint
DROP TABLE `provider_price_observations`;--> statement-breakpoint
DROP TABLE `runtime_actual_state`;--> statement-breakpoint
DROP TABLE `runtime_artifact_upload_grants`;--> statement-breakpoint
DROP TABLE `runtime_checkpoint_bundles`;--> statement-breakpoint
DROP TABLE `runtime_guest_credentials`;--> statement-breakpoint
DROP TABLE `runtime_guest_reports`;--> statement-breakpoint
DROP TABLE `runtime_provider_allocations`;--> statement-breakpoint
DROP TABLE `runtime_provider_cost_ledger`;--> statement-breakpoint
DROP TABLE `runtime_provider_operations`;--> statement-breakpoint
DROP TABLE `runtime_provider_reconciliation`;--> statement-breakpoint
DROP TABLE `runtime_provider_resources`;--> statement-breakpoint
DROP TABLE `workshop_assist_grants`;--> statement-breakpoint
DROP TABLE `workshop_events`;--> statement-breakpoint
DROP TABLE `workshop_help_requests`;--> statement-breakpoint
DROP TABLE `workshop_module_progress`;--> statement-breakpoint
DROP TABLE `workshop_publication_checkpoints`;--> statement-breakpoint
DROP TABLE `workshop_publications`;--> statement-breakpoint
DROP TABLE `workshop_registry_tokens`;--> statement-breakpoint
DROP TABLE `workshop_route_issuance_intents`;--> statement-breakpoint
DROP TABLE `workshop_runtime_profile_certifications`;--> statement-breakpoint
DROP TABLE `workshop_runtime_profiles`;--> statement-breakpoint
DROP TABLE `workshop_session_cost_forecast_line_items`;--> statement-breakpoint
DROP TABLE `workshop_session_cost_forecasts`;--> statement-breakpoint
DROP TABLE `workshop_session_cost_summaries`;--> statement-breakpoint
DROP TABLE `workshop_session_members`;--> statement-breakpoint
DROP TABLE `workshop_session_runtime_selections`;--> statement-breakpoint
DROP TABLE `workshop_sessions`;--> statement-breakpoint
DROP TABLE `workshop_template_revisions`;--> statement-breakpoint
DROP TABLE `workshop_templates`;--> statement-breakpoint
DROP TABLE `workshop_workspace_generations`;--> statement-breakpoint
DROP TABLE `workshop_workspaces`;--> statement-breakpoint
CREATE TABLE `__new_runtime_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text,
	`host_id` text,
	`provider_kind` text DEFAULT 'agent_kvm' NOT NULL,
	`provider_connection_id` text,
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
	CONSTRAINT "runtime_executions_domain_kind_valid" CHECK("domain_kind" = 'scenario'),
	CONSTRAINT "runtime_executions_provider_kind_valid" CHECK("provider_kind" = 'agent_kvm'),
	CONSTRAINT "runtime_executions_provider_identity_valid" CHECK("provider_connection_id" is null),
	CONSTRAINT "runtime_executions_generation_positive" CHECK("generation" > 0),
	CONSTRAINT "runtime_executions_state_valid" CHECK("state" in ('queued', 'provisioning', 'ready', 'archiving', 'archived', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_runtime_executions`("id", "user_id", "organization_id", "host_id", "provider_kind", "provider_connection_id", "domain_kind", "domain_id", "generation", "source_execution_id", "checkpoint_id", "state", "lease_expires_at", "archive_requested_at", "ended_at", "created_at", "updated_at") SELECT "id", "user_id", "organization_id", "host_id", "provider_kind", "provider_connection_id", "domain_kind", "domain_id", "generation", "source_execution_id", "checkpoint_id", "state", "lease_expires_at", "archive_requested_at", "ended_at", "created_at", "updated_at" FROM `runtime_executions` WHERE "domain_kind" = 'scenario';--> statement-breakpoint
DROP TABLE `runtime_executions`;--> statement-breakpoint
ALTER TABLE `__new_runtime_executions` RENAME TO `runtime_executions`;--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_executions_domain_generation_uidx` ON `runtime_executions` (`domain_kind`,`domain_id`,`generation`);--> statement-breakpoint
CREATE INDEX `runtime_executions_user_state_idx` ON `runtime_executions` (`user_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `runtime_executions_organization_state_idx` ON `runtime_executions` (`organization_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `runtime_executions_host_state_idx` ON `runtime_executions` (`host_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `runtime_executions_source_idx` ON `runtime_executions` (`source_execution_id`);--> statement-breakpoint
ALTER TABLE `member` DROP COLUMN `workshop_access_revoking_at`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
