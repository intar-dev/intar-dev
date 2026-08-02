-- Clean-slate Intar schema baseline.
--
-- This file is intentionally independent from ../migrations. It initializes
-- a new empty D1 database and is never applied to the rollback database.
-- There are no backfills, compatibility views, or provider-specific learner
-- allocation tables.
PRAGMA foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE `access_allowlist` (
	`github_username` text PRIMARY KEY NOT NULL,
	`approved_by` text,
	`approved_at` integer NOT NULL,
	FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `access_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`github_username` text NOT NULL,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`decided_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `clean_d1_commissioning` (
	`id` text PRIMARY KEY NOT NULL,
	`database_name` text NOT NULL,
	`database_id` text NOT NULL,
	`baseline_sha256` text NOT NULL,
	`source_sha` text NOT NULL,
	`owner_github_login` text NOT NULL,
	`owner_github_id` text NOT NULL,
	`apply_run_id` text NOT NULL,
	`apply_run_attempt` integer NOT NULL,
	`status` text NOT NULL,
	`owner_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `clean_d1_commissioning_singleton` CHECK (`id` = 'first-owner-v1'),
	CONSTRAINT `clean_d1_commissioning_run_attempt` CHECK (`apply_run_attempt` = 1),
	CONSTRAINT `clean_d1_commissioning_status` CHECK (`status` IN ('allowlisted', 'owner_finalized')),
	CONSTRAINT `clean_d1_commissioning_owner_state` CHECK (((`status` = 'allowlisted' AND `owner_user_id` IS NULL) OR (`status` = 'owner_finalized' AND `owner_user_id` IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE `agent_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
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
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, `organization_id` text REFERENCES `organization`(`id`) ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `host_actual_state` (
	`host_id` text PRIMARY KEY NOT NULL,
	`applied_desired_version` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`report_json` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `host_desired_state` (
	`host_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`doc_json` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `image_build_bundles` (
	`rev` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`kino_version` text NOT NULL,
	`meta_json` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
, `organization_id` text REFERENCES `organization`(`id`) ON DELETE restrict);
--> statement-breakpoint
CREATE TABLE `image_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`scenario_id` text NOT NULL,
	`arch` text NOT NULL,
	`rev` text NOT NULL,
	`content_hash` text NOT NULL,
	`kino_version` text NOT NULL,
	`host_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`phase` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`error` text,
	`log_r2_key` text,
	`timings_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, `organization_id` text REFERENCES `organization`(`id`) ON DELETE restrict,
	FOREIGN KEY (`rev`) REFERENCES `image_build_bundles`(`rev`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `jwks` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL, `workshop_access_revoking_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_access_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text,
	`reference_id` text,
	`authorization_code_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`refresh_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`revoked` integer,
	`confirmation` text,
	`scopes` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`refresh_id`) REFERENCES `oauth_refresh_token`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `oauth_client` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text,
	`disabled` integer DEFAULT false NOT NULL,
	`skip_consent` integer,
	`enable_end_session` integer,
	`subject_type` text,
	`scopes` text,
	`user_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`name` text,
	`uri` text,
	`icon` text,
	`contacts` text,
	`tos` text,
	`policy` text,
	`software_id` text,
	`software_version` text,
	`software_statement` text,
	`redirect_uris` text NOT NULL,
	`post_logout_redirect_uris` text,
	`backchannel_logout_uri` text,
	`backchannel_logout_session_required` integer,
	`token_endpoint_auth_method` text,
	`jwks` text,
	`jwks_uri` text,
	`grant_types` text,
	`response_types` text,
	`public` integer DEFAULT false NOT NULL,
	`type` text,
	`require_pkce` integer DEFAULT true NOT NULL,
	`dpop_bound_access_tokens` integer DEFAULT false NOT NULL,
	`reference_id` text,
	`metadata` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_client_assertion` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_client_resource` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`metadata` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `oauth_resource`(`identifier`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_consent` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text,
	`reference_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`scopes` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_refresh_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text NOT NULL,
	`reference_id` text,
	`authorization_code_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`revoked` integer,
	`rotated_at` integer,
	`rotation_replay_response` text,
	`rotation_replay_expires_at` integer,
	`auth_time` integer,
	`confirmation` text,
	`scopes` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_resource` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`name` text NOT NULL,
	`access_token_ttl` integer,
	`refresh_token_ttl` integer,
	`signing_algorithm` text,
	`signing_key_id` text,
	`allowed_scopes` text,
	`custom_claims` text,
	`dpop_bound_access_tokens_required` integer DEFAULT false NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`policy_version` integer DEFAULT 1 NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`created_at` integer NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE TABLE `scenario_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`scenario_id` text NOT NULL,
	`assigned_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scenario_run_artifact_uploads` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`r2_upload_id` text,
	`uploaded_parts_json` text NOT NULL,
	`next_expected_part` integer NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `scenario_run_artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scenario_run_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`vm_id` text NOT NULL,
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
	FOREIGN KEY (`run_id`) REFERENCES `scenario_runs`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scenario_run_probe_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`vm_id` text NOT NULL,
	`runtime_vm_name` text NOT NULL,
	`message_id` text NOT NULL,
	`collection_state` text,
	`collection_error` text,
	`summary_json` text,
	`snapshot_json` text NOT NULL,
	`generated_at` integer,
	`observed_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `scenario_runs`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scenario_run_session_transcripts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`vm_id` text NOT NULL,
	`session_index` integer NOT NULL,
	`transcript` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `scenario_runs`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scenario_run_ssh_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`vm_id` text NOT NULL,
	`runtime_vm_name` text NOT NULL,
	`public_key_openssh` text NOT NULL,
	`private_key_ciphertext_b64` text NOT NULL,
	`private_key_iv_b64` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `scenario_runs`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scenario_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`host_id` text NOT NULL,
	`scenario_id` text NOT NULL,
	`scenario_name` text NOT NULL,
	`title` text NOT NULL,
	`tagline` text NOT NULL,
	`briefing_markdown` text NOT NULL,
	`objectives_json` text NOT NULL,
	`difficulty` text NOT NULL,
	`estimated_minutes` integer NOT NULL,
	`tags_json` text NOT NULL,
	`hints_json` text NOT NULL,
	`solution_markdown` text NOT NULL,
	`revealed_hints_json` text DEFAULT '[]' NOT NULL,
	`solution_revealed_at` integer,
	`solution_assisted` integer DEFAULT false NOT NULL,
	`vm_count` integer NOT NULL,
	`state` text NOT NULL,
	`state_rank` integer NOT NULL,
	`active_key` text,
	`state_json` text NOT NULL,
	`delete_requested_at` integer,
	`solved_at` integer,
	`completed_at` integer,
	`failed_at` integer,
	`hidden_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, `organization_id` text REFERENCES `organization`(`id`) ON DELETE restrict, `runtime_execution_id` text REFERENCES `runtime_executions`(`id`) ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `scenario_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`scenario_id` text NOT NULL,
	`hcl` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, `organization_id` text REFERENCES `organization`(`id`) ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text, `active_organization_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`username` text,
	`display_username` text,
	`role` text,
	`banned` integer DEFAULT false,
	`ban_reason` text,
	`ban_expires` integer
);
--> statement-breakpoint
CREATE TABLE `user_ssh_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text,
	`key_type` text NOT NULL,
	`comment` text,
	`public_key_openssh` text NOT NULL,
	`fingerprint_sha256` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vm_scenario_probes` (
	`id` text PRIMARY KEY NOT NULL,
	`scenario_id` text NOT NULL,
	`scenario_vm_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`title` text,
	`body_markdown` text,
	`hints_json` text NOT NULL,
	`phase` text DEFAULT 'scenario' NOT NULL,
	`kind` text DEFAULT 'probe' NOT NULL,
	FOREIGN KEY (`scenario_id`) REFERENCES `vm_scenarios`(`scenario_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scenario_vm_id`) REFERENCES `vm_scenario_vms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `vm_scenario_vms` (
	`id` text PRIMARY KEY NOT NULL,
	`scenario_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`vm_name` text NOT NULL,
	`image` text NOT NULL,
	`image_key_json` text,
	`image_sha256` text,
	`image_format` text NOT NULL,
	`image_virtual_size_bytes` integer NOT NULL,
	`kernel_sha256` text NOT NULL,
	`initrd_sha256` text NOT NULL,
	`boot_cmdline` text NOT NULL,
	`memory_mib` integer NOT NULL,
	`disk_mib` integer NOT NULL, `cpu_millis` integer DEFAULT 1000 NOT NULL, `vcpu_count` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`scenario_id`) REFERENCES `vm_scenarios`(`scenario_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `vm_scenarios` (
	`scenario_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`description` text NOT NULL,
	`difficulty` text NOT NULL,
	`estimated_minutes` integer NOT NULL,
	`tags_json` text NOT NULL,
	`briefing_markdown` text NOT NULL,
	`solution_markdown` text NOT NULL,
	`hints_json` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`enabled_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
, `organization_id` text REFERENCES `organization`(`id`) ON DELETE restrict);
--> statement-breakpoint
CREATE TABLE `image_build_coordination_locks` (
	`key` text PRIMARY KEY NOT NULL,
	`owner_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `host_cpu_reservations` (
	`run_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`cpu_millis` integer NOT NULL,
	`steady_cpu_millis` integer NOT NULL,
	`boot_cpu_millis` integer NOT NULL,
	`quota_phase` text NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `host_cpu_reservations_cpu_positive` CHECK (`cpu_millis` > 0),
	CONSTRAINT `host_cpu_reservations_quota_positive` CHECK (`steady_cpu_millis` > 0 AND `boot_cpu_millis` >= `steady_cpu_millis`),
	CONSTRAINT `host_cpu_reservations_quota_phase_valid` CHECK (`quota_phase` in ('boot', 'steady')),
	CONSTRAINT `host_cpu_reservations_current_quota_valid` CHECK ((`quota_phase` = 'boot' AND `cpu_millis` = `boot_cpu_millis`) OR (`quota_phase` = 'steady' AND `cpu_millis` = `steady_cpu_millis`)),
	CONSTRAINT `host_cpu_reservations_state_valid` CHECK (`state` in ('pending', 'committed'))
);
--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`inviter_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sso_provider` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`domain` text NOT NULL,
	`oidc_config` text,
	`saml_config` text,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`organization_id` text,
	`domain_verified` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE "agent_bootstrap_tokens" (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scenario_course_catalogs` (
	`scope_key` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`courses_json` text NOT NULL,
	`source_revision` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `scenario_course_catalogs_scope_check` CHECK (
		(`scope_key` = 'public' AND `organization_id` IS NULL)
		OR (`scope_key` = 'organization:' || `organization_id` AND `organization_id` IS NOT NULL)
	),
	CONSTRAINT `scenario_course_catalogs_courses_json_check` CHECK (json_valid(`courses_json`))
);
--> statement-breakpoint
CREATE TABLE `workshop_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`current_revision_id` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `workshop_template_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`revision` integer NOT NULL,
	`source_revision` text NOT NULL,
	`content_hash` text NOT NULL,
	`manifest_json` text NOT NULL,
	`published_by` text NOT NULL,
	`published_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `workshop_templates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`published_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_template_revisions_revision_positive` CHECK (`revision` > 0),
	CONSTRAINT `workshop_template_revisions_manifest_json_valid` CHECK (json_valid(`manifest_json`))
);
--> statement-breakpoint
CREATE TABLE `workshop_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`template_revision_id` text NOT NULL,
	`title` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`scheduled_start_at` integer NOT NULL,
	`lobby_opens_at` integer NOT NULL,
	`current_module_id` text,
	`current_slide_id` text,
	`released_module_ids_json` text DEFAULT '[]' NOT NULL,
	`revealed_hint_ids_json` text DEFAULT '[]' NOT NULL,
	`revealed_solution_module_ids_json` text DEFAULT '[]' NOT NULL,
	`timer_started_at` integer,
	`timer_ends_at` integer,
	`timer_paused_at` integer,
	`timer_remaining_ms` integer,
	`announcement` text,
	`created_by` text NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`cancelled_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, `current_agenda_item_id` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`template_revision_id`) REFERENCES `workshop_template_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_sessions_state_valid` CHECK (`state` IN ('draft', 'lobby', 'live', 'ended', 'cancelled')),
	CONSTRAINT `workshop_sessions_version_positive` CHECK (`version` > 0),
	CONSTRAINT `workshop_sessions_lobby_before_start` CHECK (`lobby_opens_at` <= `scheduled_start_at`),
	CONSTRAINT `workshop_sessions_released_modules_json_valid` CHECK (json_valid(`released_module_ids_json`)),
	CONSTRAINT `workshop_sessions_revealed_hints_json_valid` CHECK (json_valid(`revealed_hint_ids_json`)),
	CONSTRAINT `workshop_sessions_revealed_solutions_json_valid` CHECK (json_valid(`revealed_solution_module_ids_json`))
);
--> statement-breakpoint
CREATE TABLE `workshop_session_members` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`checked_in_at` integer,
	`provision_state` text DEFAULT 'not_ready' NOT NULL,
	`provision_error` text,
	`assigned_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, `last_seen_at` integer, `workspace_enabled` integer DEFAULT 0 NOT NULL
CHECK (`workspace_enabled` IN (0, 1)),
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assigned_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_session_members_role_valid` CHECK (`role` IN ('participant', 'helper', 'facilitator')),
	CONSTRAINT `workshop_session_members_provision_state_valid` CHECK (`provision_state` IN ('not_ready', 'queued', 'provisioning', 'ready', 'failed', 'ended'))
);
--> statement-breakpoint
CREATE TABLE `workshop_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`current_generation_id` text,
	`last_checkpoint_id` text,
	`recovery_message` text,
	`terminal_route_usernames_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`ended_at` integer, `application_route_ids_json` text DEFAULT '[]' NOT NULL CHECK (json_valid(`application_route_ids_json`)),
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_workspaces_state_valid` CHECK (`state` IN ('queued', 'provisioning', 'ready', 'recovering', 'ending', 'ended', 'failed')),
	CONSTRAINT `workshop_workspaces_terminal_routes_json_valid` CHECK (json_valid(`terminal_route_usernames_json`))
);
--> statement-breakpoint
CREATE TABLE `workshop_workspace_generations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`runtime_execution_id` text,
	`checkpoint_id` text,
	`host_id` text,
	`state` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`requested_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`provisioning_started_at` integer,
	`ready_at` integer,
	`archive_requested_at` integer,
	`archived_at` integer,
	`failed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workshop_workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workshop_workspace_generations_ordinal_positive` CHECK (`ordinal` > 0),
	CONSTRAINT `workshop_workspace_generations_state_valid` CHECK (`state` IN ('queued', 'provisioning', 'ready', 'archiving', 'archived', 'failed'))
);
--> statement-breakpoint
CREATE TABLE `workshop_module_progress` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`module_id` text NOT NULL,
	`technical_status` text DEFAULT 'not_started' NOT NULL,
	`current_health` text DEFAULT 'unknown' NOT NULL,
	`explain_back_status` text DEFAULT 'not_required' NOT NULL,
	`revealed_hint_ids_json` text DEFAULT '[]' NOT NULL,
	`started_at` integer,
	`first_verified_at` integer,
	`caught_up_at` integer,
	`explain_back_completed_at` integer,
	`health_observed_at` integer,
	`completed_at` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_module_progress_technical_status_valid` CHECK (`technical_status` IN ('not_started', 'working', 'verified', 'caught_up', 'manually_completed', 'skipped')),
	CONSTRAINT `workshop_module_progress_current_health_valid` CHECK (`current_health` IN ('unknown', 'passing', 'failing')),
	CONSTRAINT `workshop_module_progress_explain_back_status_valid` CHECK (`explain_back_status` IN ('not_required', 'pending', 'completed')),
	CONSTRAINT `workshop_module_progress_revealed_hints_json_valid` CHECK (json_valid(`revealed_hint_ids_json`))
);
--> statement-breakpoint
CREATE TABLE `workshop_help_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`requester_user_id` text NOT NULL,
	`module_id` text,
	`message` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`active_key` text,
	`claimed_by` text,
	`claimed_at` integer,
	`resolved_at` integer,
	`cancelled_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requester_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`claimed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_help_requests_status_valid` CHECK (`status` IN ('open', 'claimed', 'resolved', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE `workshop_assist_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`help_request_id` text NOT NULL,
	`learner_user_id` text NOT NULL,
	`helper_user_id` text NOT NULL,
	`granted_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_by` text,
	`terminal_route_usernames_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workshop_workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`help_request_id`) REFERENCES `workshop_help_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`learner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`helper_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`revoked_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_assist_grants_duration_valid` CHECK (`expires_at` > `granted_at` AND `expires_at` <= `granted_at` + 1800000),
	CONSTRAINT `workshop_assist_grants_terminal_routes_json_valid` CHECK (json_valid(`terminal_route_usernames_json`))
);
--> statement-breakpoint
CREATE TABLE `workshop_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`actor_user_id` text,
	`type` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_events_payload_json_valid` CHECK (json_valid(`payload_json`))
);
--> statement-breakpoint
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
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, `provider_kind` text NOT NULL DEFAULT 'agent_kvm', `provider_connection_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `runtime_executions_domain_kind_valid` CHECK (`domain_kind` IN ('scenario', 'workshop', 'workshop_certification')),
	CONSTRAINT `runtime_executions_generation_positive` CHECK (`generation` > 0),
	CONSTRAINT `runtime_executions_state_valid` CHECK (`state` IN ('queued', 'provisioning', 'ready', 'archiving', 'archived', 'failed'))
);
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
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, `artifact_writes_sealed` integer DEFAULT 0 NOT NULL
  CHECK (`artifact_writes_sealed` IN (0, 1)),
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `runtime_vms_ordinal_valid` CHECK (`ordinal` >= 0),
	CONSTRAINT `runtime_vms_cpu_positive` CHECK (`cpu_millis` > 0),
	CONSTRAINT `runtime_vms_memory_positive` CHECK (`memory_mib` > 0),
	CONSTRAINT `runtime_vms_disk_positive` CHECK (`disk_mib` > 0),
	CONSTRAINT `runtime_vms_terminal_target_complete` CHECK ((`terminal_host` IS NULL AND `terminal_port` IS NULL AND `terminal_username` IS NULL AND `terminal_host_key_openssh` IS NULL AND `terminal_private_key_ciphertext_b64` IS NULL AND `terminal_private_key_iv_b64` IS NULL AND `terminal_observed_at` IS NULL) OR (`terminal_host` IS NOT NULL AND `terminal_port` > 0 AND `terminal_username` IS NOT NULL AND `terminal_host_key_openssh` IS NOT NULL AND `terminal_private_key_ciphertext_b64` IS NOT NULL AND `terminal_private_key_iv_b64` IS NOT NULL AND `terminal_observed_at` IS NOT NULL)),
	CONSTRAINT `runtime_vms_image_key_json_valid` CHECK (json_valid(`image_key_json`))
);
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
CREATE TABLE `active_runtime_slots` (
	`user_id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`acquired_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
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
CREATE TABLE `workshop_registry_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`token_prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_registry_tokens_expiry_valid` CHECK (`expires_at` IS NULL OR `expires_at` > `created_at`)
);
--> statement-breakpoint
CREATE TABLE `workshop_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`workshop_slug` text NOT NULL,
	`content_hash` text NOT NULL,
	`source_r2_key` text NOT NULL,
	`compiled_manifest_json` text NOT NULL,
	`required_checkpoint_ids_json` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`submitted_by` text NOT NULL,
	`registry_token_id` text NOT NULL,
	`builder_host_id` text,
	`published_revision_id` text,
	`error` text,
	`claimed_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`claim_expires_at` integer,
	`runtime_profile_resolutions_json` text DEFAULT '[]' NOT NULL,
	`certification_state` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`registry_token_id`) REFERENCES `workshop_registry_tokens`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`builder_host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`published_revision_id`) REFERENCES `workshop_template_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_publications_status_valid` CHECK (`status` IN ('queued', 'building', 'failed', 'published')),
	CONSTRAINT `workshop_publications_manifest_json_valid` CHECK (json_valid(`compiled_manifest_json`)),
	CONSTRAINT `workshop_publications_checkpoints_json_valid` CHECK (json_valid(`required_checkpoint_ids_json`)),
	CONSTRAINT `workshop_publications_runtime_profiles_json_valid` CHECK (json_valid(`runtime_profile_resolutions_json`)),
	CONSTRAINT `workshop_publications_certification_state_valid` CHECK (`certification_state` IS NULL OR `certification_state` IN ('verifying', 'verified', 'failed', 'cleanup_pending'))
);
--> statement-breakpoint
CREATE TABLE `workshop_publication_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`publication_id` text NOT NULL,
	`checkpoint_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`vm_images_json` text,
	`sanitized` integer DEFAULT false NOT NULL,
	`cold_boot_verified` integer DEFAULT false NOT NULL,
	`error` text,
	`verified_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`publication_id`) REFERENCES `workshop_publications`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workshop_publication_checkpoints_status_valid` CHECK (`status` IN ('pending', 'building', 'verified', 'failed')),
	CONSTRAINT `workshop_publication_checkpoints_images_json_valid` CHECK (`vm_images_json` IS NULL OR json_valid(`vm_images_json`))
);
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
CREATE TABLE `runtime_artifact_uploads` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`r2_upload_id` text,
	`uploaded_parts_json` text DEFAULT '[]' NOT NULL,
	`next_expected_part` integer NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `runtime_artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `runtime_artifact_uploads_next_part_positive` CHECK (`next_expected_part` > 0),
	CONSTRAINT `runtime_artifact_uploads_parts_json_valid` CHECK (json_valid(`uploaded_parts_json`))
);
--> statement-breakpoint
CREATE TABLE `workshop_route_issuance_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`generation_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`route_key` text NOT NULL,
	`alternate_route_key` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`capability_expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workshop_workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`generation_id`) REFERENCES `workshop_workspace_generations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_route_issuance_intents_kind_valid` CHECK (`kind` IN ('terminal', 'application')),
	CONSTRAINT `workshop_route_issuance_intents_state_valid` CHECK (`state` IN ('pending', 'issued', 'cancelled')),
	CONSTRAINT `workshop_route_issuance_intents_expiry_valid` CHECK (`capability_expires_at` >= `created_at`)
);
--> statement-breakpoint
CREATE INDEX `access_allowlist_approved_by_idx` ON `access_allowlist` (`approved_by`);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_requests_username_uidx` ON `access_requests` (`github_username`);
--> statement-breakpoint
CREATE INDEX `access_requests_status_idx` ON `access_requests` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);
--> statement-breakpoint
CREATE INDEX `agent_hosts_user_idx` ON `agent_hosts` (`user_id`);
--> statement-breakpoint
CREATE INDEX `agent_hosts_role_idx` ON `agent_hosts` (`role`,`connected`);
--> statement-breakpoint
CREATE INDEX `agent_hosts_connected_idx` ON `agent_hosts` (`connected`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `host_actual_state_applied_version_idx` ON `host_actual_state` (`applied_desired_version`);
--> statement-breakpoint
CREATE INDEX `host_actual_state_observed_idx` ON `host_actual_state` (`observed_at`);
--> statement-breakpoint
CREATE INDEX `host_desired_state_version_idx` ON `host_desired_state` (`version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_builds_scenario_arch_hash_uidx` ON `image_builds` (`scenario_id`,`arch`,`content_hash`);
--> statement-breakpoint
CREATE INDEX `image_builds_status_idx` ON `image_builds` (`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `image_builds_host_idx` ON `image_builds` (`host_id`,`status`);
--> statement-breakpoint
CREATE INDEX `image_builds_rev_idx` ON `image_builds` (`rev`);
--> statement-breakpoint
CREATE INDEX `member_organizationId_idx` ON `member` (`organization_id`);
--> statement-breakpoint
CREATE INDEX `member_userId_idx` ON `member` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_org_user_uidx` ON `member` (`organization_id`,`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_access_token_token_unique` ON `oauth_access_token` (`token`);
--> statement-breakpoint
CREATE INDEX `oauthAccessToken_clientId_idx` ON `oauth_access_token` (`client_id`);
--> statement-breakpoint
CREATE INDEX `oauthAccessToken_sessionId_idx` ON `oauth_access_token` (`session_id`);
--> statement-breakpoint
CREATE INDEX `oauthAccessToken_userId_idx` ON `oauth_access_token` (`user_id`);
--> statement-breakpoint
CREATE INDEX `oauthAccessToken_referenceId_idx` ON `oauth_access_token` (`reference_id`);
--> statement-breakpoint
CREATE INDEX `oauthAccessToken_authorizationCodeId_idx` ON `oauth_access_token` (`authorization_code_id`);
--> statement-breakpoint
CREATE INDEX `oauthAccessToken_refreshId_idx` ON `oauth_access_token` (`refresh_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_client_client_id_unique` ON `oauth_client` (`client_id`);
--> statement-breakpoint
CREATE INDEX `oauthClient_userId_idx` ON `oauth_client` (`user_id`);
--> statement-breakpoint
CREATE INDEX `oauthClient_referenceId_idx` ON `oauth_client` (`reference_id`);
--> statement-breakpoint
CREATE INDEX `oauthClientResource_clientId_idx` ON `oauth_client_resource` (`client_id`);
--> statement-breakpoint
CREATE INDEX `oauthClientResource_resourceId_idx` ON `oauth_client_resource` (`resource_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauthClientResource_client_resource_uidx` ON `oauth_client_resource` (`client_id`,`resource_id`);
--> statement-breakpoint
CREATE INDEX `oauthConsent_clientId_idx` ON `oauth_consent` (`client_id`);
--> statement-breakpoint
CREATE INDEX `oauthConsent_userId_idx` ON `oauth_consent` (`user_id`);
--> statement-breakpoint
CREATE INDEX `oauthConsent_referenceId_idx` ON `oauth_consent` (`reference_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_refresh_token_token_unique` ON `oauth_refresh_token` (`token`);
--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_clientId_idx` ON `oauth_refresh_token` (`client_id`);
--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_sessionId_idx` ON `oauth_refresh_token` (`session_id`);
--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_userId_idx` ON `oauth_refresh_token` (`user_id`);
--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_referenceId_idx` ON `oauth_refresh_token` (`reference_id`);
--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_authorizationCodeId_idx` ON `oauth_refresh_token` (`authorization_code_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_resource_identifier_unique` ON `oauth_resource` (`identifier`);
--> statement-breakpoint
CREATE INDEX `oauthResource_identifier_idx` ON `oauth_resource` (`identifier`);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_uidx` ON `organization` (`slug`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_assignments_org_scenario_uidx` ON `scenario_assignments` (`organization_id`,`scenario_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_run_artifacts_vm_ordinal_uidx` ON `scenario_run_artifacts` (`vm_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `scenario_run_artifacts_run_idx` ON `scenario_run_artifacts` (`run_id`,`vm_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `scenario_run_artifacts_r2_key_idx` ON `scenario_run_artifacts` (`r2_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_run_probe_snapshots_run_vm_message_uidx` ON `scenario_run_probe_snapshots` (`run_id`,`vm_id`,`message_id`);
--> statement-breakpoint
CREATE INDEX `scenario_run_probe_snapshots_run_vm_idx` ON `scenario_run_probe_snapshots` (`run_id`,`vm_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_run_session_transcripts_session_uidx` ON `scenario_run_session_transcripts` (`run_id`,`vm_id`,`session_index`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_run_ssh_keys_run_vm_uidx` ON `scenario_run_ssh_keys` (`run_id`,`vm_id`);
--> statement-breakpoint
CREATE INDEX `scenario_run_ssh_keys_run_runtime_idx` ON `scenario_run_ssh_keys` (`run_id`,`runtime_vm_name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_runs_active_key_uidx` ON `scenario_runs` (`active_key`);
--> statement-breakpoint
CREATE INDEX `scenario_runs_user_scenario_idx` ON `scenario_runs` (`user_id`,`scenario_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `scenario_runs_host_idx` ON `scenario_runs` (`host_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_sources_scenario_uidx` ON `scenario_sources` (`scenario_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);
--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);
--> statement-breakpoint
CREATE INDEX `user_ssh_keys_user_idx` ON `user_ssh_keys` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_ssh_keys_user_fingerprint_uidx` ON `user_ssh_keys` (`user_id`,`fingerprint_sha256`);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);
--> statement-breakpoint
CREATE UNIQUE INDEX `vm_scenario_probes_vm_ordinal_uidx` ON `vm_scenario_probes` (`scenario_vm_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `vm_scenario_probes_scenario_idx` ON `vm_scenario_probes` (`scenario_id`,`scenario_vm_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `vm_scenario_vms_scenario_ordinal_uidx` ON `vm_scenario_vms` (`scenario_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `vm_scenario_vms_scenario_name_uidx` ON `vm_scenario_vms` (`scenario_id`,`vm_name`);
--> statement-breakpoint
CREATE INDEX `vm_scenario_vms_scenario_idx` ON `vm_scenario_vms` (`scenario_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `vm_scenarios_enabled_idx` ON `vm_scenarios` (`enabled`,`enabled_at`);
--> statement-breakpoint
CREATE INDEX `image_build_coordination_locks_expiry_idx` ON `image_build_coordination_locks` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `host_cpu_reservations_host_state_idx` ON `host_cpu_reservations` (`host_id`,`state`);
--> statement-breakpoint
CREATE INDEX `host_cpu_reservations_pending_expiry_idx` ON `host_cpu_reservations` (`state`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `invitation_organizationId_idx` ON `invitation` (`organization_id`);
--> statement-breakpoint
CREATE INDEX `invitation_email_idx` ON `invitation` (`email`);
--> statement-breakpoint
CREATE INDEX `invitation_status_idx` ON `invitation` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `sso_provider_provider_id_uidx` ON `sso_provider` (`provider_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `sso_provider_organization_id_uidx` ON `sso_provider` (`organization_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `sso_provider_domain_uidx` ON `sso_provider` (`domain`);
--> statement-breakpoint
CREATE INDEX `sso_provider_user_id_idx` ON `sso_provider` (`user_id`);
--> statement-breakpoint
CREATE INDEX `scenario_sources_organization_idx` ON `scenario_sources` (`organization_id`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `vm_scenarios_organization_enabled_idx` ON `vm_scenarios` (`organization_id`, `enabled`, `enabled_at`);
--> statement-breakpoint
CREATE INDEX `image_build_bundles_organization_idx` ON `image_build_bundles` (`organization_id`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `image_builds_organization_idx` ON `image_builds` (`organization_id`, `status`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `scenario_runs_organization_idx` ON `scenario_runs` (`organization_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `agent_hosts_organization_idx` ON `agent_hosts` (`organization_id`, `role`, `connected`);
--> statement-breakpoint
CREATE INDEX `agent_bootstrap_tokens_host_idx` ON `agent_bootstrap_tokens` (`host_id`);
--> statement-breakpoint
CREATE INDEX `agent_bootstrap_tokens_hash_idx` ON `agent_bootstrap_tokens` (`token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_course_catalogs_organization_uidx`
	ON `scenario_course_catalogs` (`organization_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_templates_org_slug_uidx` ON `workshop_templates` (`organization_id`, `slug`);
--> statement-breakpoint
CREATE INDEX `workshop_templates_org_updated_idx` ON `workshop_templates` (`organization_id`, `updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_template_revisions_number_uidx` ON `workshop_template_revisions` (`template_id`, `revision`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_template_revisions_content_uidx` ON `workshop_template_revisions` (`template_id`, `content_hash`);
--> statement-breakpoint
CREATE INDEX `workshop_template_revisions_template_published_idx` ON `workshop_template_revisions` (`template_id`, `published_at`);
--> statement-breakpoint
CREATE INDEX `workshop_sessions_org_state_start_idx` ON `workshop_sessions` (`organization_id`, `state`, `scheduled_start_at`);
--> statement-breakpoint
CREATE INDEX `workshop_sessions_revision_idx` ON `workshop_sessions` (`template_revision_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_session_members_session_user_uidx` ON `workshop_session_members` (`session_id`, `user_id`);
--> statement-breakpoint
CREATE INDEX `workshop_session_members_session_role_idx` ON `workshop_session_members` (`session_id`, `role`, `provision_state`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_workspaces_session_user_uidx` ON `workshop_workspaces` (`session_id`, `user_id`);
--> statement-breakpoint
CREATE INDEX `workshop_workspaces_session_state_idx` ON `workshop_workspaces` (`session_id`, `state`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_workspace_generations_ordinal_uidx` ON `workshop_workspace_generations` (`workspace_id`, `ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_workspace_generations_execution_uidx` ON `workshop_workspace_generations` (`runtime_execution_id`);
--> statement-breakpoint
CREATE INDEX `workshop_workspace_generations_workspace_state_idx` ON `workshop_workspace_generations` (`workspace_id`, `state`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_module_progress_session_user_module_uidx` ON `workshop_module_progress` (`session_id`, `user_id`, `module_id`);
--> statement-breakpoint
CREATE INDEX `workshop_module_progress_session_module_idx` ON `workshop_module_progress` (`session_id`, `module_id`, `technical_status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_help_requests_active_key_uidx` ON `workshop_help_requests` (`active_key`);
--> statement-breakpoint
CREATE INDEX `workshop_help_requests_session_status_idx` ON `workshop_help_requests` (`session_id`, `status`, `created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_assist_grants_help_request_uidx` ON `workshop_assist_grants` (`help_request_id`);
--> statement-breakpoint
CREATE INDEX `workshop_assist_grants_helper_expiry_idx` ON `workshop_assist_grants` (`helper_user_id`, `expires_at`);
--> statement-breakpoint
CREATE INDEX `workshop_assist_grants_workspace_expiry_idx` ON `workshop_assist_grants` (`workspace_id`, `expires_at`);
--> statement-breakpoint
CREATE INDEX `workshop_events_session_created_idx` ON `workshop_events` (`session_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `workshop_events_org_created_idx` ON `workshop_events` (`organization_id`, `created_at`);
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
CREATE UNIQUE INDEX `runtime_vms_execution_vm_uidx` ON `runtime_vms` (`execution_id`, `vm_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_vms_execution_ordinal_uidx` ON `runtime_vms` (`execution_id`, `ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_vms_execution_name_uidx` ON `runtime_vms` (`execution_id`, `runtime_vm_name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_artifacts_vm_ordinal_uidx` ON `runtime_artifacts` (`runtime_vm_id`, `ordinal`);
--> statement-breakpoint
CREATE INDEX `runtime_artifacts_execution_idx` ON `runtime_artifacts` (`execution_id`, `runtime_vm_id`, `ordinal`);
--> statement-breakpoint
CREATE INDEX `runtime_artifacts_r2_key_idx` ON `runtime_artifacts` (`r2_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_terminal_sessions_vm_ordinal_uidx` ON `runtime_terminal_sessions` (`runtime_vm_id`, `ordinal`);
--> statement-breakpoint
CREATE INDEX `runtime_terminal_sessions_execution_idx` ON `runtime_terminal_sessions` (`execution_id`, `runtime_vm_id`, `started_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `active_runtime_slots_execution_uidx` ON `active_runtime_slots` (`execution_id`);
--> statement-breakpoint
CREATE INDEX `host_resource_reservations_host_state_idx` ON `host_resource_reservations` (`host_id`, `state`);
--> statement-breakpoint
CREATE INDEX `host_resource_reservations_expiry_idx` ON `host_resource_reservations` (`state`, `expires_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_runs_runtime_execution_uidx` ON `scenario_runs` (`runtime_execution_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_registry_tokens_hash_uidx` ON `workshop_registry_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `workshop_registry_tokens_org_created_idx` ON `workshop_registry_tokens` (`organization_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `workshop_publications_status_created_idx` ON `workshop_publications` (`status`, `created_at`);
--> statement-breakpoint
CREATE INDEX `workshop_publications_builder_status_idx` ON `workshop_publications` (`builder_host_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_publication_checkpoints_uidx` ON `workshop_publication_checkpoints` (`publication_id`, `checkpoint_id`);
--> statement-breakpoint
CREATE INDEX `workshop_publication_checkpoints_status_idx` ON `workshop_publication_checkpoints` (`publication_id`, `status`);
--> statement-breakpoint
CREATE INDEX `runtime_allocation_locks_expiry_idx` ON `runtime_allocation_locks` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `runtime_vm_access_keys_execution_idx` ON `runtime_vm_access_keys` (`execution_id`);
--> statement-breakpoint
CREATE INDEX `runtime_vm_actual_state_execution_idx` ON `runtime_vm_actual_state` (`execution_id`, `phase`);
--> statement-breakpoint
CREATE INDEX `runtime_vm_actual_state_host_observed_idx` ON `runtime_vm_actual_state` (`host_id`, `observed_at`);
--> statement-breakpoint
CREATE INDEX `workshop_publications_claim_lease_idx` ON `workshop_publications` (`status`, `claim_expires_at`, `created_at`);
--> statement-breakpoint
CREATE INDEX `workshop_session_members_session_last_seen_idx` ON `workshop_session_members` (`session_id`, `last_seen_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_route_issuance_intents_route_uidx`
ON `workshop_route_issuance_intents` (`kind`, `route_key`);
--> statement-breakpoint
CREATE INDEX `workshop_route_issuance_intents_member_idx`
ON `workshop_route_issuance_intents` (`organization_id`, `actor_user_id`, `state`, `created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_artifacts_terminal_recording_content_uidx`
ON `runtime_artifacts` (`runtime_vm_id`, `kind`, `sha256`, `size_bytes`)
WHERE `kind` = 'terminal_recording';
--> statement-breakpoint
CREATE INDEX `workshop_session_members_session_workspace_idx`
ON `workshop_session_members` (`session_id`, `workspace_enabled`, `provision_state`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_publications_org_hash_active_uidx`
ON `workshop_publications` (`organization_id`, `content_hash`)
WHERE `status` <> 'failed';
--> statement-breakpoint
CREATE TRIGGER `host_desired_running_vm_requires_active_run_insert`
BEFORE INSERT ON `host_desired_state`
WHEN EXISTS (
	SELECT 1 FROM `agent_hosts`
	WHERE `id` = NEW.`host_id` AND `scenario_enabled` = 0
)
	AND EXISTS (
	SELECT 1
	FROM json_each(NEW.`doc_json`, '$.vms') AS `desired_vm`
	WHERE coalesce(json_extract(`desired_vm`.`value`, '$.desired_phase'), '') = 'running'
		AND NOT EXISTS (
			SELECT 1
			FROM `scenario_runs`
			WHERE `run_id` = coalesce(json_extract(`desired_vm`.`value`, '$.run_id'), '')
				AND `host_id` = NEW.`host_id`
				AND `active_key` IS NOT NULL
				AND `completed_at` IS NULL
				AND `failed_at` IS NULL
		)
)
BEGIN
	SELECT RAISE(ABORT, 'running desired VM requires an active run on the same host');
END;
--> statement-breakpoint
CREATE TRIGGER `host_desired_running_vm_requires_active_run_update`
BEFORE UPDATE OF `doc_json` ON `host_desired_state`
WHEN EXISTS (
	SELECT 1 FROM `agent_hosts`
	WHERE `id` = NEW.`host_id` AND `scenario_enabled` = 0
)
	AND EXISTS (
	SELECT 1
	FROM json_each(NEW.`doc_json`, '$.vms') AS `desired_vm`
	WHERE coalesce(json_extract(`desired_vm`.`value`, '$.desired_phase'), '') = 'running'
		AND NOT EXISTS (
			SELECT 1
			FROM `scenario_runs`
			WHERE `run_id` = coalesce(json_extract(`desired_vm`.`value`, '$.run_id'), '')
				AND `host_id` = NEW.`host_id`
				AND `active_key` IS NOT NULL
				AND `completed_at` IS NULL
				AND `failed_at` IS NULL
		)
)
BEGIN
	SELECT RAISE(ABORT, 'running desired VM requires an active run on the same host');
END;
--> statement-breakpoint
CREATE TRIGGER `member_single_owner_insert_guard`
BEFORE INSERT ON `member`
WHEN NEW.`role` = 'owner' AND EXISTS (
	SELECT 1 FROM `member`
	WHERE `user_id` = NEW.`user_id` AND `role` = 'owner'
)
BEGIN
	SELECT RAISE(ABORT, 'member owner limit reached');
END;
--> statement-breakpoint
CREATE TRIGGER `member_single_owner_update_guard`
BEFORE UPDATE OF `role`, `user_id` ON `member`
WHEN NEW.`role` = 'owner' AND EXISTS (
	SELECT 1 FROM `member`
	WHERE `user_id` = NEW.`user_id`
		AND `role` = 'owner'
		AND `id` <> OLD.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'member owner limit reached');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_template_revisions_immutable`
BEFORE UPDATE ON `workshop_template_revisions`
BEGIN
	SELECT RAISE(ABORT, 'workshop template revisions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_sessions_revision_org_insert_guard`
BEFORE INSERT ON `workshop_sessions`
WHEN NOT EXISTS (
	SELECT 1
	FROM `workshop_template_revisions` r
	JOIN `workshop_templates` t ON t.`id` = r.`template_id`
	WHERE r.`id` = NEW.`template_revision_id`
		AND t.`organization_id` = NEW.`organization_id`
)
BEGIN
	SELECT RAISE(ABORT, 'workshop template revision belongs to another organization');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_sessions_revision_org_update_guard`
BEFORE UPDATE OF `organization_id`, `template_revision_id` ON `workshop_sessions`
WHEN NOT EXISTS (
	SELECT 1
	FROM `workshop_template_revisions` r
	JOIN `workshop_templates` t ON t.`id` = r.`template_id`
	WHERE r.`id` = NEW.`template_revision_id`
		AND t.`organization_id` = NEW.`organization_id`
)
BEGIN
	SELECT RAISE(ABORT, 'workshop template revision belongs to another organization');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_members_org_insert_guard`
BEFORE INSERT ON `workshop_session_members`
WHEN NOT EXISTS (
	SELECT 1
	FROM `workshop_sessions` s
	JOIN `member` m ON m.`organization_id` = s.`organization_id`
	WHERE s.`id` = NEW.`session_id` AND m.`user_id` = NEW.`user_id`
)
BEGIN
	SELECT RAISE(ABORT, 'workshop roster user is not an organization member');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_members_org_update_guard`
BEFORE UPDATE OF `session_id`, `user_id` ON `workshop_session_members`
WHEN NOT EXISTS (
	SELECT 1
	FROM `workshop_sessions` s
	JOIN `member` m ON m.`organization_id` = s.`organization_id`
	WHERE s.`id` = NEW.`session_id` AND m.`user_id` = NEW.`user_id`
)
BEGIN
	SELECT RAISE(ABORT, 'workshop roster user is not an organization member');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_events_append_only_update`
BEFORE UPDATE ON `workshop_events`
BEGIN
	SELECT RAISE(ABORT, 'workshop events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_events_append_only_delete`
BEFORE DELETE ON `workshop_events`
BEGIN
	SELECT RAISE(ABORT, 'workshop events are append-only');
END;
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
--> statement-breakpoint
CREATE TRIGGER `workshop_publications_published_immutable`
BEFORE UPDATE ON `workshop_publications`
WHEN OLD.`status` = 'published'
BEGIN
	SELECT RAISE(ABORT, 'published workshop publication is immutable');
END;
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
--> statement-breakpoint
CREATE TRIGGER `runtime_vms_artifact_seal_monotonic`
BEFORE UPDATE OF `artifact_writes_sealed` ON `runtime_vms`
WHEN OLD.`artifact_writes_sealed` = 1 AND NEW.`artifact_writes_sealed` = 0
BEGIN
	SELECT RAISE(ABORT, 'runtime artifact seal cannot be reopened');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_artifacts_metadata_immutable`
BEFORE UPDATE OF
	`execution_id`, `runtime_vm_id`, `ordinal`, `kind`, `filename`,
	`content_type`, `size_bytes`, `sha256`, `r2_key`, `created_at`
ON `runtime_artifacts`
BEGIN
	SELECT RAISE(ABORT, 'runtime artifact metadata is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_artifacts_status_insert_guard`
BEFORE INSERT ON `runtime_artifacts`
WHEN NEW.`upload_status` NOT IN ('pending', 'uploaded')
	OR (NEW.`upload_status` = 'uploaded' AND NEW.`uploaded_at` IS NULL)
	OR (NEW.`upload_status` = 'pending' AND NEW.`uploaded_at` IS NOT NULL)
BEGIN
	SELECT RAISE(ABORT, 'runtime artifact upload status is invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_artifacts_status_update_guard`
BEFORE UPDATE OF `upload_status`, `uploaded_at` ON `runtime_artifacts`
WHEN NEW.`upload_status` NOT IN ('pending', 'uploaded')
	OR (NEW.`upload_status` = 'uploaded' AND NEW.`uploaded_at` IS NULL)
	OR (NEW.`upload_status` = 'pending' AND NEW.`uploaded_at` IS NOT NULL)
	OR (OLD.`upload_status` = 'uploaded' AND NEW.`upload_status` <> 'uploaded')
BEGIN
	SELECT RAISE(ABORT, 'runtime artifact upload status is invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_members_runtime_insert_guard`
BEFORE INSERT ON `workshop_session_members`
WHEN EXISTS (
	SELECT 1
	FROM `workshop_workspaces` w
	WHERE w.`session_id` = NEW.`session_id`
)
BEGIN
	SELECT RAISE(ABORT, 'workshop roster is immutable after workspace provisioning starts');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_members_runtime_delete_guard`
BEFORE DELETE ON `workshop_session_members`
WHEN EXISTS (
	SELECT 1
	FROM `workshop_workspaces` w
	WHERE w.`session_id` = OLD.`session_id`
)
BEGIN
	SELECT RAISE(ABORT, 'workshop roster is immutable after workspace provisioning starts');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_workspaces_org_member_insert_guard`
BEFORE INSERT ON `workshop_workspaces`
WHEN NOT EXISTS (
	SELECT 1
	FROM `workshop_sessions` session
	JOIN `member` organization_member
		ON organization_member.`organization_id` = session.`organization_id`
	WHERE session.`id` = NEW.`session_id`
		AND organization_member.`user_id` = NEW.`user_id`
		AND organization_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop workspace owner is not an organization member');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_members_org_member_insert_guard`
BEFORE INSERT ON `workshop_session_members`
WHEN NOT EXISTS (
	SELECT 1
	FROM `workshop_sessions` session
	JOIN `member` organization_member
		ON organization_member.`organization_id` = session.`organization_id`
		AND organization_member.`user_id` = NEW.`user_id`
	WHERE session.`id` = NEW.`session_id`
		AND organization_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop roster member is not an active organization member');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_publications_certification_state_insert_guard`
BEFORE INSERT ON `workshop_publications`
WHEN NEW.`certification_state` IS NOT NULL
 AND NEW.`certification_state` NOT IN ('verifying', 'verified', 'failed', 'cleanup_pending')
BEGIN
  SELECT RAISE(ABORT, 'invalid workshop certification state');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_publications_certification_state_update_guard`
BEFORE UPDATE OF `certification_state` ON `workshop_publications`
WHEN NEW.`certification_state` IS NOT NULL
 AND NEW.`certification_state` NOT IN ('verifying', 'verified', 'failed', 'cleanup_pending')
BEGIN
  SELECT RAISE(ABORT, 'invalid workshop certification state');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_members_workspace_normalize_insert`
AFTER INSERT ON `workshop_session_members`
WHEN NEW.`role` = 'participant' AND NEW.`workspace_enabled` = 0
BEGIN
	UPDATE `workshop_session_members`
	SET `workspace_enabled` = 1
	WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_members_workspace_normalize_update`
AFTER UPDATE OF `role`, `workspace_enabled` ON `workshop_session_members`
WHEN NEW.`role` = 'participant' AND NEW.`workspace_enabled` = 0
BEGIN
	UPDATE `workshop_session_members`
	SET `workspace_enabled` = 1
	WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_members_runtime_update_guard`
BEFORE UPDATE OF `session_id`, `user_id`, `role`, `workspace_enabled`
ON `workshop_session_members`
WHEN (
	OLD.`session_id` IS NOT NEW.`session_id`
	OR OLD.`user_id` IS NOT NEW.`user_id`
	OR OLD.`role` IS NOT NEW.`role`
	OR OLD.`workspace_enabled` IS NOT NEW.`workspace_enabled`
) AND EXISTS (
	SELECT 1
	FROM `workshop_workspaces` w
	WHERE w.`session_id` = OLD.`session_id`
		OR w.`session_id` = NEW.`session_id`
)
BEGIN
	SELECT RAISE(ABORT, 'workshop roster is immutable after workspace provisioning starts');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_workspaces_participant_insert_guard`
BEFORE INSERT ON `workshop_workspaces`
WHEN NOT EXISTS (
	SELECT 1 FROM `workshop_session_members` sm
	WHERE sm.`session_id` = NEW.`session_id`
		AND sm.`user_id` = NEW.`user_id`
		AND sm.`workspace_enabled` = 1
)
BEGIN
	SELECT RAISE(ABORT, 'workshop workspace owner is not workspace-enabled');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_module_progress_participant_insert_guard`
BEFORE INSERT ON `workshop_module_progress`
WHEN NOT EXISTS (
	SELECT 1 FROM `workshop_session_members` sm
	WHERE sm.`session_id` = NEW.`session_id`
		AND sm.`user_id` = NEW.`user_id`
		AND sm.`workspace_enabled` = 1
)
BEGIN
	SELECT RAISE(ABORT, 'workshop progress owner is not workspace-enabled');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_executions_workshop_member_insert_guard`
BEFORE INSERT ON `runtime_executions`
WHEN NEW.`domain_kind` = 'workshop' AND NOT EXISTS (
	SELECT 1
	FROM `workshop_workspaces` workspace
	JOIN `workshop_sessions` session ON session.`id` = workspace.`session_id`
	JOIN `workshop_workspace_generations` generation
		ON generation.`workspace_id` = workspace.`id`
		AND generation.`id` = workspace.`current_generation_id`
	JOIN `workshop_session_members` roster
		ON roster.`session_id` = session.`id`
		AND roster.`user_id` = workspace.`user_id`
		AND roster.`workspace_enabled` = 1
	JOIN `member` organization_member
		ON organization_member.`organization_id` = session.`organization_id`
		AND organization_member.`user_id` = workspace.`user_id`
	WHERE workspace.`id` = NEW.`domain_id`
		AND workspace.`user_id` = NEW.`user_id`
		AND session.`organization_id` = NEW.`organization_id`
		AND session.`state` IN ('lobby', 'live')
		AND workspace.`state` NOT IN ('ending', 'ended')
		AND generation.`state` NOT IN ('archiving', 'archived')
		AND organization_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop runtime provisioning is no longer authorized');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_executions_workshop_member_update_guard`
BEFORE UPDATE OF `user_id`, `organization_id`, `domain_kind`, `domain_id`
ON `runtime_executions`
WHEN NEW.`domain_kind` = 'workshop' AND NOT EXISTS (
	SELECT 1
	FROM `workshop_workspaces` workspace
	JOIN `workshop_sessions` session ON session.`id` = workspace.`session_id`
	JOIN `workshop_workspace_generations` generation
		ON generation.`workspace_id` = workspace.`id`
		AND generation.`id` = workspace.`current_generation_id`
	JOIN `workshop_session_members` roster
		ON roster.`session_id` = session.`id`
		AND roster.`user_id` = workspace.`user_id`
		AND roster.`workspace_enabled` = 1
	JOIN `member` organization_member
		ON organization_member.`organization_id` = session.`organization_id`
		AND organization_member.`user_id` = workspace.`user_id`
	WHERE workspace.`id` = NEW.`domain_id`
		AND workspace.`user_id` = NEW.`user_id`
		AND session.`organization_id` = NEW.`organization_id`
		AND session.`state` IN ('lobby', 'live')
		AND workspace.`state` NOT IN ('ending', 'ended')
		AND generation.`state` NOT IN ('archiving', 'archived')
		AND organization_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop runtime provisioning is no longer authorized');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_workspaces_org_member_update_guard`
BEFORE UPDATE OF `session_id`, `user_id` ON `workshop_workspaces`
WHEN NOT EXISTS (
	SELECT 1
	FROM `workshop_sessions` session
	JOIN `member` organization_member
		ON organization_member.`organization_id` = session.`organization_id`
		AND organization_member.`user_id` = NEW.`user_id`
	JOIN `workshop_session_members` roster
		ON roster.`session_id` = session.`id`
		AND roster.`user_id` = NEW.`user_id`
		AND roster.`workspace_enabled` = 1
	WHERE session.`id` = NEW.`session_id`
		AND organization_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop workspace owner is not an active workspace-enabled member');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_workspace_generations_org_member_insert_guard`
BEFORE INSERT ON `workshop_workspace_generations`
WHEN NOT EXISTS (
	SELECT 1
	FROM `workshop_workspaces` workspace
	JOIN `workshop_sessions` session ON session.`id` = workspace.`session_id`
	JOIN `member` organization_member
		ON organization_member.`organization_id` = session.`organization_id`
		AND organization_member.`user_id` = workspace.`user_id`
	JOIN `workshop_session_members` roster
		ON roster.`session_id` = session.`id`
		AND roster.`user_id` = workspace.`user_id`
		AND roster.`workspace_enabled` = 1
	WHERE workspace.`id` = NEW.`workspace_id`
		AND organization_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop generation owner is not an active workspace-enabled member');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_workspace_generations_org_member_update_guard`
BEFORE UPDATE OF `workspace_id` ON `workshop_workspace_generations`
WHEN NOT EXISTS (
	SELECT 1
	FROM `workshop_workspaces` workspace
	JOIN `workshop_sessions` session ON session.`id` = workspace.`session_id`
	JOIN `member` organization_member
		ON organization_member.`organization_id` = session.`organization_id`
		AND organization_member.`user_id` = workspace.`user_id`
	JOIN `workshop_session_members` roster
		ON roster.`session_id` = session.`id`
		AND roster.`user_id` = workspace.`user_id`
		AND roster.`workspace_enabled` = 1
	WHERE workspace.`id` = NEW.`workspace_id`
		AND organization_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop generation owner is not an active workspace-enabled member');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_members_org_member_update_guard`
BEFORE UPDATE OF `session_id`, `user_id`, `role`, `workspace_enabled`
ON `workshop_session_members`
WHEN NOT EXISTS (
	SELECT 1
	FROM `workshop_sessions` session
	JOIN `member` organization_member
		ON organization_member.`organization_id` = session.`organization_id`
		AND organization_member.`user_id` = NEW.`user_id`
	WHERE session.`id` = NEW.`session_id`
		AND organization_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop roster member is not an active organization member');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_help_requests_live_requester_insert_guard`
BEFORE INSERT ON `workshop_help_requests`
WHEN NOT EXISTS (
	SELECT 1
	FROM `workshop_sessions` session
	JOIN `workshop_session_members` requester_roster
		ON requester_roster.`session_id` = session.`id`
		AND requester_roster.`user_id` = NEW.`requester_user_id`
		AND requester_roster.`workspace_enabled` = 1
	JOIN `member` requester_member
		ON requester_member.`organization_id` = session.`organization_id`
		AND requester_member.`user_id` = NEW.`requester_user_id`
	WHERE session.`id` = NEW.`session_id`
		AND session.`state` IN ('lobby', 'live')
		AND requester_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop help requester is no longer authorized');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_help_requests_live_claim_update_guard`
BEFORE UPDATE OF `status`, `claimed_by` ON `workshop_help_requests`
WHEN NEW.`status` = 'claimed' AND NOT EXISTS (
	SELECT 1
	FROM `workshop_sessions` session
	JOIN `workshop_session_members` requester_roster
		ON requester_roster.`session_id` = session.`id`
		AND requester_roster.`user_id` = NEW.`requester_user_id`
		AND requester_roster.`workspace_enabled` = 1
	JOIN `member` requester_member
		ON requester_member.`organization_id` = session.`organization_id`
		AND requester_member.`user_id` = NEW.`requester_user_id`
	JOIN `workshop_session_members` helper_roster
		ON helper_roster.`session_id` = session.`id`
		AND helper_roster.`user_id` = NEW.`claimed_by`
		AND helper_roster.`role` IN ('helper', 'facilitator')
	JOIN `member` helper_member
		ON helper_member.`organization_id` = session.`organization_id`
		AND helper_member.`user_id` = NEW.`claimed_by`
	WHERE session.`id` = NEW.`session_id`
		AND session.`state` IN ('lobby', 'live')
		AND NEW.`requester_user_id` <> NEW.`claimed_by`
		AND requester_member.`workshop_access_revoking_at` IS NULL
		AND helper_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop help claim identities are no longer authorized');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_assist_grants_live_identity_insert_guard`
BEFORE INSERT ON `workshop_assist_grants`
WHEN NOT EXISTS (
	SELECT 1
	FROM `workshop_sessions` session
	JOIN `workshop_workspaces` workspace
		ON workspace.`session_id` = session.`id`
		AND workspace.`id` = NEW.`workspace_id`
		AND workspace.`user_id` = NEW.`learner_user_id`
		AND workspace.`state` = 'ready'
	JOIN `workshop_help_requests` help_request
		ON help_request.`id` = NEW.`help_request_id`
		AND help_request.`session_id` = session.`id`
		AND help_request.`requester_user_id` = NEW.`learner_user_id`
		AND help_request.`status` = 'claimed'
		AND help_request.`claimed_by` = NEW.`helper_user_id`
	JOIN `workshop_session_members` learner_roster
		ON learner_roster.`session_id` = session.`id`
		AND learner_roster.`user_id` = NEW.`learner_user_id`
		AND learner_roster.`workspace_enabled` = 1
	JOIN `member` learner_member
		ON learner_member.`organization_id` = session.`organization_id`
		AND learner_member.`user_id` = NEW.`learner_user_id`
	JOIN `workshop_session_members` helper_roster
		ON helper_roster.`session_id` = session.`id`
		AND helper_roster.`user_id` = NEW.`helper_user_id`
		AND helper_roster.`role` IN ('helper', 'facilitator')
	JOIN `member` helper_member
		ON helper_member.`organization_id` = session.`organization_id`
		AND helper_member.`user_id` = NEW.`helper_user_id`
	WHERE session.`id` = NEW.`session_id`
		AND session.`state` IN ('lobby', 'live')
		AND NEW.`learner_user_id` <> NEW.`helper_user_id`
		AND learner_member.`workshop_access_revoking_at` IS NULL
		AND helper_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop assistance identities are no longer authorized');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_assist_grants_live_identity_update_guard`
BEFORE UPDATE OF `session_id`, `workspace_id`, `help_request_id`, `learner_user_id`, `helper_user_id`
ON `workshop_assist_grants`
WHEN NOT EXISTS (
	SELECT 1
	FROM `workshop_sessions` session
	JOIN `workshop_workspaces` workspace
		ON workspace.`session_id` = session.`id`
		AND workspace.`id` = NEW.`workspace_id`
		AND workspace.`user_id` = NEW.`learner_user_id`
	JOIN `workshop_help_requests` help_request
		ON help_request.`id` = NEW.`help_request_id`
		AND help_request.`session_id` = session.`id`
		AND help_request.`requester_user_id` = NEW.`learner_user_id`
	JOIN `workshop_session_members` learner_roster
		ON learner_roster.`session_id` = session.`id`
		AND learner_roster.`user_id` = NEW.`learner_user_id`
		AND learner_roster.`workspace_enabled` = 1
	JOIN `member` learner_member
		ON learner_member.`organization_id` = session.`organization_id`
		AND learner_member.`user_id` = NEW.`learner_user_id`
	JOIN `workshop_session_members` helper_roster
		ON helper_roster.`session_id` = session.`id`
		AND helper_roster.`user_id` = NEW.`helper_user_id`
		AND helper_roster.`role` IN ('helper', 'facilitator')
	JOIN `member` helper_member
		ON helper_member.`organization_id` = session.`organization_id`
		AND helper_member.`user_id` = NEW.`helper_user_id`
	WHERE session.`id` = NEW.`session_id`
		AND NEW.`learner_user_id` <> NEW.`helper_user_id`
		AND learner_member.`workshop_access_revoking_at` IS NULL
		AND helper_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop assistance identities are no longer authorized');
END;
--> statement-breakpoint
CREATE TABLE `provider_connections` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL,
  `provider_kind` text NOT NULL,
  `display_name` text NOT NULL,
  `state` text DEFAULT 'validating' NOT NULL,
  `external_project_id` text NOT NULL,
  `project_fingerprint` text NOT NULL,
  `active_credential_version_id` text,
  `created_by` text NOT NULL,
  `last_validated_at` integer,
  `disconnected_at` integer,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict,
  FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE restrict,
  CONSTRAINT `provider_connections_kind_valid` CHECK (`provider_kind` IN ('hetzner_cloud', 'gcp_compute')),
  CONSTRAINT `provider_connections_state_valid` CHECK (`state` IN ('validating', 'active', 'rotation_required', 'cleanup_pending', 'disconnected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_connections_org_kind_project_uidx`
  ON `provider_connections` (`organization_id`, `provider_kind`, `external_project_id`);
--> statement-breakpoint
CREATE INDEX `provider_connections_org_state_idx`
  ON `provider_connections` (`organization_id`, `state`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `provider_credential_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `connection_id` text NOT NULL,
  `version` integer NOT NULL,
  `authority` text DEFAULT 'active' NOT NULL,
  `algorithm` text NOT NULL,
  `kek_version` text NOT NULL,
  `aad_sha256` text NOT NULL,
  `encrypted_payload_b64` text NOT NULL,
  `payload_iv_b64` text NOT NULL,
  `wrapped_dek_b64` text NOT NULL,
  `dek_iv_b64` text NOT NULL,
  `credential_fingerprint` text NOT NULL,
  `created_by` text NOT NULL,
  `activated_at` integer NOT NULL,
  `superseded_at` integer,
  `revoked_at` integer,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON DELETE restrict,
  FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE restrict,
  CONSTRAINT `provider_credential_versions_valid` CHECK (`version` > 0 AND `authority` IN ('active', 'cleanup_only') AND `algorithm` = 'AES-256-GCM' AND length(`kek_version`) > 0 AND length(`aad_sha256`) = 64),
  CONSTRAINT `provider_credential_versions_lifecycle_valid` CHECK (`superseded_at` IS NULL OR `superseded_at` >= `activated_at`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_credential_versions_connection_version_uidx`
  ON `provider_credential_versions` (`connection_id`, `version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_credential_versions_connection_fingerprint_uidx`
  ON `provider_credential_versions` (`connection_id`, `credential_fingerprint`);
--> statement-breakpoint
CREATE TRIGGER `provider_connections_active_credential_insert_guard`
BEFORE INSERT ON `provider_connections`
WHEN NEW.`active_credential_version_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `provider_credential_versions` credential
  WHERE credential.`id` = NEW.`active_credential_version_id`
    AND credential.`connection_id` = NEW.`id`
    AND credential.`revoked_at` IS NULL
    AND (NEW.`state` <> 'active' OR credential.`authority` = 'active')
)
BEGIN
  SELECT RAISE(ABORT, 'active credential does not belong to provider connection');
END;
--> statement-breakpoint
CREATE TRIGGER `provider_connections_active_credential_update_guard`
BEFORE UPDATE OF `active_credential_version_id`, `state` ON `provider_connections`
WHEN NEW.`active_credential_version_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `provider_credential_versions` credential
  WHERE credential.`id` = NEW.`active_credential_version_id`
    AND credential.`connection_id` = NEW.`id`
    AND credential.`revoked_at` IS NULL
    AND (NEW.`state` <> 'active' OR credential.`authority` = 'active')
)
BEGIN
  SELECT RAISE(ABORT, 'active credential does not belong to provider connection');
END;
--> statement-breakpoint
CREATE TABLE `provider_audit_events` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL,
  `connection_id` text,
  `actor_user_id` text,
  `type` text NOT NULL,
  `payload_json` text DEFAULT '{}' NOT NULL,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE restrict,
  FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON DELETE restrict,
  FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON DELETE restrict,
  CONSTRAINT `provider_audit_events_payload_valid` CHECK (json_valid(`payload_json`))
);
--> statement-breakpoint
CREATE INDEX `provider_audit_events_org_created_idx`
  ON `provider_audit_events` (`organization_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `provider_audit_events_connection_created_idx`
  ON `provider_audit_events` (`connection_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `hetzner_connection_details` (
  `connection_id` text PRIMARY KEY NOT NULL,
  `sentinel_firewall_id` text NOT NULL,
  `approved_locations_json` text DEFAULT '["nbg1","fsn1","hel1"]' NOT NULL,
  `max_concurrent_allocations` integer DEFAULT 5 NOT NULL,
  `max_session_cost_nanos` integer,
  `native_currency` text NOT NULL,
  `ipv4_enabled` integer DEFAULT 1 NOT NULL,
  `cleanup_acknowledged_at` integer,
  `cleanup_acknowledged_by` text,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON DELETE cascade,
  FOREIGN KEY (`cleanup_acknowledged_by`) REFERENCES `user`(`id`) ON DELETE restrict,
  CONSTRAINT `hetzner_connection_details_locations_valid` CHECK (json_valid(`approved_locations_json`)),
  CONSTRAINT `hetzner_connection_details_limits_valid` CHECK (`max_concurrent_allocations` > 0 AND (`max_session_cost_nanos` IS NULL OR `max_session_cost_nanos` >= 0)),
  CONSTRAINT `hetzner_connection_details_ipv4_required` CHECK (`ipv4_enabled` = 1)
);
--> statement-breakpoint
CREATE TABLE `gcp_connection_details` (
  `connection_id` text PRIMARY KEY NOT NULL,
  `project_number` text NOT NULL,
  `network_name` text NOT NULL,
  `network_self_link` text NOT NULL,
  `subnet_name` text NOT NULL,
  `subnet_self_link` text NOT NULL,
  `subnet_cidr` text NOT NULL,
  `firewall_name` text NOT NULL,
  `firewall_self_link` text NOT NULL,
  `approved_zones_json` text NOT NULL,
  `max_concurrent_allocations` integer DEFAULT 5 NOT NULL,
  `max_session_cost_nanos` integer,
  `cleanup_acknowledged_at` integer,
  `cleanup_acknowledged_by` text,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON DELETE cascade,
  FOREIGN KEY (`cleanup_acknowledged_by`) REFERENCES `user`(`id`) ON DELETE restrict,
  CONSTRAINT `gcp_connection_details_zones_valid` CHECK (json_valid(`approved_zones_json`)),
  CONSTRAINT `gcp_connection_details_limits_valid` CHECK (`max_concurrent_allocations` > 0 AND (`max_session_cost_nanos` IS NULL OR `max_session_cost_nanos` >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gcp_connection_details_project_number_uidx`
  ON `gcp_connection_details` (`project_number`);
--> statement-breakpoint
CREATE TRIGGER `provider_connection_details_hetzner_insert_guard`
BEFORE INSERT ON `hetzner_connection_details`
WHEN NOT EXISTS (
  SELECT 1 FROM `provider_connections` connection
  WHERE connection.`id` = NEW.`connection_id`
    AND connection.`provider_kind` = 'hetzner_cloud'
)
BEGIN
  SELECT RAISE(ABORT, 'Hetzner details require a Hetzner connection');
END;
--> statement-breakpoint
CREATE TRIGGER `provider_connection_details_gcp_insert_guard`
BEFORE INSERT ON `gcp_connection_details`
WHEN NOT EXISTS (
  SELECT 1 FROM `provider_connections` connection
  WHERE connection.`id` = NEW.`connection_id`
    AND connection.`provider_kind` = 'gcp_compute'
)
BEGIN
  SELECT RAISE(ABORT, 'GCP details require a GCP connection');
END;
--> statement-breakpoint
CREATE TABLE `workshop_runtime_profiles` (
  `id` text PRIMARY KEY NOT NULL,
  `template_revision_id` text NOT NULL,
  `profile_id` text NOT NULL,
  `provider_kind` text NOT NULL,
  `vm_id` text NOT NULL,
  `machine_type` text,
  `system_image` text NOT NULL,
  `resolved_image_id` text,
  `root_disk_type` text,
  `architecture` text NOT NULL,
  `cpu_millis` integer NOT NULL,
  `memory_mib` integer NOT NULL,
  `disk_mib` integer NOT NULL,
  `locations_json` text NOT NULL,
  `configuration_json` text DEFAULT '{}' NOT NULL,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`template_revision_id`) REFERENCES `workshop_template_revisions`(`id`) ON DELETE cascade,
  CONSTRAINT `workshop_runtime_profiles_provider_valid` CHECK (`provider_kind` IN ('agent_kvm', 'hetzner_cloud', 'gcp_compute')),
  CONSTRAINT `workshop_runtime_profiles_shape_valid` CHECK (`architecture` = 'x86_64' AND `cpu_millis` > 0 AND `memory_mib` > 0 AND `disk_mib` > 0),
  CONSTRAINT `workshop_runtime_profiles_json_valid` CHECK (json_valid(`locations_json`) AND json_valid(`configuration_json`)),
  CONSTRAINT `workshop_runtime_profiles_provider_fields_valid` CHECK ((`provider_kind` = 'agent_kvm') OR (`machine_type` IS NOT NULL AND `resolved_image_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_runtime_profiles_revision_profile_uidx`
  ON `workshop_runtime_profiles` (`template_revision_id`, `profile_id`);
--> statement-breakpoint
CREATE INDEX `workshop_runtime_profiles_revision_provider_idx`
  ON `workshop_runtime_profiles` (`template_revision_id`, `provider_kind`);
--> statement-breakpoint
CREATE TRIGGER `workshop_runtime_profiles_immutable_update`
BEFORE UPDATE ON `workshop_runtime_profiles`
BEGIN
  SELECT RAISE(ABORT, 'published workshop runtime profiles are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_runtime_profiles_immutable_delete`
BEFORE DELETE ON `workshop_runtime_profiles`
BEGIN
  SELECT RAISE(ABORT, 'published workshop runtime profiles are immutable');
END;
--> statement-breakpoint
CREATE TABLE `workshop_runtime_profile_certifications` (
  `id` text PRIMARY KEY NOT NULL,
  `runtime_profile_id` text NOT NULL,
  `connection_id` text,
  `state` text DEFAULT 'pending' NOT NULL,
  `verifier_allocation_id` text,
  `evidence_json` text DEFAULT '{}' NOT NULL,
  `error_code` text,
  `started_at` integer,
  `verified_at` integer,
  `deletion_confirmed_at` integer,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`runtime_profile_id`) REFERENCES `workshop_runtime_profiles`(`id`) ON DELETE cascade,
  FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON DELETE restrict,
  CONSTRAINT `workshop_runtime_profile_certifications_state_valid` CHECK (`state` IN ('pending', 'verifying', 'verified', 'failed', 'cleanup_pending')),
  CONSTRAINT `workshop_runtime_profile_certifications_evidence_valid` CHECK (json_valid(`evidence_json`)),
  CONSTRAINT `workshop_runtime_profile_certifications_verified_valid` CHECK (`state` != 'verified' OR (`verified_at` IS NOT NULL AND `deletion_confirmed_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_runtime_profile_certifications_profile_uidx`
  ON `workshop_runtime_profile_certifications` (`runtime_profile_id`);
--> statement-breakpoint
CREATE INDEX `workshop_runtime_profile_certifications_state_idx`
  ON `workshop_runtime_profile_certifications` (`state`, `updated_at`);
--> statement-breakpoint
CREATE TRIGGER `workshop_runtime_profile_certifications_identity_insert_guard`
BEFORE INSERT ON `workshop_runtime_profile_certifications`
WHEN NOT EXISTS (
  SELECT 1
  FROM `workshop_runtime_profiles` profile
  JOIN `workshop_template_revisions` revision
    ON revision.`id` = profile.`template_revision_id`
  JOIN `workshop_templates` template ON template.`id` = revision.`template_id`
  LEFT JOIN `provider_connections` connection
    ON connection.`id` = NEW.`connection_id`
  WHERE profile.`id` = NEW.`runtime_profile_id`
    AND (
      (profile.`provider_kind` = 'agent_kvm' AND NEW.`connection_id` IS NULL)
      OR (
        profile.`provider_kind` IN ('hetzner_cloud', 'gcp_compute')
        AND connection.`organization_id` = template.`organization_id`
        AND connection.`provider_kind` = profile.`provider_kind`
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid workshop runtime profile certification identity');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_runtime_profile_certifications_identity_update_guard`
BEFORE UPDATE OF `runtime_profile_id`, `connection_id` ON `workshop_runtime_profile_certifications`
BEGIN
  SELECT RAISE(ABORT, 'workshop runtime profile certification identity is immutable');
END;
--> statement-breakpoint
CREATE TABLE `workshop_session_runtime_selections` (
  `session_id` text PRIMARY KEY NOT NULL,
  `runtime_profile_id` text NOT NULL,
  `profile_id` text NOT NULL,
  `provider_kind` text NOT NULL,
  `connection_id` text,
  `resolved_profile_json` text NOT NULL,
  `gross_ceiling_override_at` integer,
  `gross_ceiling_override_by` text,
  `preflight_requested_seats` integer,
  `preflight_available_seats` integer,
  `preflight_ok` integer,
  `preflight_preferred_location` text,
  `preflight_reasons_json` text DEFAULT '[]' NOT NULL,
  `preflight_checked_at` integer,
  `preflight_expires_at` integer,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON DELETE cascade,
  FOREIGN KEY (`runtime_profile_id`) REFERENCES `workshop_runtime_profiles`(`id`) ON DELETE restrict,
  FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON DELETE restrict,
  FOREIGN KEY (`gross_ceiling_override_by`) REFERENCES `user`(`id`) ON DELETE restrict,
  CONSTRAINT `workshop_session_runtime_selections_provider_valid` CHECK (`provider_kind` IN ('agent_kvm', 'hetzner_cloud', 'gcp_compute')),
  CONSTRAINT `workshop_session_runtime_selections_connection_valid` CHECK ((`provider_kind` = 'agent_kvm' AND `connection_id` IS NULL) OR (`provider_kind` IN ('hetzner_cloud', 'gcp_compute') AND `connection_id` IS NOT NULL)),
  CONSTRAINT `workshop_session_runtime_selections_profile_valid` CHECK (json_valid(`resolved_profile_json`)),
  CONSTRAINT `workshop_session_runtime_selections_preflight_json_valid` CHECK (json_valid(`preflight_reasons_json`)),
  CONSTRAINT `workshop_session_runtime_selections_preflight_valid` CHECK ((`preflight_checked_at` IS NULL AND `preflight_expires_at` IS NULL AND `preflight_requested_seats` IS NULL AND `preflight_available_seats` IS NULL AND `preflight_ok` IS NULL) OR (`preflight_checked_at` IS NOT NULL AND `preflight_expires_at` >= `preflight_checked_at` AND `preflight_requested_seats` >= 0 AND `preflight_available_seats` >= 0 AND `preflight_available_seats` <= `preflight_requested_seats` AND `preflight_ok` IN (0, 1)))
);
--> statement-breakpoint
CREATE INDEX `workshop_session_runtime_selections_connection_idx`
  ON `workshop_session_runtime_selections` (`connection_id`, `provider_kind`);
--> statement-breakpoint
CREATE TRIGGER `workshop_session_runtime_selections_immutable_update`
BEFORE UPDATE OF `session_id`, `runtime_profile_id`, `profile_id`, `provider_kind`, `connection_id`, `resolved_profile_json`
ON `workshop_session_runtime_selections`
BEGIN
  SELECT RAISE(ABORT, 'workshop runtime selection is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_runtime_selections_delete_guard`
BEFORE DELETE ON `workshop_session_runtime_selections`
WHEN EXISTS (
  SELECT 1 FROM `workshop_sessions` session
  WHERE session.`id` = OLD.`session_id` AND session.`state` != 'draft'
)
BEGIN
  SELECT RAISE(ABORT, 'active workshop runtime selection cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_runtime_selections_identity_guard`
BEFORE INSERT ON `workshop_session_runtime_selections`
WHEN NOT EXISTS (
  SELECT 1
  FROM `workshop_sessions` session
  JOIN `workshop_runtime_profiles` profile
    ON profile.`id` = NEW.`runtime_profile_id`
    AND profile.`template_revision_id` = session.`template_revision_id`
    AND profile.`profile_id` = NEW.`profile_id`
    AND profile.`provider_kind` = NEW.`provider_kind`
  LEFT JOIN `provider_connections` connection
    ON connection.`id` = NEW.`connection_id`
  WHERE session.`id` = NEW.`session_id`
    AND (
      (NEW.`provider_kind` = 'agent_kvm' AND connection.`id` IS NULL)
      OR (
        NEW.`provider_kind` IN ('hetzner_cloud', 'gcp_compute')
        AND connection.`organization_id` = session.`organization_id`
        AND connection.`provider_kind` = NEW.`provider_kind`
        AND connection.`state` = 'active'
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid workshop runtime selection');
END;
--> statement-breakpoint
CREATE TABLE `runtime_checkpoint_bundles` (
  `id` text PRIMARY KEY NOT NULL,
  `template_revision_id` text NOT NULL,
  `checkpoint_id` text NOT NULL,
  `format` text NOT NULL,
  `r2_key` text NOT NULL,
  `sha256` text NOT NULL,
  `size_bytes` integer NOT NULL,
  `compression` text NOT NULL,
  `signature_b64` text NOT NULL,
  `signing_key_id` text NOT NULL,
  `workspace_agent_sha256` text NOT NULL,
  `kino_sha256` text NOT NULL,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`template_revision_id`) REFERENCES `workshop_template_revisions`(`id`) ON DELETE cascade,
  CONSTRAINT `runtime_checkpoint_bundles_payload_valid` CHECK (`format` = 'direct_cloud_linux_x86_64_v1' AND `compression` = 'zstd' AND `size_bytes` > 0 AND length(`sha256`) = 64),
  CONSTRAINT `runtime_checkpoint_bundles_tools_valid` CHECK (length(`workspace_agent_sha256`) = 64 AND length(`kino_sha256`) = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_checkpoint_bundles_revision_checkpoint_uidx`
  ON `runtime_checkpoint_bundles` (`template_revision_id`, `checkpoint_id`);
--> statement-breakpoint
CREATE INDEX `runtime_checkpoint_bundles_content_idx`
  ON `runtime_checkpoint_bundles` (`sha256`, `size_bytes`);
--> statement-breakpoint
CREATE TRIGGER `runtime_checkpoint_bundles_immutable_update`
BEFORE UPDATE ON `runtime_checkpoint_bundles`
BEGIN
  SELECT RAISE(ABORT, 'runtime checkpoint bundles are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_checkpoint_bundles_immutable_delete`
BEFORE DELETE ON `runtime_checkpoint_bundles`
BEGIN
  SELECT RAISE(ABORT, 'runtime checkpoint bundles are immutable');
END;
--> statement-breakpoint
CREATE TABLE `runtime_provider_allocations` (
  `id` text PRIMARY KEY NOT NULL,
  `execution_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `runtime_profile_id` text NOT NULL,
  `price_observation_id` text NOT NULL,
  `cost_forecast_id` text,
  `provider_kind` text NOT NULL,
  `deterministic_name` text NOT NULL,
  `machine_type` text NOT NULL,
  `resolved_image_id` text NOT NULL,
  `location_attempts_json` text NOT NULL,
  `location` text NOT NULL,
  `location_attempt` integer DEFAULT 1 NOT NULL,
  `location_attempt_started_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `fallback_pending` integer DEFAULT 0 NOT NULL,
  `state` text DEFAULT 'pending' NOT NULL,
  `external_ipv4` text,
  `retry_count` integer DEFAULT 0 NOT NULL,
  `last_report_sequence` integer DEFAULT 0 NOT NULL,
  `last_report_at` integer,
  `last_error_code` text,
  `recording_drain_requested_at` integer,
  `recording_drain_completed_at` integer,
  `deletion_requested_at` integer,
  `deletion_confirmed_at` integer,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON DELETE restrict,
  FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON DELETE restrict,
  FOREIGN KEY (`runtime_profile_id`) REFERENCES `workshop_runtime_profiles`(`id`) ON DELETE restrict,
  FOREIGN KEY (`price_observation_id`) REFERENCES `provider_price_observations`(`id`) ON DELETE restrict,
  FOREIGN KEY (`cost_forecast_id`) REFERENCES `workshop_session_cost_forecasts`(`id`) ON DELETE restrict,
  CONSTRAINT `runtime_provider_allocations_kind_valid` CHECK (`provider_kind` IN ('hetzner_cloud', 'gcp_compute')),
  CONSTRAINT `runtime_provider_allocations_state_valid` CHECK (`state` IN ('pending', 'creating', 'bootstrapping', 'ready', 'degraded', 'rebooting', 'draining', 'deleting', 'deleted', 'cleanup_pending', 'failed')),
  CONSTRAINT `runtime_provider_allocations_counters_valid` CHECK (`retry_count` >= 0 AND `last_report_sequence` >= 0 AND `location_attempt` > 0),
  CONSTRAINT `runtime_provider_allocations_locations_valid` CHECK (json_valid(`location_attempts_json`) AND json_array_length(`location_attempts_json`) >= `location_attempt` AND json_extract(`location_attempts_json`, '$[' || (`location_attempt` - 1) || ']') = `location`),
  CONSTRAINT `runtime_provider_allocations_drain_valid` CHECK (`recording_drain_completed_at` IS NULL OR (`recording_drain_requested_at` IS NOT NULL AND `recording_drain_completed_at` >= `recording_drain_requested_at`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_allocations_execution_uidx`
  ON `runtime_provider_allocations` (`execution_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_allocations_connection_name_uidx`
  ON `runtime_provider_allocations` (`connection_id`, `deterministic_name`);
--> statement-breakpoint
CREATE INDEX `runtime_provider_allocations_state_updated_idx`
  ON `runtime_provider_allocations` (`provider_kind`, `state`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `runtime_provider_allocations_price_attribution_idx`
  ON `runtime_provider_allocations` (`price_observation_id`, `cost_forecast_id`);
--> statement-breakpoint
CREATE TRIGGER `runtime_provider_allocations_identity_immutable`
BEFORE UPDATE OF `execution_id`, `connection_id`, `runtime_profile_id`, `price_observation_id`, `cost_forecast_id`, `provider_kind`, `deterministic_name`, `machine_type`, `resolved_image_id`, `location_attempts_json`
ON `runtime_provider_allocations`
BEGIN
  SELECT RAISE(ABORT, 'provider allocation identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_provider_allocations_location_advance_guard`
BEFORE UPDATE OF `location`, `location_attempt`
ON `runtime_provider_allocations`
WHEN NEW.`location` != OLD.`location` OR NEW.`location_attempt` != OLD.`location_attempt`
BEGIN
  SELECT CASE WHEN NOT (
    OLD.`fallback_pending` = 1
    AND NEW.`fallback_pending` = 0
    AND NEW.`location_attempt` = OLD.`location_attempt` + 1
    AND NEW.`location` = json_extract(OLD.`location_attempts_json`, '$[' || OLD.`location_attempt` || ']')
    AND NOT EXISTS (
      SELECT 1 FROM `runtime_provider_resources` resource
      WHERE resource.`allocation_id` = OLD.`id`
        AND resource.`location_attempt` = OLD.`location_attempt`
        AND resource.`disappearance_confirmed_at` IS NULL
    )
  ) THEN RAISE(ABORT, 'invalid provider location attempt advance') END;
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_provider_allocations_identity_insert_guard`
BEFORE INSERT ON `runtime_provider_allocations`
WHEN NOT EXISTS (
  SELECT 1
  FROM `runtime_executions` execution
  JOIN `provider_connections` connection
    ON connection.`id` = NEW.`connection_id`
    AND connection.`organization_id` = execution.`organization_id`
    AND connection.`provider_kind` = NEW.`provider_kind`
  JOIN `workshop_runtime_profiles` profile
    ON profile.`id` = NEW.`runtime_profile_id`
    AND profile.`provider_kind` = NEW.`provider_kind`
    AND profile.`machine_type` = NEW.`machine_type`
    AND profile.`resolved_image_id` = NEW.`resolved_image_id`
  JOIN `provider_price_observations` observation
    ON observation.`id` = NEW.`price_observation_id`
    AND observation.`connection_id` = connection.`id`
    AND observation.`runtime_profile_id` = profile.`id`
    AND observation.`provider_kind` = NEW.`provider_kind`
  WHERE execution.`id` = NEW.`execution_id`
    AND execution.`domain_kind` IN ('workshop', 'workshop_certification')
    AND (
      (
        execution.`domain_kind` = 'workshop'
        AND EXISTS (
          SELECT 1
          FROM `workshop_workspaces` workspace
          JOIN `workshop_session_cost_forecasts` forecast
            ON forecast.`id` = NEW.`cost_forecast_id`
            AND forecast.`session_id` = workspace.`session_id`
            AND forecast.`price_observation_id` = observation.`id`
            AND forecast.`provider_kind` = NEW.`provider_kind`
            AND forecast.`currency` = observation.`currency`
          WHERE workspace.`id` = execution.`domain_id`
        )
      )
      OR (
        execution.`domain_kind` = 'workshop_certification'
        AND NEW.`cost_forecast_id` IS NULL
        AND EXISTS (
          SELECT 1
          FROM `workshop_runtime_profile_certifications` certification
          WHERE certification.`id` = execution.`domain_id`
            AND certification.`runtime_profile_id` = profile.`id`
            AND certification.`connection_id` = connection.`id`
        )
      )
    )
    AND execution.`provider_kind` = NEW.`provider_kind`
    AND execution.`provider_connection_id` = NEW.`connection_id`
)
BEGIN
  SELECT RAISE(ABORT, 'invalid provider allocation identity');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_provider_allocations_connection_limit_guard`
BEFORE INSERT ON `runtime_provider_allocations`
WHEN (
  SELECT count(*)
  FROM `runtime_provider_allocations` current
  WHERE current.`connection_id` = NEW.`connection_id`
    AND current.`state` != 'deleted'
) >= COALESCE(
  CASE NEW.`provider_kind`
    WHEN 'hetzner_cloud' THEN (
      SELECT detail.`max_concurrent_allocations`
      FROM `hetzner_connection_details` detail
      WHERE detail.`connection_id` = NEW.`connection_id`
    )
    WHEN 'gcp_compute' THEN (
      SELECT detail.`max_concurrent_allocations`
      FROM `gcp_connection_details` detail
      WHERE detail.`connection_id` = NEW.`connection_id`
    )
  END,
  0
)
BEGIN
  SELECT RAISE(ABORT, 'provider allocation concurrency limit exceeded');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_runtime_profile_certifications_verifier_guard`
BEFORE UPDATE OF `state`, `verifier_allocation_id`, `verified_at`, `deletion_confirmed_at`
ON `workshop_runtime_profile_certifications`
WHEN NEW.`state` = 'verified'
  AND EXISTS (
    SELECT 1 FROM `workshop_runtime_profiles` profile
    WHERE profile.`id` = NEW.`runtime_profile_id`
      AND profile.`provider_kind` IN ('hetzner_cloud', 'gcp_compute')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM `runtime_provider_allocations` allocation
    JOIN `workshop_runtime_profiles` profile
      ON profile.`id` = allocation.`runtime_profile_id`
    WHERE allocation.`id` = NEW.`verifier_allocation_id`
      AND allocation.`runtime_profile_id` = NEW.`runtime_profile_id`
      AND allocation.`connection_id` = NEW.`connection_id`
      AND allocation.`provider_kind` = profile.`provider_kind`
      AND allocation.`state` = 'deleted'
      AND allocation.`deletion_confirmed_at` IS NOT NULL
      AND NEW.`deletion_confirmed_at` = allocation.`deletion_confirmed_at`
  )
BEGIN
  SELECT RAISE(ABORT, 'verified runtime profile requires matching deleted verifier allocation');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_runtime_profile_certifications_verified_insert_guard`
BEFORE INSERT ON `workshop_runtime_profile_certifications`
WHEN NEW.`state` = 'verified' AND EXISTS (
  SELECT 1 FROM `workshop_runtime_profiles` profile
  WHERE profile.`id` = NEW.`runtime_profile_id`
    AND profile.`provider_kind` IN ('hetzner_cloud', 'gcp_compute')
)
BEGIN
  SELECT RAISE(ABORT, 'runtime profile certifications must begin pending for direct-cloud profiles');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_executions_certification_identity_insert_guard`
BEFORE INSERT ON `runtime_executions`
WHEN NEW.`domain_kind` = 'workshop_certification' AND NOT EXISTS (
  SELECT 1
  FROM `workshop_runtime_profile_certifications` certification
  JOIN `workshop_runtime_profiles` profile
    ON profile.`id` = certification.`runtime_profile_id`
  JOIN `workshop_template_revisions` revision
    ON revision.`id` = profile.`template_revision_id`
  JOIN `workshop_templates` template
    ON template.`id` = revision.`template_id`
  WHERE certification.`id` = NEW.`domain_id`
    AND template.`organization_id` = NEW.`organization_id`
    AND revision.`published_by` = NEW.`user_id`
    AND profile.`provider_kind` = NEW.`provider_kind`
)
BEGIN
  SELECT RAISE(ABORT, 'invalid workshop certification execution identity');
END;
--> statement-breakpoint
CREATE TRIGGER `active_runtime_slots_certification_insert_guard`
BEFORE INSERT ON `active_runtime_slots`
WHEN EXISTS (
  SELECT 1 FROM `runtime_executions` execution
  WHERE execution.`id` = NEW.`execution_id`
    AND execution.`domain_kind` = 'workshop_certification'
)
BEGIN
  SELECT RAISE(ABORT, 'workshop certification executions cannot acquire learner slots');
END;
--> statement-breakpoint
CREATE TABLE `runtime_provider_resources` (
  `id` text PRIMARY KEY NOT NULL,
  `allocation_id` text NOT NULL,
  `provider_kind` text NOT NULL,
  `resource_kind` text NOT NULL,
  `provider_resource_id` text NOT NULL,
  `location_attempt` integer NOT NULL,
  `location` text NOT NULL,
  `provider_state` text NOT NULL,
  `configuration_json` text DEFAULT '{}' NOT NULL,
  `provider_created_at` integer,
  `disappearance_confirmed_at` integer,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`allocation_id`) REFERENCES `runtime_provider_allocations`(`id`) ON DELETE restrict,
  CONSTRAINT `runtime_provider_resources_provider_valid` CHECK (`provider_kind` IN ('hetzner_cloud', 'gcp_compute')),
  CONSTRAINT `runtime_provider_resources_kind_valid` CHECK (`resource_kind` IN ('instance', 'boot_disk', 'ipv4', 'ssh_key')),
  CONSTRAINT `runtime_provider_resources_attempt_valid` CHECK (`location_attempt` > 0),
  CONSTRAINT `runtime_provider_resources_configuration_valid` CHECK (json_valid(`configuration_json`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_resources_allocation_kind_uidx`
  ON `runtime_provider_resources` (`allocation_id`, `location_attempt`, `resource_kind`);
--> statement-breakpoint
CREATE INDEX `runtime_provider_resources_external_idx`
  ON `runtime_provider_resources` (`provider_kind`, `resource_kind`, `provider_resource_id`);
--> statement-breakpoint
CREATE INDEX `runtime_provider_resources_allocation_idx`
  ON `runtime_provider_resources` (`allocation_id`, `resource_kind`);
--> statement-breakpoint
CREATE TRIGGER `runtime_provider_resources_identity_insert_guard`
BEFORE INSERT ON `runtime_provider_resources`
WHEN NOT EXISTS (
  SELECT 1 FROM `runtime_provider_allocations` allocation
  WHERE allocation.`id` = NEW.`allocation_id`
    AND allocation.`provider_kind` = NEW.`provider_kind`
    AND allocation.`location_attempt` = NEW.`location_attempt`
    AND allocation.`location` = NEW.`location`
)
BEGIN
  SELECT RAISE(ABORT, 'provider resource kind does not match allocation');
END;
--> statement-breakpoint
CREATE TABLE `runtime_provider_operations` (
  `id` text PRIMARY KEY NOT NULL,
  `allocation_id` text NOT NULL,
  `provider_kind` text NOT NULL,
  `operation_kind` text NOT NULL,
  `location_attempt` integer NOT NULL,
  `provider_operation_id` text,
  `request_id` text NOT NULL,
  `state` text DEFAULT 'pending' NOT NULL,
  `attempt` integer DEFAULT 1 NOT NULL,
  `retry_at` integer,
  `last_polled_at` integer,
  `completed_at` integer,
  `error_class` text,
  `error_code` text,
  `sanitized_result_json` text,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`allocation_id`) REFERENCES `runtime_provider_allocations`(`id`) ON DELETE restrict,
  CONSTRAINT `runtime_provider_operations_provider_valid` CHECK (`provider_kind` IN ('hetzner_cloud', 'gcp_compute')),
  CONSTRAINT `runtime_provider_operations_state_valid` CHECK (`state` IN ('pending', 'running', 'succeeded', 'retryable', 'failed')),
  CONSTRAINT `runtime_provider_operations_attempt_valid` CHECK (`attempt` > 0 AND `location_attempt` > 0),
  CONSTRAINT `runtime_provider_operations_result_valid` CHECK (`sanitized_result_json` IS NULL OR json_valid(`sanitized_result_json`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_operations_request_uidx`
  ON `runtime_provider_operations` (`provider_kind`, `request_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_operations_allocation_external_uidx`
  ON `runtime_provider_operations` (`allocation_id`, `location_attempt`, `provider_operation_id`);
--> statement-breakpoint
CREATE INDEX `runtime_provider_operations_sweep_idx`
  ON `runtime_provider_operations` (`state`, `retry_at`, `updated_at`);
--> statement-breakpoint
CREATE TRIGGER `runtime_provider_operations_identity_insert_guard`
BEFORE INSERT ON `runtime_provider_operations`
WHEN NOT EXISTS (
  SELECT 1 FROM `runtime_provider_allocations` allocation
  WHERE allocation.`id` = NEW.`allocation_id`
    AND allocation.`provider_kind` = NEW.`provider_kind`
    AND allocation.`location_attempt` = NEW.`location_attempt`
)
BEGIN
  SELECT RAISE(ABORT, 'provider operation kind does not match allocation');
END;
--> statement-breakpoint
CREATE TABLE `runtime_provider_reconciliation` (
  `allocation_id` text PRIMARY KEY NOT NULL,
  `desired_state` text NOT NULL,
  `observed_state` text NOT NULL,
  `sweep_after` integer NOT NULL,
  `claim_id` text,
  `claim_expires_at` integer,
  `consecutive_failures` integer DEFAULT 0 NOT NULL,
  `last_reconciled_at` integer,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`allocation_id`) REFERENCES `runtime_provider_allocations`(`id`) ON DELETE cascade,
  CONSTRAINT `runtime_provider_reconciliation_claim_valid` CHECK ((`claim_id` IS NULL AND `claim_expires_at` IS NULL) OR (`claim_id` IS NOT NULL AND `claim_expires_at` IS NOT NULL)),
  CONSTRAINT `runtime_provider_reconciliation_failures_valid` CHECK (`consecutive_failures` >= 0)
);
--> statement-breakpoint
CREATE INDEX `runtime_provider_reconciliation_sweep_idx`
  ON `runtime_provider_reconciliation` (`sweep_after`, `claim_expires_at`);
--> statement-breakpoint
CREATE TRIGGER `runtime_executions_provider_identity_insert_guard`
BEFORE INSERT ON `runtime_executions`
WHEN NOT (
  (NEW.`provider_kind` = 'agent_kvm' AND NEW.`provider_connection_id` IS NULL)
  OR (
    NEW.`provider_kind` IN ('hetzner_cloud', 'gcp_compute')
    AND NEW.`domain_kind` IN ('workshop', 'workshop_certification')
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
    NEW.`provider_kind` IN ('hetzner_cloud', 'gcp_compute')
    AND NEW.`domain_kind` IN ('workshop', 'workshop_certification')
    AND NEW.`provider_connection_id` IS NOT NULL
    AND NEW.`host_id` IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid runtime provider identity');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_executions_provider_connection_insert_guard`
BEFORE INSERT ON `runtime_executions`
WHEN NEW.`provider_kind` IN ('hetzner_cloud', 'gcp_compute') AND NOT EXISTS (
  SELECT 1 FROM `provider_connections` connection
  WHERE connection.`id` = NEW.`provider_connection_id`
    AND connection.`organization_id` = NEW.`organization_id`
    AND connection.`provider_kind` = NEW.`provider_kind`
    AND connection.`state` = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'runtime provider connection belongs to another organization');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_executions_provider_connection_update_guard`
BEFORE UPDATE OF `provider_kind`, `provider_connection_id`, `organization_id`
ON `runtime_executions`
WHEN NEW.`provider_kind` IN ('hetzner_cloud', 'gcp_compute') AND NOT EXISTS (
  SELECT 1 FROM `provider_connections` connection
  WHERE connection.`id` = NEW.`provider_connection_id`
    AND connection.`organization_id` = NEW.`organization_id`
    AND connection.`provider_kind` = NEW.`provider_kind`
    AND connection.`state` = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'runtime provider connection belongs to another organization');
END;
--> statement-breakpoint
CREATE TABLE `runtime_guest_credentials` (
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
  `checkpoint_bundle_id` text NOT NULL,
  `checkpoint_download_token_hash` text,
  `checkpoint_download_expires_at` integer,
  `checkpoint_first_downloaded_at` integer,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON DELETE cascade,
  FOREIGN KEY (`checkpoint_bundle_id`) REFERENCES `runtime_checkpoint_bundles`(`id`) ON DELETE restrict,
  CONSTRAINT `runtime_guest_credentials_generation_valid` CHECK (`generation` > 0),
  CONSTRAINT `runtime_guest_credentials_lifecycle_valid` CHECK ((`bootstrap_consumed_at` IS NULL AND `report_credential_hash` IS NULL AND `report_credential_issued_at` IS NULL AND `checkpoint_download_token_hash` IS NULL AND `checkpoint_download_expires_at` IS NULL) OR (`bootstrap_consumed_at` IS NOT NULL AND `report_credential_hash` IS NOT NULL AND `report_credential_issued_at` IS NOT NULL AND `checkpoint_download_token_hash` IS NOT NULL AND `checkpoint_download_expires_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_guest_credentials_execution_uidx`
  ON `runtime_guest_credentials` (`execution_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_guest_credentials_bootstrap_hash_uidx`
  ON `runtime_guest_credentials` (`bootstrap_token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_guest_credentials_report_hash_uidx`
  ON `runtime_guest_credentials` (`report_credential_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_guest_credentials_checkpoint_hash_uidx`
  ON `runtime_guest_credentials` (`checkpoint_download_token_hash`);
--> statement-breakpoint
CREATE TABLE `runtime_guest_reports` (
  `id` text PRIMARY KEY NOT NULL,
  `execution_id` text NOT NULL,
  `provider_kind` text NOT NULL,
  `generation` integer NOT NULL,
  `sequence` integer NOT NULL,
  `checkpoint_id` text NOT NULL,
  `boot_id` text NOT NULL,
  `phase` text NOT NULL,
  `health` text NOT NULL,
  `terminal_ready` integer DEFAULT 0 NOT NULL,
  `ssh_host_key_openssh` text,
  `probes_json` text DEFAULT '[]' NOT NULL,
  `completed_module_ids_json` text DEFAULT '[]' NOT NULL,
  `report_json` text NOT NULL,
  `reported_at` integer NOT NULL,
  `received_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON DELETE cascade,
  CONSTRAINT `runtime_guest_reports_provider_valid` CHECK (`provider_kind` IN ('agent_kvm', 'hetzner_cloud', 'gcp_compute')),
  CONSTRAINT `runtime_guest_reports_sequence_valid` CHECK (`generation` > 0 AND `sequence` >= 0),
  CONSTRAINT `runtime_guest_reports_boot_id_valid` CHECK (length(`boot_id`) = 36 AND lower(`boot_id`) = `boot_id`),
  CONSTRAINT `runtime_guest_reports_json_valid` CHECK (json_valid(`probes_json`) AND json_valid(`completed_module_ids_json`) AND json_valid(`report_json`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_guest_reports_generation_sequence_uidx`
  ON `runtime_guest_reports` (`execution_id`, `generation`, `sequence`);
--> statement-breakpoint
CREATE INDEX `runtime_guest_reports_execution_received_idx`
  ON `runtime_guest_reports` (`execution_id`, `received_at`);
--> statement-breakpoint
CREATE TRIGGER `runtime_guest_reports_generation_insert_guard`
BEFORE INSERT ON `runtime_guest_reports`
WHEN NOT EXISTS (
  SELECT 1 FROM `runtime_executions` execution
  WHERE execution.`id` = NEW.`execution_id`
    AND execution.`generation` = NEW.`generation`
    AND execution.`provider_kind` = NEW.`provider_kind`
)
BEGIN
  SELECT RAISE(ABORT, 'stale or mismatched runtime guest report');
END;
--> statement-breakpoint
CREATE TABLE `runtime_actual_state` (
  `execution_id` text PRIMARY KEY NOT NULL,
  `latest_report_id` text,
  `source_kind` text NOT NULL,
  `source_id` text NOT NULL,
  `generation` integer NOT NULL,
  `sequence` integer NOT NULL,
  `phase` text NOT NULL,
  `health` text NOT NULL,
  `observed_at` integer NOT NULL,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON DELETE cascade,
  FOREIGN KEY (`latest_report_id`) REFERENCES `runtime_guest_reports`(`id`) ON DELETE restrict,
  CONSTRAINT `runtime_actual_state_source_valid` CHECK (`source_kind` IN ('agent_report', 'guest_report', 'provider_observation')),
  CONSTRAINT `runtime_actual_state_sequence_valid` CHECK (`generation` > 0 AND `sequence` >= 0)
);
--> statement-breakpoint
CREATE INDEX `runtime_actual_state_source_idx`
  ON `runtime_actual_state` (`source_kind`, `source_id`, `observed_at`);
--> statement-breakpoint
CREATE TABLE `runtime_artifact_upload_grants` (
  `artifact_id` text PRIMARY KEY NOT NULL,
  `execution_id` text NOT NULL,
  `generation` integer NOT NULL,
  `token_hash` text NOT NULL,
  `expires_at` integer NOT NULL,
  `used_at` integer,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`artifact_id`) REFERENCES `runtime_artifacts`(`id`) ON DELETE cascade,
  FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON DELETE cascade,
  CONSTRAINT `runtime_artifact_upload_grants_generation_valid` CHECK (`generation` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_artifact_upload_grants_token_hash_uidx`
  ON `runtime_artifact_upload_grants` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `runtime_artifact_upload_grants_execution_expiry_idx`
  ON `runtime_artifact_upload_grants` (`execution_id`, `expires_at`);
--> statement-breakpoint
CREATE TABLE `provider_price_observations` (
  `id` text PRIMARY KEY NOT NULL,
  `provider_kind` text NOT NULL,
  `connection_id` text,
  `runtime_profile_id` text NOT NULL,
  `currency` text NOT NULL,
  `source` text NOT NULL,
  `raw_observation_json` text NOT NULL,
  `observed_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON DELETE restrict,
  FOREIGN KEY (`runtime_profile_id`) REFERENCES `workshop_runtime_profiles`(`id`) ON DELETE restrict,
  CONSTRAINT `provider_price_observations_provider_valid` CHECK (`provider_kind` IN ('agent_kvm', 'hetzner_cloud', 'gcp_compute')),
  CONSTRAINT `provider_price_observations_times_valid` CHECK (`expires_at` > `observed_at`),
  CONSTRAINT `provider_price_observations_raw_valid` CHECK (json_valid(`raw_observation_json`))
);
--> statement-breakpoint
CREATE INDEX `provider_price_observations_profile_expiry_idx`
  ON `provider_price_observations` (`runtime_profile_id`, `expires_at`);
--> statement-breakpoint
CREATE TRIGGER `provider_price_observations_identity_insert_guard`
BEFORE INSERT ON `provider_price_observations`
WHEN NOT EXISTS (
  SELECT 1
  FROM `workshop_runtime_profiles` profile
  JOIN `workshop_template_revisions` revision
    ON revision.`id` = profile.`template_revision_id`
  JOIN `workshop_templates` template
    ON template.`id` = revision.`template_id`
  LEFT JOIN `provider_connections` connection
    ON connection.`id` = NEW.`connection_id`
  WHERE profile.`id` = NEW.`runtime_profile_id`
    AND profile.`provider_kind` = NEW.`provider_kind`
    AND (
      (NEW.`provider_kind` = 'agent_kvm' AND connection.`id` IS NULL)
      OR (
        NEW.`provider_kind` IN ('hetzner_cloud', 'gcp_compute')
        AND connection.`provider_kind` = NEW.`provider_kind`
        AND connection.`organization_id` = template.`organization_id`
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'price observation does not match runtime profile');
END;
--> statement-breakpoint
CREATE TRIGGER `provider_price_observations_immutable_update`
BEFORE UPDATE ON `provider_price_observations`
BEGIN
  SELECT RAISE(ABORT, 'provider price observations are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `provider_price_observations_immutable_delete`
BEFORE DELETE ON `provider_price_observations`
BEGIN
  SELECT RAISE(ABORT, 'provider price observations are immutable');
END;
--> statement-breakpoint
CREATE TABLE `provider_price_line_items` (
  `id` text PRIMARY KEY NOT NULL,
  `observation_id` text NOT NULL,
  `sku` text NOT NULL,
  `resource_kind` text NOT NULL,
  `location` text NOT NULL,
  `raw_price` text NOT NULL,
  `price_nanos` integer NOT NULL,
  `unit` text NOT NULL,
  `quantity_nanos` integer NOT NULL,
  `billing_increment_seconds` integer NOT NULL,
  `minimum_duration_seconds` integer DEFAULT 0 NOT NULL,
  `cap_price_nanos` integer,
  `tax_treatment` text NOT NULL,
  `metadata_json` text DEFAULT '{}' NOT NULL,
  FOREIGN KEY (`observation_id`) REFERENCES `provider_price_observations`(`id`) ON DELETE cascade,
  CONSTRAINT `provider_price_line_items_values_valid` CHECK (`price_nanos` >= 0 AND `quantity_nanos` > 0 AND `billing_increment_seconds` > 0 AND `minimum_duration_seconds` >= 0 AND (`cap_price_nanos` IS NULL OR `cap_price_nanos` >= 0)),
  CONSTRAINT `provider_price_line_items_tax_valid` CHECK (`tax_treatment` IN ('provider_net', 'provider_gross', 'tax_excluded_public_list')),
  CONSTRAINT `provider_price_line_items_metadata_valid` CHECK (json_valid(`metadata_json`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_price_line_items_observation_sku_location_uidx`
  ON `provider_price_line_items` (`observation_id`, `sku`, `location`, `tax_treatment`);
--> statement-breakpoint
CREATE TRIGGER `provider_price_line_items_immutable_update`
BEFORE UPDATE ON `provider_price_line_items`
BEGIN
  SELECT RAISE(ABORT, 'provider price line items are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `provider_price_line_items_immutable_delete`
BEFORE DELETE ON `provider_price_line_items`
BEGIN
  SELECT RAISE(ABORT, 'provider price line items are immutable');
END;
--> statement-breakpoint
CREATE TABLE `workshop_session_cost_forecasts` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `version` integer NOT NULL,
  `price_observation_id` text NOT NULL,
  `provider_kind` text NOT NULL,
  `currency` text NOT NULL,
  `participant_count` integer NOT NULL,
  `trigger` text NOT NULL,
  `expected_cost_nanos` integer NOT NULL,
  `lease_ceiling_cost_nanos` integer NOT NULL,
  `one_restore_cost_nanos` integer NOT NULL,
  `exceeds_budget_ceiling` integer DEFAULT 0 NOT NULL,
  `assumptions_json` text NOT NULL,
  `exclusions_json` text NOT NULL,
  `expires_at` integer NOT NULL,
  `created_by` text,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON DELETE cascade,
  FOREIGN KEY (`price_observation_id`) REFERENCES `provider_price_observations`(`id`) ON DELETE restrict,
  FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE restrict,
  CONSTRAINT `workshop_session_cost_forecasts_provider_valid` CHECK (`provider_kind` IN ('agent_kvm', 'hetzner_cloud', 'gcp_compute')),
  CONSTRAINT `workshop_session_cost_forecasts_values_valid` CHECK (`version` > 0 AND `participant_count` >= 0 AND `expected_cost_nanos` >= 0 AND `lease_ceiling_cost_nanos` >= 0 AND `one_restore_cost_nanos` >= 0),
  CONSTRAINT `workshop_session_cost_forecasts_json_valid` CHECK (json_valid(`assumptions_json`) AND json_valid(`exclusions_json`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_session_cost_forecasts_version_uidx`
  ON `workshop_session_cost_forecasts` (`session_id`, `version`);
--> statement-breakpoint
CREATE INDEX `workshop_session_cost_forecasts_expiry_idx`
  ON `workshop_session_cost_forecasts` (`session_id`, `expires_at`);
--> statement-breakpoint
CREATE TRIGGER `workshop_session_cost_forecasts_identity_insert_guard`
BEFORE INSERT ON `workshop_session_cost_forecasts`
WHEN NOT EXISTS (
  SELECT 1
  FROM `workshop_session_runtime_selections` selection
  JOIN `provider_price_observations` observation
    ON observation.`id` = NEW.`price_observation_id`
    AND observation.`runtime_profile_id` = selection.`runtime_profile_id`
    AND observation.`provider_kind` = NEW.`provider_kind`
    AND observation.`currency` = NEW.`currency`
    AND observation.`connection_id` IS selection.`connection_id`
    AND NEW.`expires_at` <= observation.`expires_at`
  WHERE selection.`session_id` = NEW.`session_id`
    AND selection.`provider_kind` = NEW.`provider_kind`
)
BEGIN
  SELECT RAISE(ABORT, 'forecast does not match the pinned runtime selection');
END;
--> statement-breakpoint
CREATE TRIGGER `workshop_session_cost_forecasts_immutable_update`
BEFORE UPDATE ON `workshop_session_cost_forecasts`
BEGIN
  SELECT RAISE(ABORT, 'workshop cost forecasts are immutable');
END;
--> statement-breakpoint
CREATE TABLE `workshop_session_cost_forecast_line_items` (
  `id` text PRIMARY KEY NOT NULL,
  `forecast_id` text NOT NULL,
  `price_line_item_id` text NOT NULL,
  `scenario` text NOT NULL,
  `participant_count` integer NOT NULL,
  `generation_count` integer NOT NULL,
  `lifetime_seconds` integer NOT NULL,
  `billed_quantity_nanos` integer NOT NULL,
  `calculated_cost_nanos` integer NOT NULL,
  `calculation_json` text NOT NULL,
  FOREIGN KEY (`forecast_id`) REFERENCES `workshop_session_cost_forecasts`(`id`) ON DELETE cascade,
  FOREIGN KEY (`price_line_item_id`) REFERENCES `provider_price_line_items`(`id`) ON DELETE restrict,
  CONSTRAINT `workshop_session_cost_forecast_line_items_scenario_valid` CHECK (`scenario` IN ('expected', 'lease_ceiling', 'one_restore')),
  CONSTRAINT `workshop_session_cost_forecast_line_items_values_valid` CHECK (`participant_count` >= 0 AND `generation_count` > 0 AND `lifetime_seconds` >= 0 AND `billed_quantity_nanos` >= 0 AND `calculated_cost_nanos` >= 0),
  CONSTRAINT `workshop_session_cost_forecast_line_items_calculation_valid` CHECK (json_valid(`calculation_json`))
);
--> statement-breakpoint
CREATE INDEX `workshop_session_cost_forecast_line_items_scenario_idx`
  ON `workshop_session_cost_forecast_line_items` (`forecast_id`, `scenario`);
--> statement-breakpoint
CREATE TABLE `runtime_provider_cost_ledger` (
  `id` text PRIMARY KEY NOT NULL,
  `execution_id` text NOT NULL,
  `allocation_id` text NOT NULL,
  `provider_resource_id` text NOT NULL,
  `forecast_id` text,
  `price_line_item_id` text NOT NULL,
  `provider_kind` text NOT NULL,
  `resource_kind` text NOT NULL,
  `sku` text NOT NULL,
  `location` text NOT NULL,
  `currency` text NOT NULL,
  `raw_price` text NOT NULL,
  `price_nanos` integer NOT NULL,
  `unit` text NOT NULL,
  `quantity_nanos` integer NOT NULL,
  `billing_increment_seconds` integer NOT NULL,
  `minimum_duration_seconds` integer NOT NULL,
  `cap_price_nanos` integer,
  `tax_treatment` text NOT NULL,
  `provider_created_at` integer NOT NULL,
  `deletion_confirmed_at` integer,
  `final_cost_nanos` integer,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON DELETE restrict,
  FOREIGN KEY (`allocation_id`) REFERENCES `runtime_provider_allocations`(`id`) ON DELETE restrict,
  FOREIGN KEY (`provider_resource_id`) REFERENCES `runtime_provider_resources`(`id`) ON DELETE restrict,
  FOREIGN KEY (`forecast_id`) REFERENCES `workshop_session_cost_forecasts`(`id`) ON DELETE restrict,
  FOREIGN KEY (`price_line_item_id`) REFERENCES `provider_price_line_items`(`id`) ON DELETE restrict,
  CONSTRAINT `runtime_provider_cost_ledger_provider_valid` CHECK (`provider_kind` IN ('hetzner_cloud', 'gcp_compute')),
  CONSTRAINT `runtime_provider_cost_ledger_values_valid` CHECK (`price_nanos` >= 0 AND `quantity_nanos` > 0 AND `billing_increment_seconds` > 0 AND `minimum_duration_seconds` >= 0 AND (`cap_price_nanos` IS NULL OR `cap_price_nanos` >= 0) AND (`final_cost_nanos` IS NULL OR `final_cost_nanos` >= 0)),
  CONSTRAINT `runtime_provider_cost_ledger_lifecycle_valid` CHECK ((`deletion_confirmed_at` IS NULL AND `final_cost_nanos` IS NULL) OR (`deletion_confirmed_at` IS NOT NULL AND `deletion_confirmed_at` >= `provider_created_at` AND `final_cost_nanos` IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_cost_ledger_resource_sku_tax_uidx`
  ON `runtime_provider_cost_ledger` (`provider_resource_id`, `sku`, `tax_treatment`);
--> statement-breakpoint
CREATE INDEX `runtime_provider_cost_ledger_execution_idx`
  ON `runtime_provider_cost_ledger` (`execution_id`, `provider_created_at`);
--> statement-breakpoint
CREATE TRIGGER `runtime_provider_cost_ledger_price_snapshot_immutable`
BEFORE UPDATE OF
  `execution_id`, `allocation_id`, `provider_resource_id`, `forecast_id`,
  `price_line_item_id`, `provider_kind`, `resource_kind`, `sku`, `location`,
  `currency`, `raw_price`, `price_nanos`, `unit`, `quantity_nanos`,
  `billing_increment_seconds`, `minimum_duration_seconds`, `cap_price_nanos`,
  `tax_treatment`, `provider_created_at`
ON `runtime_provider_cost_ledger`
BEGIN
  SELECT RAISE(ABORT, 'provider cost ledger price snapshots are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `runtime_provider_cost_ledger_identity_insert_guard`
BEFORE INSERT ON `runtime_provider_cost_ledger`
WHEN NOT EXISTS (
  SELECT 1
  FROM `runtime_provider_allocations` allocation
  JOIN `runtime_executions` execution
    ON execution.`id` = allocation.`execution_id`
  JOIN `runtime_provider_resources` resource
    ON resource.`id` = NEW.`provider_resource_id`
    AND resource.`allocation_id` = allocation.`id`
    AND resource.`provider_kind` = NEW.`provider_kind`
    AND resource.`resource_kind` = NEW.`resource_kind`
    AND resource.`location` = NEW.`location`
  JOIN `provider_price_line_items` price
    ON price.`id` = NEW.`price_line_item_id`
    AND price.`sku` = NEW.`sku`
    AND price.`location` = NEW.`location`
    AND price.`raw_price` = NEW.`raw_price`
    AND price.`price_nanos` = NEW.`price_nanos`
    AND price.`unit` = NEW.`unit`
    AND price.`quantity_nanos` = NEW.`quantity_nanos`
    AND price.`billing_increment_seconds` = NEW.`billing_increment_seconds`
    AND price.`minimum_duration_seconds` = NEW.`minimum_duration_seconds`
    AND price.`cap_price_nanos` IS NEW.`cap_price_nanos`
    AND price.`tax_treatment` = NEW.`tax_treatment`
  JOIN `provider_price_observations` observation
    ON observation.`id` = price.`observation_id`
    AND observation.`id` = allocation.`price_observation_id`
    AND observation.`provider_kind` = NEW.`provider_kind`
    AND observation.`currency` = NEW.`currency`
  WHERE allocation.`id` = NEW.`allocation_id`
    AND allocation.`execution_id` = NEW.`execution_id`
    AND allocation.`provider_kind` = NEW.`provider_kind`
    AND NEW.`provider_created_at` = COALESCE(
      resource.`provider_created_at`,
      allocation.`created_at`
    )
    AND NEW.`forecast_id` IS allocation.`cost_forecast_id`
    AND (
      (
        NEW.`provider_kind` = 'hetzner_cloud'
        AND price.`resource_kind` = resource.`resource_kind`
      )
      OR (
        NEW.`provider_kind` = 'gcp_compute'
        AND (
          (resource.`resource_kind` = 'instance' AND price.`resource_kind` IN ('compute_core', 'compute_ram'))
          OR (resource.`resource_kind` = 'boot_disk' AND price.`resource_kind` = 'pd_balanced')
          OR (resource.`resource_kind` = 'ipv4' AND price.`resource_kind` = 'external_ipv4')
        )
      )
    )
    AND (
      (
        execution.`domain_kind` = 'workshop'
        AND EXISTS (
          SELECT 1
          FROM `workshop_workspaces` workspace
          JOIN `workshop_session_cost_forecasts` forecast
            ON forecast.`session_id` = workspace.`session_id`
            AND forecast.`id` = NEW.`forecast_id`
            AND forecast.`price_observation_id` = observation.`id`
            AND forecast.`provider_kind` = NEW.`provider_kind`
          WHERE workspace.`id` = execution.`domain_id`
        )
      )
      OR (
        execution.`domain_kind` = 'workshop_certification'
        AND NEW.`forecast_id` IS NULL
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'cost ledger line does not match its allocation and price');
END;
--> statement-breakpoint
CREATE TABLE `workshop_session_cost_summaries` (
  `session_id` text PRIMARY KEY NOT NULL,
  `currency` text NOT NULL,
  `final_cost_nanos` integer,
  `forecast_variance_nanos` integer,
  `generation_count` integer DEFAULT 0 NOT NULL,
  `restore_count` integer DEFAULT 0 NOT NULL,
  `cleanup_pending_count` integer DEFAULT 0 NOT NULL,
  `manual_cleanup_unverified` integer DEFAULT 0 NOT NULL,
  `finalized_at` integer,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON DELETE cascade,
  CONSTRAINT `workshop_session_cost_summaries_counts_valid` CHECK (`generation_count` >= 0 AND `restore_count` >= 0 AND `cleanup_pending_count` >= 0)
);
--> statement-breakpoint
