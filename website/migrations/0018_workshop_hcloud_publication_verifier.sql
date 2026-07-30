ALTER TABLE `workshop_publications`
ADD COLUMN `provider_verification_state` text;
--> statement-breakpoint
CREATE TRIGGER `workshop_publications_provider_verification_state_insert_guard`
BEFORE INSERT ON `workshop_publications`
WHEN NEW.`provider_verification_state` IS NOT NULL
 AND NEW.`provider_verification_state` NOT IN ('verifying', 'verified', 'failed', 'cleanup_pending')
BEGIN
  SELECT RAISE(ABORT, 'invalid workshop provider verification state');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_publications_provider_verification_state_update_guard`
BEFORE UPDATE OF `provider_verification_state` ON `workshop_publications`
WHEN NEW.`provider_verification_state` IS NOT NULL
 AND NEW.`provider_verification_state` NOT IN ('verifying', 'verified', 'failed', 'cleanup_pending')
BEGIN
  SELECT RAISE(ABORT, 'invalid workshop provider verification state');
END;
--> statement-breakpoint
CREATE TABLE `workshop_publication_provider_checkpoints` (
  `id` text PRIMARY KEY NOT NULL,
  `publication_id` text NOT NULL,
  `checkpoint_id` text NOT NULL,
  `ordinal` integer NOT NULL,
  `covered_module_ids_json` text NOT NULL,
  `expected_probes_json` text NOT NULL,
  `provider_kind` text NOT NULL,
  `connection_id` text NOT NULL,
  `resolved_provider_json` text NOT NULL,
  `permitted_locations_json` text NOT NULL,
  `price_observation_json` text NOT NULL,
  `r2_key` text NOT NULL,
  `sha256` text NOT NULL,
  `size_bytes` integer NOT NULL,
  `compression` text NOT NULL,
  `signature_b64` text NOT NULL,
  `signing_key_id` text NOT NULL,
  `workspace_agent_sha256` text NOT NULL,
  `kino_sha256` text NOT NULL,
  `verification_status` text DEFAULT 'pending' NOT NULL,
  `proof_verified_at` integer,
  `deletion_confirmed_at` integer,
  `error` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`publication_id`) REFERENCES `workshop_publications`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`connection_id`) REFERENCES `organization_provider_connections`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `workshop_publication_provider_kind_valid` CHECK (`provider_kind` = 'hetzner_cloud'),
  CONSTRAINT `workshop_publication_provider_status_valid` CHECK (`verification_status` IN ('pending', 'allocating', 'bootstrapping', 'applying', 'proof_succeeded', 'deleting', 'verified', 'failed', 'cleanup_pending')),
  CONSTRAINT `workshop_publication_provider_artifact_valid` CHECK (`ordinal` >= 0 AND `size_bytes` > 0 AND length(`sha256`) = 64 AND `compression` IN ('none', 'gzip', 'zstd')),
  CONSTRAINT `workshop_publication_provider_guest_tools_valid` CHECK (length(`workspace_agent_sha256`) = 64 AND `workspace_agent_sha256` NOT GLOB '*[^0-9a-f]*' AND length(`kino_sha256`) = 64 AND `kino_sha256` NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT `workshop_publication_provider_json_valid` CHECK (json_valid(`covered_module_ids_json`) AND json_valid(`expected_probes_json`) AND json_valid(`resolved_provider_json`) AND json_valid(`permitted_locations_json`) AND json_valid(`price_observation_json`)),
  CONSTRAINT `workshop_publication_provider_verified_lifecycle` CHECK (`verification_status` != 'verified' OR (`proof_verified_at` IS NOT NULL AND `deletion_confirmed_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_publication_provider_checkpoint_uidx`
ON `workshop_publication_provider_checkpoints` (`publication_id`, `checkpoint_id`);
--> statement-breakpoint
CREATE INDEX `workshop_publication_provider_status_idx`
ON `workshop_publication_provider_checkpoints` (`publication_id`, `verification_status`, `ordinal`);
--> statement-breakpoint
CREATE TABLE `workshop_publication_provider_attempts` (
  `id` text PRIMARY KEY NOT NULL,
  `provider_checkpoint_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `ordinal` integer NOT NULL,
  `deterministic_name` text NOT NULL,
  `server_type` text NOT NULL,
  `system_image` text NOT NULL,
  `location` text NOT NULL,
  `server_id` text,
  `primary_ip_id` text,
  `primary_ipv4` text,
  `ssh_key_id` text,
  `create_action_id` text,
  `delete_action_id` text,
  `state` text DEFAULT 'allocating' NOT NULL,
  `control_plane_base_url` text NOT NULL,
  `bootstrap_token_hash` text NOT NULL,
  `bootstrap_expires_at` integer NOT NULL,
  `bootstrap_consumed_at` integer,
  `report_credential_hash` text,
  `report_credential_issued_at` integer,
  `report_credential_expires_at` integer NOT NULL,
  `report_credential_revoked_at` integer,
  `checkpoint_download_token_hash` text,
  `checkpoint_download_expires_at` integer,
  `checkpoint_first_downloaded_at` integer,
  `last_report_sequence` integer DEFAULT 0 NOT NULL,
  `last_report_phase` text,
  `last_report_health` text,
  `last_report_at` integer,
  `report_json` text,
  `proof_report_sequence` integer,
  `proof_verified_at` integer,
  `deletion_requested_at` integer,
  `deletion_confirmed_at` integer,
  `last_error_code` text,
  `error` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`provider_checkpoint_id`) REFERENCES `workshop_publication_provider_checkpoints`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`connection_id`) REFERENCES `organization_provider_connections`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `workshop_publication_provider_attempt_state_valid` CHECK (`state` IN ('allocating', 'bootstrapping', 'applying', 'proof_succeeded', 'deleting', 'deleted', 'failed', 'cleanup_pending')),
  CONSTRAINT `workshop_publication_provider_attempt_ordinal_valid` CHECK (`ordinal` > 0 AND `last_report_sequence` >= 0),
  CONSTRAINT `workshop_publication_provider_attempt_report_valid` CHECK (`report_json` IS NULL OR json_valid(`report_json`)),
  CONSTRAINT `workshop_publication_provider_attempt_credential_lifecycle` CHECK ((`bootstrap_consumed_at` IS NULL AND `report_credential_hash` IS NULL AND `report_credential_issued_at` IS NULL AND `checkpoint_download_token_hash` IS NULL AND `checkpoint_download_expires_at` IS NULL) OR (`bootstrap_consumed_at` IS NOT NULL AND `report_credential_hash` IS NOT NULL AND `report_credential_issued_at` IS NOT NULL AND `checkpoint_download_token_hash` IS NOT NULL AND `checkpoint_download_expires_at` IS NOT NULL)),
  CONSTRAINT `workshop_publication_provider_attempt_proof_lifecycle` CHECK (`proof_verified_at` IS NULL OR (`proof_report_sequence` IS NOT NULL AND `proof_report_sequence` > 0)),
  CONSTRAINT `workshop_publication_provider_attempt_deletion_lifecycle` CHECK (`deletion_confirmed_at` IS NULL OR (`deletion_requested_at` IS NOT NULL AND `deletion_confirmed_at` >= `deletion_requested_at`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_publication_provider_attempt_ordinal_uidx`
ON `workshop_publication_provider_attempts` (`provider_checkpoint_id`, `ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_publication_provider_attempt_name_uidx`
ON `workshop_publication_provider_attempts` (`connection_id`, `deterministic_name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_publication_provider_attempt_bootstrap_uidx`
ON `workshop_publication_provider_attempts` (`bootstrap_token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_publication_provider_attempt_report_uidx`
ON `workshop_publication_provider_attempts` (`report_credential_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_publication_provider_attempt_download_uidx`
ON `workshop_publication_provider_attempts` (`checkpoint_download_token_hash`);
--> statement-breakpoint
CREATE INDEX `workshop_publication_provider_attempt_state_idx`
ON `workshop_publication_provider_attempts` (`state`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `workshop_publication_provider_cost_ledger` (
  `id` text PRIMARY KEY NOT NULL,
  `attempt_id` text NOT NULL,
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
  FOREIGN KEY (`attempt_id`) REFERENCES `workshop_publication_provider_attempts`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `workshop_publication_provider_cost_kind_valid` CHECK (`resource_kind` IN ('server', 'primary_ipv4')),
  CONSTRAINT `workshop_publication_provider_cost_values_valid` CHECK (`hourly_net_micros` >= 0 AND `hourly_gross_micros` >= 0 AND (`monthly_net_micros` IS NULL OR `monthly_net_micros` >= 0) AND (`monthly_gross_micros` IS NULL OR `monthly_gross_micros` >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_publication_provider_cost_resource_uidx`
ON `workshop_publication_provider_cost_ledger` (`attempt_id`, `resource_kind`, `provider_resource_id`);
--> statement-breakpoint
CREATE INDEX `workshop_publication_provider_cost_attempt_idx`
ON `workshop_publication_provider_cost_ledger` (`attempt_id`, `provider_created_at`);
