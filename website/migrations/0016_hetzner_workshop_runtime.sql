ALTER TABLE `runtime_executions`
ADD COLUMN `provider_kind` text NOT NULL DEFAULT 'agent_kvm';
--> statement-breakpoint
ALTER TABLE `runtime_executions`
ADD COLUMN `provider_connection_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_artifacts_terminal_recording_content_uidx`
ON `runtime_artifacts` (`runtime_vm_id`, `kind`, `sha256`, `size_bytes`)
WHERE `kind` = 'terminal_recording';
--> statement-breakpoint
CREATE TRIGGER `runtime_executions_provider_identity_insert_guard`
BEFORE INSERT ON `runtime_executions`
WHEN NOT (
	(NEW.`provider_kind` = 'agent_kvm' AND NEW.`provider_connection_id` IS NULL)
	OR (
		NEW.`provider_kind` = 'hetzner_cloud'
		AND NEW.`domain_kind` = 'workshop'
		AND NEW.`provider_connection_id` IS NOT NULL
		AND NEW.`host_id` IS NULL
	)
)
BEGIN
	SELECT RAISE(ABORT, 'invalid runtime provider identity');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_executions_provider_identity_update_guard`
BEFORE UPDATE OF `provider_kind`, `provider_connection_id`, `domain_kind`, `host_id`
ON `runtime_executions`
WHEN NOT (
	(NEW.`provider_kind` = 'agent_kvm' AND NEW.`provider_connection_id` IS NULL)
	OR (
		NEW.`provider_kind` = 'hetzner_cloud'
		AND NEW.`domain_kind` = 'workshop'
		AND NEW.`provider_connection_id` IS NOT NULL
		AND NEW.`host_id` IS NULL
	)
)
BEGIN
	SELECT RAISE(ABORT, 'invalid runtime provider identity');
END;
--> statement-breakpoint
CREATE TABLE `organization_provider_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider_kind` text NOT NULL,
	`display_name` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`project_fingerprint` text NOT NULL,
	`sentinel_firewall_id` text NOT NULL,
	`active_credential_version_id` text,
	`approved_locations_json` text DEFAULT '["nbg1","fsn1","hel1"]' NOT NULL,
	`max_concurrent_servers` integer DEFAULT 5 NOT NULL,
	`max_session_gross_micros` integer,
	`currency` text NOT NULL,
	`ipv4_enabled` integer DEFAULT true NOT NULL,
	`last_validated_at` integer NOT NULL,
	`cleanup_acknowledged_at` integer,
	`cleanup_acknowledged_by` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`cleanup_acknowledged_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `organization_provider_connections_kind_valid` CHECK (`provider_kind` = 'hetzner_cloud'),
	CONSTRAINT `organization_provider_connections_state_valid` CHECK (`state` in ('active', 'rotation_required', 'cleanup_pending', 'disconnected')),
	CONSTRAINT `organization_provider_connections_locations_json_valid` CHECK (json_valid(`approved_locations_json`)),
	CONSTRAINT `organization_provider_connections_server_limit_valid` CHECK (`max_concurrent_servers` > 0),
	CONSTRAINT `organization_provider_connections_cost_limit_valid` CHECK (`max_session_gross_micros` is null OR `max_session_gross_micros` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_provider_connections_org_provider_uidx`
ON `organization_provider_connections` (`organization_id`, `provider_kind`);
--> statement-breakpoint
CREATE INDEX `organization_provider_connections_state_idx`
ON `organization_provider_connections` (`state`, `updated_at`);
--> statement-breakpoint
CREATE TRIGGER `runtime_executions_provider_connection_insert_guard`
BEFORE INSERT ON `runtime_executions`
WHEN NEW.`provider_kind` = 'hetzner_cloud' AND NOT EXISTS (
	SELECT 1
	FROM `organization_provider_connections` connection
	WHERE connection.`id` = NEW.`provider_connection_id`
		AND connection.`organization_id` = NEW.`organization_id`
		AND connection.`provider_kind` = 'hetzner_cloud'
)
BEGIN
	SELECT RAISE(ABORT, 'runtime provider connection belongs to another organization');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_executions_provider_connection_update_guard`
BEFORE UPDATE OF `provider_kind`, `provider_connection_id`, `organization_id`
ON `runtime_executions`
WHEN NEW.`provider_kind` = 'hetzner_cloud' AND NOT EXISTS (
	SELECT 1
	FROM `organization_provider_connections` connection
	WHERE connection.`id` = NEW.`provider_connection_id`
		AND connection.`organization_id` = NEW.`organization_id`
		AND connection.`provider_kind` = 'hetzner_cloud'
)
BEGIN
	SELECT RAISE(ABORT, 'runtime provider connection belongs to another organization');
END;
--> statement-breakpoint
CREATE TABLE `provider_credential_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`version` integer NOT NULL,
	`algorithm` text NOT NULL,
	`kek_version` text NOT NULL,
	`aad_sha256` text NOT NULL,
	`encrypted_token_b64` text NOT NULL,
	`token_iv_b64` text NOT NULL,
	`wrapped_dek_b64` text NOT NULL,
	`dek_iv_b64` text NOT NULL,
	`envelope_created_at` integer NOT NULL,
	`token_fingerprint` text NOT NULL,
	`created_by` text NOT NULL,
	`activated_at` integer NOT NULL,
	`superseded_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `organization_provider_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `provider_credential_versions_version_positive` CHECK (`version` > 0 AND `algorithm` = 'AES-256-GCM' AND length(`kek_version`) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_credential_versions_connection_version_uidx`
ON `provider_credential_versions` (`connection_id`, `version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_credential_versions_token_fingerprint_uidx`
ON `provider_credential_versions` (`connection_id`, `token_fingerprint`);
--> statement-breakpoint
CREATE TABLE `provider_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`connection_id` text,
	`actor_user_id` text,
	`type` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`connection_id`) REFERENCES `organization_provider_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `provider_audit_events_payload_json_valid` CHECK (json_valid(`payload_json`))
);
--> statement-breakpoint
CREATE INDEX `provider_audit_events_org_created_idx`
ON `provider_audit_events` (`organization_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `provider_audit_events_connection_created_idx`
ON `provider_audit_events` (`connection_id`, `created_at`);
--> statement-breakpoint
CREATE TRIGGER `provider_audit_events_append_only_update`
BEFORE UPDATE ON `provider_audit_events`
BEGIN
	SELECT RAISE(ABORT, 'provider audit events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `provider_audit_events_append_only_delete`
BEFORE DELETE ON `provider_audit_events`
BEGIN
	SELECT RAISE(ABORT, 'provider audit events are append-only');
END;
--> statement-breakpoint
CREATE TABLE `workshop_session_runtime_providers` (
	`session_id` text PRIMARY KEY NOT NULL,
	`provider_kind` text DEFAULT 'agent_kvm' NOT NULL,
	`connection_id` text,
	`server_type` text,
	`hardware_json` text,
	`permitted_locations_json` text DEFAULT '[]' NOT NULL,
	`initial_price_observation_json` text,
	`gross_ceiling_override_at` integer,
	`gross_ceiling_override_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `organization_provider_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`gross_ceiling_override_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_session_runtime_providers_kind_valid` CHECK (`provider_kind` in ('agent_kvm', 'hetzner_cloud')),
	CONSTRAINT `workshop_session_runtime_providers_shape_valid` CHECK ((`provider_kind` = 'agent_kvm' AND `connection_id` is null AND `server_type` is null AND `hardware_json` is null) OR (`provider_kind` = 'hetzner_cloud' AND `connection_id` is not null AND `server_type` is not null AND json_valid(`hardware_json`))),
	CONSTRAINT `workshop_session_runtime_providers_locations_json_valid` CHECK (json_valid(`permitted_locations_json`))
);
--> statement-breakpoint
CREATE INDEX `workshop_session_runtime_providers_connection_idx`
ON `workshop_session_runtime_providers` (`connection_id`, `provider_kind`);
--> statement-breakpoint
CREATE TRIGGER `workshop_session_runtime_provider_org_insert_guard`
BEFORE INSERT ON `workshop_session_runtime_providers`
WHEN NEW.`provider_kind` = 'hetzner_cloud' AND NOT EXISTS (
	SELECT 1
	FROM `workshop_sessions` session
	INNER JOIN `organization_provider_connections` connection
		ON connection.`id` = NEW.`connection_id`
	WHERE session.`id` = NEW.`session_id`
		AND connection.`organization_id` = session.`organization_id`
)
BEGIN
	SELECT RAISE(ABORT, 'workshop provider connection belongs to another organization');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_runtime_provider_org_update_guard`
BEFORE UPDATE OF `provider_kind`, `connection_id`, `session_id`
ON `workshop_session_runtime_providers`
WHEN NEW.`provider_kind` = 'hetzner_cloud' AND NOT EXISTS (
	SELECT 1
	FROM `workshop_sessions` session
	INNER JOIN `organization_provider_connections` connection
		ON connection.`id` = NEW.`connection_id`
	WHERE session.`id` = NEW.`session_id`
		AND connection.`organization_id` = session.`organization_id`
)
BEGIN
	SELECT RAISE(ABORT, 'workshop provider connection belongs to another organization');
END;
--> statement-breakpoint
CREATE TABLE `runtime_provider_checkpoint_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`template_revision_id` text NOT NULL,
	`checkpoint_id` text NOT NULL,
	`provider_kind` text NOT NULL,
	`r2_key` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`compression` text DEFAULT 'zstd' NOT NULL,
	`signature_b64` text NOT NULL,
	`signing_key_id` text NOT NULL,
	`status` text NOT NULL,
	`cold_boot_verified_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`template_revision_id`) REFERENCES `workshop_template_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `runtime_provider_checkpoint_kind_valid` CHECK (`provider_kind` = 'hetzner_cloud'),
	CONSTRAINT `runtime_provider_checkpoint_status_valid` CHECK (`status` in ('pending', 'verified')),
	CONSTRAINT `runtime_provider_checkpoint_payload_valid` CHECK (`size_bytes` > 0 AND length(`sha256`) = 64 AND `compression` in ('none', 'gzip', 'zstd'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_checkpoint_revision_checkpoint_uidx`
ON `runtime_provider_checkpoint_artifacts` (`template_revision_id`, `checkpoint_id`, `provider_kind`);
--> statement-breakpoint
CREATE TRIGGER `runtime_provider_checkpoint_artifacts_immutable_update`
BEFORE UPDATE ON `runtime_provider_checkpoint_artifacts`
BEGIN
	SELECT RAISE(ABORT, 'runtime provider checkpoint artifacts are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_provider_checkpoint_artifacts_immutable_delete`
BEFORE DELETE ON `runtime_provider_checkpoint_artifacts`
BEGIN
	SELECT RAISE(ABORT, 'runtime provider checkpoint artifacts are immutable');
END;
--> statement-breakpoint
CREATE TABLE `runtime_provider_guest_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`generation` integer NOT NULL,
	`control_plane_base_url` text NOT NULL,
	`bootstrap_token_hash` text NOT NULL,
	`bootstrap_expires_at` integer NOT NULL,
	`bootstrap_consumed_at` integer,
	`report_credential_hash` text,
	`report_credential_issued_at` integer,
	`report_credential_expires_at` integer NOT NULL,
	`report_credential_revoked_at` integer,
	`checkpoint_artifact_id` text NOT NULL,
	`checkpoint_download_token_hash` text,
	`checkpoint_download_expires_at` integer,
	`checkpoint_first_downloaded_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`checkpoint_artifact_id`) REFERENCES `runtime_provider_checkpoint_artifacts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `runtime_provider_guest_credentials_generation_valid` CHECK (`generation` > 0),
	CONSTRAINT `runtime_provider_guest_credentials_lifecycle_valid` CHECK ((`bootstrap_consumed_at` is null AND `report_credential_hash` is null AND `report_credential_issued_at` is null AND `checkpoint_download_token_hash` is null AND `checkpoint_download_expires_at` is null) OR (`bootstrap_consumed_at` is not null AND `report_credential_hash` is not null AND `report_credential_issued_at` is not null AND `checkpoint_download_token_hash` is not null AND `checkpoint_download_expires_at` is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_guest_credentials_execution_uidx`
ON `runtime_provider_guest_credentials` (`execution_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_guest_credentials_bootstrap_hash_uidx`
ON `runtime_provider_guest_credentials` (`bootstrap_token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_guest_credentials_report_hash_uidx`
ON `runtime_provider_guest_credentials` (`report_credential_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_guest_credentials_checkpoint_hash_uidx`
ON `runtime_provider_guest_credentials` (`checkpoint_download_token_hash`);
--> statement-breakpoint
CREATE INDEX `runtime_provider_guest_credentials_report_expiry_idx`
ON `runtime_provider_guest_credentials` (`report_credential_expires_at`, `report_credential_revoked_at`);
--> statement-breakpoint
CREATE TABLE `runtime_provider_artifact_upload_grants` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`generation` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `runtime_artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `runtime_provider_artifact_upload_grants_generation_valid` CHECK (`generation` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_artifact_upload_grants_token_hash_uidx`
ON `runtime_provider_artifact_upload_grants` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `runtime_provider_artifact_upload_grants_execution_expiry_idx`
ON `runtime_provider_artifact_upload_grants` (`execution_id`, `expires_at`);
--> statement-breakpoint
CREATE TABLE `hetzner_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`deterministic_name` text NOT NULL,
	`server_id` text,
	`primary_ip_id` text,
	`primary_ipv4` text,
	`ssh_key_id` text,
	`create_action_id` text,
	`delete_action_id` text,
	`server_type` text NOT NULL,
	`system_image` text NOT NULL,
	`location` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`provisioning_attempt_id` text,
	`provisioning_heartbeat_at` integer,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`last_report_sequence` integer DEFAULT 0 NOT NULL,
	`last_report_at` integer,
	`last_error_code` text,
	`recording_drain_requested_at` integer,
	`recording_drain_completed_at` integer,
	`deletion_requested_at` integer,
	`deletion_confirmed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`connection_id`) REFERENCES `organization_provider_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `hetzner_allocations_state_valid` CHECK (`state` in ('pending', 'creating', 'bootstrapping', 'ready', 'degraded', 'rebooting', 'draining', 'deleting', 'deleted', 'cleanup_pending', 'failed')),
	CONSTRAINT `hetzner_allocations_recording_drain_valid` CHECK (`recording_drain_completed_at` IS NULL OR (`recording_drain_requested_at` IS NOT NULL AND `recording_drain_completed_at` >= `recording_drain_requested_at`)),
	CONSTRAINT `hetzner_allocations_retry_valid` CHECK (`retry_count` >= 0 AND `last_report_sequence` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hetzner_allocations_execution_uidx`
ON `hetzner_allocations` (`execution_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `hetzner_allocations_connection_name_uidx`
ON `hetzner_allocations` (`connection_id`, `deterministic_name`);
--> statement-breakpoint
CREATE INDEX `hetzner_allocations_state_updated_idx`
ON `hetzner_allocations` (`state`, `updated_at`);
--> statement-breakpoint
CREATE TRIGGER `hetzner_allocations_provider_identity_insert_guard`
BEFORE INSERT ON `hetzner_allocations`
WHEN NOT EXISTS (
	SELECT 1
	FROM `runtime_executions` execution
	INNER JOIN `organization_provider_connections` connection
		ON connection.`id` = NEW.`connection_id`
	WHERE execution.`id` = NEW.`execution_id`
		AND execution.`provider_kind` = 'hetzner_cloud'
		AND execution.`provider_connection_id` = NEW.`connection_id`
		AND execution.`organization_id` = connection.`organization_id`
)
BEGIN
	SELECT RAISE(ABORT, 'Hetzner allocation provider identity is invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `hetzner_allocations_provider_identity_update_guard`
BEFORE UPDATE OF `execution_id`, `connection_id`
ON `hetzner_allocations`
WHEN NOT EXISTS (
	SELECT 1
	FROM `runtime_executions` execution
	INNER JOIN `organization_provider_connections` connection
		ON connection.`id` = NEW.`connection_id`
	WHERE execution.`id` = NEW.`execution_id`
		AND execution.`provider_kind` = 'hetzner_cloud'
		AND execution.`provider_connection_id` = NEW.`connection_id`
		AND execution.`organization_id` = connection.`organization_id`
)
BEGIN
	SELECT RAISE(ABORT, 'Hetzner allocation provider identity is invalid');
END;
--> statement-breakpoint
CREATE TABLE `runtime_provider_actual_state` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`provider_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`generation` integer NOT NULL,
	`sequence` integer NOT NULL,
	`phase` text NOT NULL,
	`health` text NOT NULL,
	`terminal_ready` integer DEFAULT false NOT NULL,
	`ssh_host_keys_json` text DEFAULT '[]' NOT NULL,
	`probes_json` text DEFAULT '[]' NOT NULL,
	`report_json` text NOT NULL,
	`reported_at` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `runtime_provider_actual_state_kind_valid` CHECK (`provider_kind` in ('agent_kvm', 'hetzner_cloud')),
	CONSTRAINT `runtime_provider_actual_state_sequence_valid` CHECK (`generation` > 0 AND `sequence` >= 0),
	CONSTRAINT `runtime_provider_actual_state_phase_health_valid` CHECK (`phase` in ('bootstrapping', 'applying_checkpoint', 'starting_services', 'ready', 'degraded', 'failed') AND `health` in ('unknown', 'healthy', 'degraded', 'failed')),
	CONSTRAINT `runtime_provider_actual_state_report_json_valid` CHECK (json_valid(`report_json`) AND json_valid(`ssh_host_keys_json`) AND json_valid(`probes_json`))
);
--> statement-breakpoint
CREATE INDEX `runtime_provider_actual_state_source_observed_idx`
ON `runtime_provider_actual_state` (`provider_kind`, `source_id`, `observed_at`);
--> statement-breakpoint
CREATE TABLE `workshop_session_cost_forecasts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`version` integer NOT NULL,
	`connection_id` text NOT NULL,
	`currency` text NOT NULL,
	`participant_count` integer NOT NULL,
	`preferred_location` text NOT NULL,
	`trigger` text NOT NULL,
	`price_observation_json` text NOT NULL,
	`expected_json` text NOT NULL,
	`lease_ceiling_json` text NOT NULL,
	`one_restore_json` text NOT NULL,
	`expected_net_micros` integer NOT NULL,
	`expected_gross_micros` integer NOT NULL,
	`lease_ceiling_net_micros` integer NOT NULL,
	`lease_ceiling_gross_micros` integer NOT NULL,
	`one_restore_net_micros` integer NOT NULL,
	`one_restore_gross_micros` integer NOT NULL,
	`exceeds_gross_ceiling` integer DEFAULT false NOT NULL,
	`assumptions_json` text NOT NULL,
	`exclusions_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `organization_provider_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_session_cost_forecasts_values_valid` CHECK (`version` > 0 AND `participant_count` >= 0 AND `expected_net_micros` >= 0 AND `expected_gross_micros` >= 0 AND `lease_ceiling_net_micros` >= 0 AND `lease_ceiling_gross_micros` >= 0 AND `one_restore_net_micros` >= 0 AND `one_restore_gross_micros` >= 0),
	CONSTRAINT `workshop_session_cost_forecasts_json_valid` CHECK (json_valid(`price_observation_json`) AND json_valid(`expected_json`) AND json_valid(`lease_ceiling_json`) AND json_valid(`one_restore_json`) AND json_valid(`assumptions_json`) AND json_valid(`exclusions_json`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_session_cost_forecasts_version_uidx`
ON `workshop_session_cost_forecasts` (`session_id`, `version`);
--> statement-breakpoint
CREATE INDEX `workshop_session_cost_forecasts_expiry_idx`
ON `workshop_session_cost_forecasts` (`session_id`, `expires_at`);
--> statement-breakpoint
CREATE TRIGGER `workshop_session_cost_forecasts_append_only_update`
BEFORE UPDATE ON `workshop_session_cost_forecasts`
BEGIN
	SELECT RAISE(ABORT, 'workshop cost forecasts are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_cost_forecasts_append_only_delete`
BEFORE DELETE ON `workshop_session_cost_forecasts`
BEGIN
	SELECT RAISE(ABORT, 'workshop cost forecasts are immutable');
END;
--> statement-breakpoint
CREATE TABLE `runtime_provider_cost_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`allocation_id` text NOT NULL,
	`forecast_id` text,
	`provider_resource_id` text NOT NULL,
	`resource_kind` text NOT NULL,
	`resource_type` text NOT NULL,
	`location` text NOT NULL,
	`currency` text NOT NULL,
	`hourly_net_raw` text NOT NULL,
	`hourly_gross_raw` text NOT NULL,
	`hourly_net_micros` integer NOT NULL,
	`hourly_gross_micros` integer NOT NULL,
	`monthly_net_raw` text,
	`monthly_gross_raw` text,
	`monthly_net_micros` integer,
	`monthly_gross_micros` integer,
	`provider_created_at` integer NOT NULL,
	`deletion_confirmed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`allocation_id`) REFERENCES `hetzner_allocations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`forecast_id`) REFERENCES `workshop_session_cost_forecasts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `runtime_provider_cost_ledger_kind_valid` CHECK (`resource_kind` in ('server', 'primary_ipv4')),
	CONSTRAINT `runtime_provider_cost_ledger_values_valid` CHECK (`hourly_net_micros` >= 0 AND `hourly_gross_micros` >= 0 AND (`monthly_net_micros` is null OR `monthly_net_micros` >= 0) AND (`monthly_gross_micros` is null OR `monthly_gross_micros` >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_cost_ledger_resource_uidx`
ON `runtime_provider_cost_ledger` (`allocation_id`, `resource_kind`, `provider_resource_id`);
--> statement-breakpoint
CREATE INDEX `runtime_provider_cost_ledger_execution_idx`
ON `runtime_provider_cost_ledger` (`execution_id`, `provider_created_at`);
--> statement-breakpoint
CREATE TABLE `workshop_session_cost_summaries` (
	`session_id` text PRIMARY KEY NOT NULL,
	`currency` text NOT NULL,
	`final_net_micros` integer,
	`final_gross_micros` integer,
	`forecast_net_variance_micros` integer,
	`forecast_gross_variance_micros` integer,
	`generation_count` integer DEFAULT 0 NOT NULL,
	`restore_count` integer DEFAULT 0 NOT NULL,
	`cleanup_pending_count` integer DEFAULT 0 NOT NULL,
	`manual_cleanup_unverified` integer DEFAULT false NOT NULL,
	`finalized_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workshop_session_cost_summaries_counts_valid` CHECK (`generation_count` >= 0 AND `restore_count` >= 0 AND `cleanup_pending_count` >= 0)
);
--> statement-breakpoint
INSERT INTO `workshop_session_runtime_providers` (
	`session_id`, `provider_kind`, `connection_id`, `server_type`,
	`hardware_json`, `permitted_locations_json`, `created_at`, `updated_at`
)
SELECT `id`, 'agent_kvm', NULL, NULL, NULL, '[]', `created_at`, `updated_at`
FROM `workshop_sessions`;
