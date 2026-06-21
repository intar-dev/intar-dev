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
	`server_next_seq` integer DEFAULT 1 NOT NULL,
	`server_acked_seq` integer DEFAULT 0 NOT NULL,
	`host_next_seq` integer DEFAULT 1 NOT NULL,
	`host_acked_seq` integer DEFAULT 0 NOT NULL,
	`agent_version` text,
	`host_info_json` text,
	`inventory_json` text,
	`runtime_state_json` text,
	`last_ping_at` integer,
	`last_ping_rtt_ms` integer,
	`last_ping_success` integer,
	`last_ping_error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_hosts_user_idx` ON `agent_hosts` (`user_id`);--> statement-breakpoint
CREATE INDEX `agent_hosts_connected_idx` ON `agent_hosts` (`connected`,`updated_at`);--> statement-breakpoint
CREATE TABLE `agent_ping_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`requested_by_user_id` text NOT NULL,
	`requested_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`success` integer NOT NULL,
	`rtt_ms` integer,
	`error` text,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_ping_audit_host_idx` ON `agent_ping_audit` (`host_id`);--> statement-breakpoint
CREATE INDEX `agent_ping_audit_user_idx` ON `agent_ping_audit` (`requested_by_user_id`);--> statement-breakpoint
CREATE TABLE `host_rpc_calls` (
	`call_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`user_id` text,
	`run_id` text,
	`vm_id` text,
	`direction` text NOT NULL,
	`method` text NOT NULL,
	`status` text NOT NULL,
	`idempotency_key` text,
	`request_message_id` text,
	`response_message_id` text,
	`request_json` text NOT NULL,
	`response_json` text,
	`error_json` text,
	`request_acked_at` integer,
	`response_acked_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`deadline_at` integer,
	`expires_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_rpc_calls_host_idempotency_uidx` ON `host_rpc_calls` (`host_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `host_rpc_calls_host_status_idx` ON `host_rpc_calls` (`host_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `host_rpc_calls_run_idx` ON `host_rpc_calls` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `host_rpc_calls_vm_idx` ON `host_rpc_calls` (`vm_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `host_rpc_envelopes` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`direction` text NOT NULL,
	`seq` integer NOT NULL,
	`session_id` text,
	`message_id` text NOT NULL,
	`call_id` text,
	`kind` text NOT NULL,
	`method` text NOT NULL,
	`payload_json` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`applied_at` integer,
	`acked_at` integer,
	`expires_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`call_id`) REFERENCES `host_rpc_calls`(`call_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_rpc_envelopes_host_direction_seq_uidx` ON `host_rpc_envelopes` (`host_id`,`direction`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `host_rpc_envelopes_host_direction_message_uidx` ON `host_rpc_envelopes` (`host_id`,`direction`,`message_id`);--> statement-breakpoint
CREATE INDEX `host_rpc_envelopes_host_direction_idx` ON `host_rpc_envelopes` (`host_id`,`direction`,`seq`);--> statement-breakpoint
CREATE INDEX `host_rpc_envelopes_call_idx` ON `host_rpc_envelopes` (`call_id`,`seq`);--> statement-breakpoint
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
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`client_id` text,
	`user_id` text,
	`scopes` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_application`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_access_token_access_token_unique` ON `oauth_access_token` (`access_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_access_token_refresh_token_unique` ON `oauth_access_token` (`refresh_token`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_clientId_idx` ON `oauth_access_token` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_userId_idx` ON `oauth_access_token` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_application` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`icon` text,
	`metadata` text,
	`client_id` text,
	`client_secret` text,
	`redirect_urls` text,
	`type` text,
	`disabled` integer DEFAULT false,
	`user_id` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_application_client_id_unique` ON `oauth_application` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthApplication_userId_idx` ON `oauth_application` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_consent` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text,
	`user_id` text,
	`scopes` text,
	`created_at` integer,
	`updated_at` integer,
	`consent_given` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_application`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauthConsent_clientId_idx` ON `oauth_consent` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthConsent_userId_idx` ON `oauth_consent` (`user_id`);--> statement-breakpoint
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
CREATE TABLE `scenario_run_upload_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`vm_id` text NOT NULL,
	`host_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `scenario_runs`(`run_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_run_upload_leases_vm_uidx` ON `scenario_run_upload_leases` (`vm_id`);--> statement-breakpoint
CREATE INDEX `scenario_run_upload_leases_host_idx` ON `scenario_run_upload_leases` (`host_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `scenario_run_upload_leases_token_idx` ON `scenario_run_upload_leases` (`token_hash`);--> statement-breakpoint
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