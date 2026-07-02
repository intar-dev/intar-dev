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
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `agent_bootstrap_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_bootstrap_tokens_host_idx` ON `agent_bootstrap_tokens` (`host_id`);--> statement-breakpoint
CREATE INDEX `agent_bootstrap_tokens_hash_idx` ON `agent_bootstrap_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `agent_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
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
	`host_info_json` text,
	`inventory_json` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_hosts_user_idx` ON `agent_hosts` (`user_id`);--> statement-breakpoint
CREATE INDEX `agent_hosts_connected_idx` ON `agent_hosts` (`connected`,`updated_at`);--> statement-breakpoint
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
CREATE INDEX `host_actual_state_applied_version_idx` ON `host_actual_state` (`applied_desired_version`);--> statement-breakpoint
CREATE INDEX `host_actual_state_observed_idx` ON `host_actual_state` (`observed_at`);--> statement-breakpoint
CREATE TABLE `host_desired_state` (
	`host_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`doc_json` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `host_desired_state_version_idx` ON `host_desired_state` (`version`);--> statement-breakpoint
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
CREATE INDEX `invitation_organizationId_idx` ON `invitation` (`organization_id`);--> statement-breakpoint
CREATE INDEX `invitation_email_idx` ON `invitation` (`email`);--> statement-breakpoint
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
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_organizationId_idx` ON `member` (`organization_id`);--> statement-breakpoint
CREATE INDEX `member_userId_idx` ON `member` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_access_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text,
	`reference_id` text,
	`refresh_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`scopes` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`refresh_id`) REFERENCES `oauth_refresh_token`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_access_token_token_unique` ON `oauth_access_token` (`token`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_clientId_idx` ON `oauth_access_token` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_sessionId_idx` ON `oauth_access_token` (`session_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_userId_idx` ON `oauth_access_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_referenceId_idx` ON `oauth_access_token` (`reference_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_refreshId_idx` ON `oauth_access_token` (`refresh_id`);--> statement-breakpoint
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
	`token_endpoint_auth_method` text,
	`grant_types` text,
	`response_types` text,
	`public` integer DEFAULT false NOT NULL,
	`type` text,
	`require_pkce` integer DEFAULT true NOT NULL,
	`reference_id` text,
	`metadata` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_client_client_id_unique` ON `oauth_client` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthClient_userId_idx` ON `oauth_client` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauthClient_referenceId_idx` ON `oauth_client` (`reference_id`);--> statement-breakpoint
CREATE TABLE `oauth_consent` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text,
	`reference_id` text,
	`scopes` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauthConsent_clientId_idx` ON `oauth_consent` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthConsent_userId_idx` ON `oauth_consent` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauthConsent_referenceId_idx` ON `oauth_consent` (`reference_id`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text NOT NULL,
	`reference_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`revoked` integer,
	`auth_time` integer,
	`scopes` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_refresh_token_token_unique` ON `oauth_refresh_token` (`token`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_clientId_idx` ON `oauth_refresh_token` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_sessionId_idx` ON `oauth_refresh_token` (`session_id`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_userId_idx` ON `oauth_refresh_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_referenceId_idx` ON `oauth_refresh_token` (`reference_id`);--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`created_at` integer NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_uidx` ON `organization` (`slug`);--> statement-breakpoint
CREATE TABLE `scenario_run_artifact_uploads` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`r2_upload_id` text,
	`uploaded_parts_json` text NOT NULL,
	`next_expected_part` integer NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
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
CREATE UNIQUE INDEX `scenario_run_artifacts_vm_ordinal_uidx` ON `scenario_run_artifacts` (`vm_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `scenario_run_artifacts_run_idx` ON `scenario_run_artifacts` (`run_id`,`vm_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `scenario_run_artifacts_r2_key_idx` ON `scenario_run_artifacts` (`r2_key`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `scenario_run_probe_snapshots_run_vm_message_uidx` ON `scenario_run_probe_snapshots` (`run_id`,`vm_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `scenario_run_probe_snapshots_run_vm_idx` ON `scenario_run_probe_snapshots` (`run_id`,`vm_id`,`created_at`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `scenario_run_ssh_keys_run_vm_uidx` ON `scenario_run_ssh_keys` (`run_id`,`vm_id`);--> statement-breakpoint
CREATE INDEX `scenario_run_ssh_keys_run_runtime_idx` ON `scenario_run_ssh_keys` (`run_id`,`runtime_vm_name`);--> statement-breakpoint
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
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_runs_active_key_uidx` ON `scenario_runs` (`active_key`);--> statement-breakpoint
CREATE INDEX `scenario_runs_user_scenario_idx` ON `scenario_runs` (`user_id`,`scenario_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `scenario_runs_host_idx` ON `scenario_runs` (`host_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	`active_organization_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);--> statement-breakpoint
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
CREATE INDEX `user_ssh_keys_user_idx` ON `user_ssh_keys` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_ssh_keys_user_fingerprint_uidx` ON `user_ssh_keys` (`user_id`,`fingerprint_sha256`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `vm_scenario_probes` (
	`id` text PRIMARY KEY NOT NULL,
	`scenario_id` text NOT NULL,
	`scenario_vm_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`phase` text DEFAULT 'scenario' NOT NULL,
	FOREIGN KEY (`scenario_id`) REFERENCES `vm_scenarios`(`scenario_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scenario_vm_id`) REFERENCES `vm_scenario_vms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vm_scenario_probes_vm_ordinal_uidx` ON `vm_scenario_probes` (`scenario_vm_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `vm_scenario_probes_scenario_idx` ON `vm_scenario_probes` (`scenario_id`,`scenario_vm_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `vm_scenario_vms` (
	`id` text PRIMARY KEY NOT NULL,
	`scenario_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`vm_name` text NOT NULL,
	`image` text NOT NULL,
	`image_key_json` text,
	`image_sha256` text,
	`cpu` integer NOT NULL,
	`memory_mib` integer NOT NULL,
	`disk_mib` integer NOT NULL,
	FOREIGN KEY (`scenario_id`) REFERENCES `vm_scenarios`(`scenario_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vm_scenario_vms_scenario_ordinal_uidx` ON `vm_scenario_vms` (`scenario_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `vm_scenario_vms_scenario_name_uidx` ON `vm_scenario_vms` (`scenario_id`,`vm_name`);--> statement-breakpoint
CREATE INDEX `vm_scenario_vms_scenario_idx` ON `vm_scenario_vms` (`scenario_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `vm_scenarios` (
	`scenario_id` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`enabled_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vm_scenarios_enabled_idx` ON `vm_scenarios` (`enabled`,`enabled_at`);