CREATE TABLE `access_allowlist` (
	`user_id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`github_account_id` text NOT NULL,
	`github_username` text NOT NULL,
	`source_invite_id` text NOT NULL,
	`source_lease_id` text NOT NULL,
	`granted_by` text,
	`grant_reason` text NOT NULL,
	`granted_at` integer NOT NULL,
	`revocation_id` text,
	`revoked_by` text,
	`revocation_reason` text,
	`revoked_at` integer,
	`revocation_cleanup_attempt_id` text,
	`revocation_cleanup_started_at` integer,
	`revocation_cleanup_completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_invite_id`) REFERENCES `access_invite_codes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "access_allowlist_state_valid" CHECK(
        ("access_allowlist"."state" = 'active'
          AND "access_allowlist"."revocation_id" is null
          AND "access_allowlist"."revoked_by" is null
          AND "access_allowlist"."revocation_reason" is null
          AND "access_allowlist"."revoked_at" is null
          AND "access_allowlist"."revocation_cleanup_attempt_id" is null
          AND "access_allowlist"."revocation_cleanup_started_at" is null
          AND "access_allowlist"."revocation_cleanup_completed_at" is null)
        OR
        ("access_allowlist"."state" = 'blocked'
          AND "access_allowlist"."revocation_id" is not null
          AND "access_allowlist"."revoked_by" is not null
          AND "access_allowlist"."revocation_reason" is not null
          AND "access_allowlist"."revoked_at" is not null
          AND (
            ("access_allowlist"."revocation_cleanup_attempt_id" is null
              AND "access_allowlist"."revocation_cleanup_started_at" is null
              AND "access_allowlist"."revocation_cleanup_completed_at" is null)
            OR
            ("access_allowlist"."revocation_cleanup_attempt_id" is not null
              AND "access_allowlist"."revocation_cleanup_started_at" is not null
              AND ("access_allowlist"."revocation_cleanup_completed_at" is null
                OR "access_allowlist"."revocation_cleanup_completed_at" >= "access_allowlist"."revocation_cleanup_started_at"))
          )))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_allowlist_github_account_uidx` ON `access_allowlist` (`github_account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `access_allowlist_source_invite_uidx` ON `access_allowlist` (`source_invite_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `access_allowlist_revocation_uidx` ON `access_allowlist` (`revocation_id`);--> statement-breakpoint
CREATE INDEX `access_allowlist_state_idx` ON `access_allowlist` (`state`,`granted_at`);--> statement-breakpoint
CREATE INDEX `access_allowlist_granted_by_idx` ON `access_allowlist` (`granted_by`);--> statement-breakpoint
CREATE TABLE `access_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`invite_id` text,
	`subject_user_id` text,
	`github_account_id` text,
	`actor_user_id` text,
	`revocation_id` text,
	`cleanup_attempt_id` text,
	`reason` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `access_events_invite_idx` ON `access_events` (`invite_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `access_events_subject_idx` ON `access_events` (`subject_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `access_events_created_idx` ON `access_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `access_invite_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`code_prefix` text NOT NULL,
	`kind` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`label` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`lease_id` text,
	`leased_at` integer,
	`lease_expires_at` integer,
	`redeemer_user_id` text,
	`redeemer_github_account_id` text,
	`redeemer_github_username` text,
	`redeemed_at` integer,
	`revoked_by` text,
	`revocation_reason` text,
	`revoked_at` integer,
	`replaces_invite_id` text,
	`replaces_invite_version` integer,
	`replaced_by_invite_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT "access_invite_codes_hash_valid" CHECK(length("access_invite_codes"."code_hash") = 64 AND "access_invite_codes"."code_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "access_invite_codes_kind_valid" CHECK("access_invite_codes"."kind" in ('standard', 'bootstrap_admin')),
	CONSTRAINT "access_invite_codes_creator_valid" CHECK(("access_invite_codes"."kind" = 'standard' AND "access_invite_codes"."created_by" is not null) OR ("access_invite_codes"."kind" = 'bootstrap_admin' AND "access_invite_codes"."created_by" is null)),
	CONSTRAINT "access_invite_codes_expiry_valid" CHECK("access_invite_codes"."expires_at" in ("access_invite_codes"."created_at" + 172800000, "access_invite_codes"."created_at" + 1209600000)),
	CONSTRAINT "access_invite_codes_version_valid" CHECK("access_invite_codes"."version" > 0),
	CONSTRAINT "access_invite_codes_replacement_valid" CHECK(("access_invite_codes"."replaces_invite_id" is null AND "access_invite_codes"."replaces_invite_version" is null) OR ("access_invite_codes"."replaces_invite_id" is not null AND "access_invite_codes"."replaces_invite_version" > 0)),
	CONSTRAINT "access_invite_codes_state_valid" CHECK(
        ("access_invite_codes"."state" = 'pending'
          AND "access_invite_codes"."lease_id" is null
          AND "access_invite_codes"."leased_at" is null
          AND "access_invite_codes"."lease_expires_at" is null
          AND "access_invite_codes"."redeemer_user_id" is null
          AND "access_invite_codes"."redeemer_github_account_id" is null
          AND "access_invite_codes"."redeemer_github_username" is null
          AND "access_invite_codes"."redeemed_at" is null
          AND "access_invite_codes"."revoked_by" is null
          AND "access_invite_codes"."revocation_reason" is null
          AND "access_invite_codes"."revoked_at" is null
          AND "access_invite_codes"."replaced_by_invite_id" is null)
        OR
        ("access_invite_codes"."state" = 'leased'
          AND "access_invite_codes"."lease_id" is not null
          AND "access_invite_codes"."leased_at" is not null
          AND "access_invite_codes"."lease_expires_at" = "access_invite_codes"."leased_at" + 600000
          AND "access_invite_codes"."redeemer_user_id" is null
          AND "access_invite_codes"."redeemer_github_account_id" is null
          AND "access_invite_codes"."redeemer_github_username" is null
          AND "access_invite_codes"."redeemed_at" is null
          AND "access_invite_codes"."revoked_by" is null
          AND "access_invite_codes"."revocation_reason" is null
          AND "access_invite_codes"."revoked_at" is null
          AND "access_invite_codes"."replaced_by_invite_id" is null)
        OR
        ("access_invite_codes"."state" = 'redeemed'
          AND "access_invite_codes"."lease_id" is not null
          AND "access_invite_codes"."leased_at" is not null
          AND "access_invite_codes"."lease_expires_at" = "access_invite_codes"."leased_at" + 600000
          AND "access_invite_codes"."redeemer_user_id" is not null
          AND "access_invite_codes"."redeemer_github_account_id" is not null
          AND "access_invite_codes"."redeemer_github_username" is not null
          AND "access_invite_codes"."redeemed_at" is not null
          AND "access_invite_codes"."revoked_by" is null
          AND "access_invite_codes"."revocation_reason" is null
          AND "access_invite_codes"."revoked_at" is null
          AND "access_invite_codes"."replaced_by_invite_id" is null)
        OR
        ("access_invite_codes"."state" = 'revoked'
          AND "access_invite_codes"."lease_id" is null
          AND "access_invite_codes"."leased_at" is null
          AND "access_invite_codes"."lease_expires_at" is null
          AND "access_invite_codes"."redeemer_user_id" is null
          AND "access_invite_codes"."redeemer_github_account_id" is null
          AND "access_invite_codes"."redeemer_github_username" is null
          AND "access_invite_codes"."redeemed_at" is null
          AND "access_invite_codes"."revoked_by" is not null
          AND "access_invite_codes"."revocation_reason" is not null
          AND "access_invite_codes"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_invite_codes_hash_uidx` ON `access_invite_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `access_invite_codes_state_expiry_idx` ON `access_invite_codes` (`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `access_invite_codes_creator_idx` ON `access_invite_codes` (`created_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `access_invite_codes_lease_idx` ON `access_invite_codes` (`state`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `access_invite_removals` (
	`invite_id` text PRIMARY KEY NOT NULL,
	`invite_version` integer NOT NULL,
	`removed_by` text NOT NULL,
	`removed_at` integer NOT NULL,
	FOREIGN KEY (`invite_id`) REFERENCES `access_invite_codes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "access_invite_removals_version_valid" CHECK("access_invite_removals"."invite_version" > 0),
	CONSTRAINT "access_invite_removals_actor_valid" CHECK(length("access_invite_removals"."removed_by") BETWEEN 1 AND 255),
	CONSTRAINT "access_invite_removals_timestamp_valid" CHECK("access_invite_removals"."removed_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `access_invite_removals_removed_idx` ON `access_invite_removals` (`removed_at`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `account_provider_account_uidx` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_user_github_uidx` ON `account` (`user_id`) WHERE "account"."provider_id" = 'github';--> statement-breakpoint
CREATE TABLE `active_runtime_slots` (
	`user_id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`acquired_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `active_runtime_slots_execution_uidx` ON `active_runtime_slots` (`execution_id`);--> statement-breakpoint
CREATE TABLE `agent_bootstrap_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer,
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
	`organization_id` text,
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
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `agent_hosts_user_idx` ON `agent_hosts` (`user_id`);--> statement-breakpoint
CREATE INDEX `agent_hosts_organization_idx` ON `agent_hosts` (`organization_id`,`role`,`connected`);--> statement-breakpoint
CREATE INDEX `agent_hosts_role_idx` ON `agent_hosts` (`role`,`connected`);--> statement-breakpoint
CREATE INDEX `agent_hosts_connected_idx` ON `agent_hosts` (`connected`,`updated_at`);--> statement-breakpoint
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
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cleanup_acknowledged_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "gcp_connection_details_zones_valid" CHECK(json_valid("gcp_connection_details"."approved_zones_json")),
	CONSTRAINT "gcp_connection_details_limits_valid" CHECK("gcp_connection_details"."max_concurrent_allocations" > 0 AND ("gcp_connection_details"."max_session_cost_nanos" is null OR "gcp_connection_details"."max_session_cost_nanos" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gcp_connection_details_project_number_uidx` ON `gcp_connection_details` (`project_number`);--> statement-breakpoint
CREATE TABLE `hetzner_connection_details` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`sentinel_firewall_id` text NOT NULL,
	`approved_locations_json` text DEFAULT '["nbg1","fsn1","hel1"]' NOT NULL,
	`max_concurrent_allocations` integer DEFAULT 5 NOT NULL,
	`max_session_cost_nanos` integer,
	`native_currency` text NOT NULL,
	`ipv4_enabled` integer DEFAULT true NOT NULL,
	`cleanup_acknowledged_at` integer,
	`cleanup_acknowledged_by` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cleanup_acknowledged_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "hetzner_connection_details_locations_valid" CHECK(json_valid("hetzner_connection_details"."approved_locations_json")),
	CONSTRAINT "hetzner_connection_details_limits_valid" CHECK("hetzner_connection_details"."max_concurrent_allocations" > 0 AND ("hetzner_connection_details"."max_session_cost_nanos" is null OR "hetzner_connection_details"."max_session_cost_nanos" >= 0)),
	CONSTRAINT "hetzner_connection_details_ipv4_required" CHECK("hetzner_connection_details"."ipv4_enabled" = 1)
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
CREATE INDEX `host_actual_state_applied_version_idx` ON `host_actual_state` (`applied_desired_version`);--> statement-breakpoint
CREATE INDEX `host_actual_state_observed_idx` ON `host_actual_state` (`observed_at`);--> statement-breakpoint
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
	CONSTRAINT "host_cpu_reservations_cpu_positive" CHECK("host_cpu_reservations"."cpu_millis" > 0),
	CONSTRAINT "host_cpu_reservations_quota_positive" CHECK("host_cpu_reservations"."steady_cpu_millis" > 0 AND "host_cpu_reservations"."boot_cpu_millis" >= "host_cpu_reservations"."steady_cpu_millis"),
	CONSTRAINT "host_cpu_reservations_quota_phase_valid" CHECK("host_cpu_reservations"."quota_phase" in ('boot', 'steady')),
	CONSTRAINT "host_cpu_reservations_current_quota_valid" CHECK(("host_cpu_reservations"."quota_phase" = 'boot' AND "host_cpu_reservations"."cpu_millis" = "host_cpu_reservations"."boot_cpu_millis") OR ("host_cpu_reservations"."quota_phase" = 'steady' AND "host_cpu_reservations"."cpu_millis" = "host_cpu_reservations"."steady_cpu_millis")),
	CONSTRAINT "host_cpu_reservations_state_valid" CHECK("host_cpu_reservations"."state" in ('pending', 'committed'))
);
--> statement-breakpoint
CREATE INDEX `host_cpu_reservations_host_state_idx` ON `host_cpu_reservations` (`host_id`,`state`);--> statement-breakpoint
CREATE INDEX `host_cpu_reservations_pending_expiry_idx` ON `host_cpu_reservations` (`state`,`expires_at`);--> statement-breakpoint
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
	CONSTRAINT "host_resource_reservations_cpu_positive" CHECK("host_resource_reservations"."cpu_millis" > 0),
	CONSTRAINT "host_resource_reservations_memory_positive" CHECK("host_resource_reservations"."memory_mib" > 0),
	CONSTRAINT "host_resource_reservations_disk_positive" CHECK("host_resource_reservations"."worst_case_disk_mib" > 0),
	CONSTRAINT "host_resource_reservations_state_valid" CHECK("host_resource_reservations"."state" in ('pending', 'committed', 'released'))
);
--> statement-breakpoint
CREATE INDEX `host_resource_reservations_host_state_idx` ON `host_resource_reservations` (`host_id`,`state`);--> statement-breakpoint
CREATE INDEX `host_resource_reservations_expiry_idx` ON `host_resource_reservations` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `image_build_bundles` (
	`rev` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`r2_key` text NOT NULL,
	`kino_version` text NOT NULL,
	`meta_json` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `image_build_bundles_organization_idx` ON `image_build_bundles` (`organization_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `image_build_coordination_locks` (
	`key` text PRIMARY KEY NOT NULL,
	`owner_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `image_build_coordination_locks_expiry_idx` ON `image_build_coordination_locks` (`expires_at`);--> statement-breakpoint
CREATE TABLE `image_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
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
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`rev`) REFERENCES `image_build_bundles`(`rev`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_builds_scenario_arch_hash_uidx` ON `image_builds` (`scenario_id`,`arch`,`content_hash`);--> statement-breakpoint
CREATE INDEX `image_builds_status_idx` ON `image_builds` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `image_builds_organization_idx` ON `image_builds` (`organization_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `image_builds_host_idx` ON `image_builds` (`host_id`,`status`);--> statement-breakpoint
CREATE INDEX `image_builds_rev_idx` ON `image_builds` (`rev`);--> statement-breakpoint
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
CREATE INDEX `invitation_status_idx` ON `invitation` (`status`);--> statement-breakpoint
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
	`workshop_access_revoking_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_organizationId_idx` ON `member` (`organization_id`);--> statement-breakpoint
CREATE INDEX `member_userId_idx` ON `member` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_org_user_uidx` ON `member` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_single_owner_uidx` ON `member` (`user_id`) WHERE "member"."role" = 'owner';--> statement-breakpoint
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
CREATE UNIQUE INDEX `oauth_access_token_token_unique` ON `oauth_access_token` (`token`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_clientId_idx` ON `oauth_access_token` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_sessionId_idx` ON `oauth_access_token` (`session_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_userId_idx` ON `oauth_access_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_referenceId_idx` ON `oauth_access_token` (`reference_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_authorizationCodeId_idx` ON `oauth_access_token` (`authorization_code_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `oauth_client_client_id_unique` ON `oauth_client` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthClient_userId_idx` ON `oauth_client` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauthClient_referenceId_idx` ON `oauth_client` (`reference_id`);--> statement-breakpoint
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
CREATE INDEX `oauthClientResource_clientId_idx` ON `oauth_client_resource` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthClientResource_resourceId_idx` ON `oauth_client_resource` (`resource_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauthClientResource_client_resource_uidx` ON `oauth_client_resource` (`client_id`,`resource_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `oauth_refresh_token_token_unique` ON `oauth_refresh_token` (`token`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_clientId_idx` ON `oauth_refresh_token` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_sessionId_idx` ON `oauth_refresh_token` (`session_id`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_userId_idx` ON `oauth_refresh_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_referenceId_idx` ON `oauth_refresh_token` (`reference_id`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_authorizationCodeId_idx` ON `oauth_refresh_token` (`authorization_code_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `oauth_resource_identifier_unique` ON `oauth_resource` (`identifier`);--> statement-breakpoint
CREATE INDEX `oauthResource_identifier_idx` ON `oauth_resource` (`identifier`);--> statement-breakpoint
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
CREATE TABLE `provider_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`connection_id` text,
	`actor_user_id` text,
	`type` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "provider_audit_events_payload_valid" CHECK(json_valid("provider_audit_events"."payload_json"))
);
--> statement-breakpoint
CREATE INDEX `provider_audit_events_org_created_idx` ON `provider_audit_events` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `provider_audit_events_connection_created_idx` ON `provider_audit_events` (`connection_id`,`created_at`);--> statement-breakpoint
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
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "provider_connections_kind_valid" CHECK("provider_connections"."provider_kind" in ('hetzner_cloud', 'gcp_compute')),
	CONSTRAINT "provider_connections_state_valid" CHECK("provider_connections"."state" in ('validating', 'active', 'rotation_required', 'cleanup_pending', 'disconnected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_connections_org_kind_project_uidx` ON `provider_connections` (`organization_id`,`provider_kind`,`external_project_id`);--> statement-breakpoint
CREATE INDEX `provider_connections_org_state_idx` ON `provider_connections` (`organization_id`,`state`,`updated_at`);--> statement-breakpoint
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
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "provider_credential_versions_valid" CHECK("provider_credential_versions"."version" > 0 AND "provider_credential_versions"."authority" in ('active', 'cleanup_only') AND "provider_credential_versions"."algorithm" = 'AES-256-GCM' AND length("provider_credential_versions"."kek_version") > 0 AND length("provider_credential_versions"."aad_sha256") = 64),
	CONSTRAINT "provider_credential_versions_lifecycle_valid" CHECK("provider_credential_versions"."superseded_at" is null OR "provider_credential_versions"."superseded_at" >= "provider_credential_versions"."activated_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_credential_versions_connection_version_uidx` ON `provider_credential_versions` (`connection_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_credential_versions_connection_fingerprint_uidx` ON `provider_credential_versions` (`connection_id`,`credential_fingerprint`);--> statement-breakpoint
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
	FOREIGN KEY (`observation_id`) REFERENCES `provider_price_observations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "provider_price_line_items_values_valid" CHECK("provider_price_line_items"."price_nanos" >= 0 AND "provider_price_line_items"."quantity_nanos" > 0 AND "provider_price_line_items"."billing_increment_seconds" > 0 AND "provider_price_line_items"."minimum_duration_seconds" >= 0 AND ("provider_price_line_items"."cap_price_nanos" is null OR "provider_price_line_items"."cap_price_nanos" >= 0)),
	CONSTRAINT "provider_price_line_items_tax_valid" CHECK("provider_price_line_items"."tax_treatment" in ('provider_net', 'provider_gross', 'tax_excluded_public_list')),
	CONSTRAINT "provider_price_line_items_metadata_valid" CHECK(json_valid("provider_price_line_items"."metadata_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_price_line_items_observation_sku_location_uidx` ON `provider_price_line_items` (`observation_id`,`sku`,`location`,`tax_treatment`);--> statement-breakpoint
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
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`runtime_profile_id`) REFERENCES `workshop_runtime_profiles`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "provider_price_observations_provider_valid" CHECK("provider_price_observations"."provider_kind" in ('agent_kvm', 'hetzner_cloud', 'gcp_compute')),
	CONSTRAINT "provider_price_observations_times_valid" CHECK("provider_price_observations"."expires_at" > "provider_price_observations"."observed_at"),
	CONSTRAINT "provider_price_observations_raw_valid" CHECK(json_valid("provider_price_observations"."raw_observation_json"))
);
--> statement-breakpoint
CREATE INDEX `provider_price_observations_profile_expiry_idx` ON `provider_price_observations` (`runtime_profile_id`,`expires_at`);--> statement-breakpoint
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
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`latest_report_id`) REFERENCES `runtime_guest_reports`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runtime_actual_state_source_valid" CHECK("runtime_actual_state"."source_kind" in ('agent_report', 'guest_report', 'provider_observation')),
	CONSTRAINT "runtime_actual_state_sequence_valid" CHECK("runtime_actual_state"."generation" > 0 AND "runtime_actual_state"."sequence" >= 0)
);
--> statement-breakpoint
CREATE INDEX `runtime_actual_state_source_idx` ON `runtime_actual_state` (`source_kind`,`source_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `runtime_allocation_locks` (
	`key` text PRIMARY KEY NOT NULL,
	`owner_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT "runtime_allocation_locks_expiry_valid" CHECK("runtime_allocation_locks"."expires_at" > 0)
);
--> statement-breakpoint
CREATE INDEX `runtime_allocation_locks_expiry_idx` ON `runtime_allocation_locks` (`expires_at`);--> statement-breakpoint
CREATE TABLE `runtime_artifact_upload_grants` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`generation` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `runtime_artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runtime_artifact_upload_grants_generation_valid" CHECK("runtime_artifact_upload_grants"."generation" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_artifact_upload_grants_token_hash_uidx` ON `runtime_artifact_upload_grants` (`token_hash`);--> statement-breakpoint
CREATE INDEX `runtime_artifact_upload_grants_execution_expiry_idx` ON `runtime_artifact_upload_grants` (`execution_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `runtime_artifact_uploads` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`r2_upload_id` text,
	`uploaded_parts_json` text DEFAULT '[]' NOT NULL,
	`next_expected_part` integer NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `runtime_artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runtime_artifact_uploads_next_part_positive" CHECK("runtime_artifact_uploads"."next_expected_part" > 0),
	CONSTRAINT "runtime_artifact_uploads_parts_json_valid" CHECK(json_valid("runtime_artifact_uploads"."uploaded_parts_json"))
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
	CONSTRAINT "runtime_artifacts_ordinal_valid" CHECK("runtime_artifacts"."ordinal" >= 0),
	CONSTRAINT "runtime_artifacts_size_valid" CHECK("runtime_artifacts"."size_bytes" >= 0),
	CONSTRAINT "runtime_artifacts_upload_status_valid" CHECK("runtime_artifacts"."upload_status" in ('pending', 'uploaded')),
	CONSTRAINT "runtime_artifacts_uploaded_at_valid" CHECK(("runtime_artifacts"."upload_status" = 'pending' AND "runtime_artifacts"."uploaded_at" is null) OR ("runtime_artifacts"."upload_status" = 'uploaded' AND "runtime_artifacts"."uploaded_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_artifacts_vm_ordinal_uidx` ON `runtime_artifacts` (`runtime_vm_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `runtime_artifacts_execution_idx` ON `runtime_artifacts` (`execution_id`,`runtime_vm_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `runtime_artifacts_r2_key_idx` ON `runtime_artifacts` (`r2_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_artifacts_terminal_recording_content_uidx` ON `runtime_artifacts` (`runtime_vm_id`,`kind`,`sha256`,`size_bytes`) WHERE "runtime_artifacts"."kind" = 'terminal_recording';--> statement-breakpoint
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
	FOREIGN KEY (`template_revision_id`) REFERENCES `workshop_template_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runtime_checkpoint_bundles_payload_valid" CHECK("runtime_checkpoint_bundles"."format" = 'direct_cloud_linux_x86_64_v1' AND "runtime_checkpoint_bundles"."compression" = 'zstd' AND "runtime_checkpoint_bundles"."size_bytes" > 0 AND length("runtime_checkpoint_bundles"."sha256") = 64),
	CONSTRAINT "runtime_checkpoint_bundles_tools_valid" CHECK(length("runtime_checkpoint_bundles"."workspace_agent_sha256") = 64 AND length("runtime_checkpoint_bundles"."kino_sha256") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_checkpoint_bundles_revision_checkpoint_uidx` ON `runtime_checkpoint_bundles` (`template_revision_id`,`checkpoint_id`);--> statement-breakpoint
CREATE INDEX `runtime_checkpoint_bundles_content_idx` ON `runtime_checkpoint_bundles` (`sha256`,`size_bytes`);--> statement-breakpoint
CREATE TABLE `runtime_executions` (
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
	CONSTRAINT "runtime_executions_domain_kind_valid" CHECK("runtime_executions"."domain_kind" in ('scenario', 'workshop', 'workshop_certification')),
	CONSTRAINT "runtime_executions_provider_kind_valid" CHECK("runtime_executions"."provider_kind" in ('agent_kvm', 'hetzner_cloud', 'gcp_compute')),
	CONSTRAINT "runtime_executions_provider_identity_valid" CHECK(("runtime_executions"."provider_kind" = 'agent_kvm' AND "runtime_executions"."provider_connection_id" is null) OR ("runtime_executions"."provider_kind" in ('hetzner_cloud', 'gcp_compute') AND "runtime_executions"."domain_kind" in ('workshop', 'workshop_certification') AND "runtime_executions"."provider_connection_id" is not null AND "runtime_executions"."host_id" is null)),
	CONSTRAINT "runtime_executions_generation_positive" CHECK("runtime_executions"."generation" > 0),
	CONSTRAINT "runtime_executions_state_valid" CHECK("runtime_executions"."state" in ('queued', 'provisioning', 'ready', 'archiving', 'archived', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_executions_domain_generation_uidx` ON `runtime_executions` (`domain_kind`,`domain_id`,`generation`);--> statement-breakpoint
CREATE INDEX `runtime_executions_user_state_idx` ON `runtime_executions` (`user_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `runtime_executions_organization_state_idx` ON `runtime_executions` (`organization_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `runtime_executions_host_state_idx` ON `runtime_executions` (`host_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `runtime_executions_source_idx` ON `runtime_executions` (`source_execution_id`);--> statement-breakpoint
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
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`checkpoint_bundle_id`) REFERENCES `runtime_checkpoint_bundles`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runtime_guest_credentials_generation_valid" CHECK("runtime_guest_credentials"."generation" > 0),
	CONSTRAINT "runtime_guest_credentials_lifecycle_valid" CHECK(("runtime_guest_credentials"."bootstrap_consumed_at" is null AND "runtime_guest_credentials"."report_credential_hash" is null AND "runtime_guest_credentials"."report_credential_issued_at" is null AND "runtime_guest_credentials"."checkpoint_download_token_hash" is null AND "runtime_guest_credentials"."checkpoint_download_expires_at" is null) OR ("runtime_guest_credentials"."bootstrap_consumed_at" is not null AND "runtime_guest_credentials"."report_credential_hash" is not null AND "runtime_guest_credentials"."report_credential_issued_at" is not null AND "runtime_guest_credentials"."checkpoint_download_token_hash" is not null AND "runtime_guest_credentials"."checkpoint_download_expires_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_guest_credentials_execution_uidx` ON `runtime_guest_credentials` (`execution_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_guest_credentials_bootstrap_hash_uidx` ON `runtime_guest_credentials` (`bootstrap_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_guest_credentials_report_hash_uidx` ON `runtime_guest_credentials` (`report_credential_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_guest_credentials_checkpoint_hash_uidx` ON `runtime_guest_credentials` (`checkpoint_download_token_hash`);--> statement-breakpoint
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
	`terminal_ready` integer DEFAULT false NOT NULL,
	`ssh_host_key_openssh` text,
	`probes_json` text DEFAULT '[]' NOT NULL,
	`completed_module_ids_json` text DEFAULT '[]' NOT NULL,
	`report_json` text NOT NULL,
	`reported_at` integer NOT NULL,
	`received_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runtime_guest_reports_provider_valid" CHECK("runtime_guest_reports"."provider_kind" in ('agent_kvm', 'hetzner_cloud', 'gcp_compute')),
	CONSTRAINT "runtime_guest_reports_sequence_valid" CHECK("runtime_guest_reports"."generation" > 0 AND "runtime_guest_reports"."sequence" >= 0),
	CONSTRAINT "runtime_guest_reports_boot_id_valid" CHECK(length("runtime_guest_reports"."boot_id") = 36 AND lower("runtime_guest_reports"."boot_id") = "runtime_guest_reports"."boot_id"),
	CONSTRAINT "runtime_guest_reports_json_valid" CHECK(json_valid("runtime_guest_reports"."probes_json") AND json_valid("runtime_guest_reports"."completed_module_ids_json") AND json_valid("runtime_guest_reports"."report_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_guest_reports_generation_sequence_uidx` ON `runtime_guest_reports` (`execution_id`,`generation`,`sequence`);--> statement-breakpoint
CREATE INDEX `runtime_guest_reports_execution_received_idx` ON `runtime_guest_reports` (`execution_id`,`received_at`);--> statement-breakpoint
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
	`fallback_pending` integer DEFAULT false NOT NULL,
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
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`runtime_profile_id`) REFERENCES `workshop_runtime_profiles`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`price_observation_id`) REFERENCES `provider_price_observations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`cost_forecast_id`) REFERENCES `workshop_session_cost_forecasts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runtime_provider_allocations_kind_valid" CHECK("runtime_provider_allocations"."provider_kind" in ('hetzner_cloud', 'gcp_compute')),
	CONSTRAINT "runtime_provider_allocations_state_valid" CHECK("runtime_provider_allocations"."state" in ('pending', 'creating', 'bootstrapping', 'ready', 'degraded', 'rebooting', 'draining', 'deleting', 'deleted', 'cleanup_pending', 'failed')),
	CONSTRAINT "runtime_provider_allocations_counters_valid" CHECK("runtime_provider_allocations"."retry_count" >= 0 AND "runtime_provider_allocations"."last_report_sequence" >= 0 AND "runtime_provider_allocations"."location_attempt" > 0),
	CONSTRAINT "runtime_provider_allocations_locations_valid" CHECK(json_valid("runtime_provider_allocations"."location_attempts_json") AND json_array_length("runtime_provider_allocations"."location_attempts_json") >= "runtime_provider_allocations"."location_attempt" AND json_extract("runtime_provider_allocations"."location_attempts_json", '$[' || ("runtime_provider_allocations"."location_attempt" - 1) || ']') = "runtime_provider_allocations"."location"),
	CONSTRAINT "runtime_provider_allocations_drain_valid" CHECK("runtime_provider_allocations"."recording_drain_completed_at" is null OR ("runtime_provider_allocations"."recording_drain_requested_at" is not null AND "runtime_provider_allocations"."recording_drain_completed_at" >= "runtime_provider_allocations"."recording_drain_requested_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_allocations_execution_uidx` ON `runtime_provider_allocations` (`execution_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_allocations_connection_name_uidx` ON `runtime_provider_allocations` (`connection_id`,`deterministic_name`);--> statement-breakpoint
CREATE INDEX `runtime_provider_allocations_state_updated_idx` ON `runtime_provider_allocations` (`provider_kind`,`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `runtime_provider_allocations_price_attribution_idx` ON `runtime_provider_allocations` (`price_observation_id`,`cost_forecast_id`);--> statement-breakpoint
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
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`allocation_id`) REFERENCES `runtime_provider_allocations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`provider_resource_id`) REFERENCES `runtime_provider_resources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`forecast_id`) REFERENCES `workshop_session_cost_forecasts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`price_line_item_id`) REFERENCES `provider_price_line_items`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runtime_provider_cost_ledger_provider_valid" CHECK("runtime_provider_cost_ledger"."provider_kind" in ('hetzner_cloud', 'gcp_compute')),
	CONSTRAINT "runtime_provider_cost_ledger_values_valid" CHECK("runtime_provider_cost_ledger"."price_nanos" >= 0 AND "runtime_provider_cost_ledger"."quantity_nanos" > 0 AND "runtime_provider_cost_ledger"."billing_increment_seconds" > 0 AND "runtime_provider_cost_ledger"."minimum_duration_seconds" >= 0 AND ("runtime_provider_cost_ledger"."cap_price_nanos" is null OR "runtime_provider_cost_ledger"."cap_price_nanos" >= 0) AND ("runtime_provider_cost_ledger"."final_cost_nanos" is null OR "runtime_provider_cost_ledger"."final_cost_nanos" >= 0)),
	CONSTRAINT "runtime_provider_cost_ledger_lifecycle_valid" CHECK(("runtime_provider_cost_ledger"."deletion_confirmed_at" is null AND "runtime_provider_cost_ledger"."final_cost_nanos" is null) OR ("runtime_provider_cost_ledger"."deletion_confirmed_at" is not null AND "runtime_provider_cost_ledger"."deletion_confirmed_at" >= "runtime_provider_cost_ledger"."provider_created_at" AND "runtime_provider_cost_ledger"."final_cost_nanos" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_cost_ledger_resource_sku_tax_uidx` ON `runtime_provider_cost_ledger` (`provider_resource_id`,`sku`,`tax_treatment`);--> statement-breakpoint
CREATE INDEX `runtime_provider_cost_ledger_execution_idx` ON `runtime_provider_cost_ledger` (`execution_id`,`provider_created_at`);--> statement-breakpoint
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
	FOREIGN KEY (`allocation_id`) REFERENCES `runtime_provider_allocations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runtime_provider_operations_provider_valid" CHECK("runtime_provider_operations"."provider_kind" in ('hetzner_cloud', 'gcp_compute')),
	CONSTRAINT "runtime_provider_operations_state_valid" CHECK("runtime_provider_operations"."state" in ('pending', 'running', 'succeeded', 'retryable', 'failed')),
	CONSTRAINT "runtime_provider_operations_attempt_valid" CHECK("runtime_provider_operations"."attempt" > 0 AND "runtime_provider_operations"."location_attempt" > 0),
	CONSTRAINT "runtime_provider_operations_result_valid" CHECK("runtime_provider_operations"."sanitized_result_json" is null OR json_valid("runtime_provider_operations"."sanitized_result_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_operations_request_uidx` ON `runtime_provider_operations` (`provider_kind`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_operations_allocation_external_uidx` ON `runtime_provider_operations` (`allocation_id`,`location_attempt`,`provider_operation_id`);--> statement-breakpoint
CREATE INDEX `runtime_provider_operations_sweep_idx` ON `runtime_provider_operations` (`state`,`retry_at`,`updated_at`);--> statement-breakpoint
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
	FOREIGN KEY (`allocation_id`) REFERENCES `runtime_provider_allocations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runtime_provider_reconciliation_claim_valid" CHECK(("runtime_provider_reconciliation"."claim_id" is null AND "runtime_provider_reconciliation"."claim_expires_at" is null) OR ("runtime_provider_reconciliation"."claim_id" is not null AND "runtime_provider_reconciliation"."claim_expires_at" is not null)),
	CONSTRAINT "runtime_provider_reconciliation_failures_valid" CHECK("runtime_provider_reconciliation"."consecutive_failures" >= 0)
);
--> statement-breakpoint
CREATE INDEX `runtime_provider_reconciliation_sweep_idx` ON `runtime_provider_reconciliation` (`sweep_after`,`claim_expires_at`);--> statement-breakpoint
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
	FOREIGN KEY (`allocation_id`) REFERENCES `runtime_provider_allocations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runtime_provider_resources_provider_valid" CHECK("runtime_provider_resources"."provider_kind" in ('hetzner_cloud', 'gcp_compute')),
	CONSTRAINT "runtime_provider_resources_kind_valid" CHECK("runtime_provider_resources"."resource_kind" in ('instance', 'boot_disk', 'ipv4', 'ssh_key')),
	CONSTRAINT "runtime_provider_resources_attempt_valid" CHECK("runtime_provider_resources"."location_attempt" > 0),
	CONSTRAINT "runtime_provider_resources_configuration_valid" CHECK(json_valid("runtime_provider_resources"."configuration_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_provider_resources_allocation_kind_uidx` ON `runtime_provider_resources` (`allocation_id`,`location_attempt`,`resource_kind`);--> statement-breakpoint
CREATE INDEX `runtime_provider_resources_external_idx` ON `runtime_provider_resources` (`provider_kind`,`resource_kind`,`provider_resource_id`);--> statement-breakpoint
CREATE INDEX `runtime_provider_resources_allocation_idx` ON `runtime_provider_resources` (`allocation_id`,`resource_kind`);--> statement-breakpoint
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
	CONSTRAINT "runtime_terminal_sessions_ordinal_valid" CHECK("runtime_terminal_sessions"."ordinal" >= 0),
	CONSTRAINT "runtime_terminal_sessions_duration_valid" CHECK("runtime_terminal_sessions"."ended_at" is null OR "runtime_terminal_sessions"."ended_at" >= "runtime_terminal_sessions"."started_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_terminal_sessions_vm_ordinal_uidx` ON `runtime_terminal_sessions` (`runtime_vm_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `runtime_terminal_sessions_execution_idx` ON `runtime_terminal_sessions` (`execution_id`,`runtime_vm_id`,`started_at`);--> statement-breakpoint
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
CREATE INDEX `runtime_vm_access_keys_execution_idx` ON `runtime_vm_access_keys` (`execution_id`);--> statement-breakpoint
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
	CONSTRAINT "runtime_vm_actual_state_phase_valid" CHECK("runtime_vm_actual_state"."phase" in ('pending', 'pulling_image', 'creating_disks', 'booting', 'running', 'ready', 'solved', 'stopping', 'stopped', 'failed', 'absent')),
	CONSTRAINT "runtime_vm_actual_state_desired_version_valid" CHECK("runtime_vm_actual_state"."desired_version" is null OR "runtime_vm_actual_state"."desired_version" >= 0),
	CONSTRAINT "runtime_vm_actual_state_report_json_valid" CHECK(json_valid("runtime_vm_actual_state"."report_json"))
);
--> statement-breakpoint
CREATE INDEX `runtime_vm_actual_state_execution_idx` ON `runtime_vm_actual_state` (`execution_id`,`phase`);--> statement-breakpoint
CREATE INDEX `runtime_vm_actual_state_host_observed_idx` ON `runtime_vm_actual_state` (`host_id`,`observed_at`);--> statement-breakpoint
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
	`artifact_writes_sealed` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "runtime_vms_ordinal_valid" CHECK("runtime_vms"."ordinal" >= 0),
	CONSTRAINT "runtime_vms_cpu_positive" CHECK("runtime_vms"."cpu_millis" > 0),
	CONSTRAINT "runtime_vms_memory_positive" CHECK("runtime_vms"."memory_mib" > 0),
	CONSTRAINT "runtime_vms_disk_positive" CHECK("runtime_vms"."disk_mib" > 0),
	CONSTRAINT "runtime_vms_terminal_target_complete" CHECK(("runtime_vms"."terminal_host" is null AND "runtime_vms"."terminal_port" is null AND "runtime_vms"."terminal_username" is null AND "runtime_vms"."terminal_host_key_openssh" is null AND "runtime_vms"."terminal_private_key_ciphertext_b64" is null AND "runtime_vms"."terminal_private_key_iv_b64" is null AND "runtime_vms"."terminal_observed_at" is null) OR ("runtime_vms"."terminal_host" is not null AND "runtime_vms"."terminal_port" > 0 AND "runtime_vms"."terminal_username" is not null AND "runtime_vms"."terminal_host_key_openssh" is not null AND "runtime_vms"."terminal_private_key_ciphertext_b64" is not null AND "runtime_vms"."terminal_private_key_iv_b64" is not null AND "runtime_vms"."terminal_observed_at" is not null)),
	CONSTRAINT "runtime_vms_image_key_json_valid" CHECK(json_valid("runtime_vms"."image_key_json")),
	CONSTRAINT "runtime_vms_artifact_writes_sealed_valid" CHECK("runtime_vms"."artifact_writes_sealed" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_vms_execution_vm_uidx` ON `runtime_vms` (`execution_id`,`vm_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_vms_execution_ordinal_uidx` ON `runtime_vms` (`execution_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_vms_execution_name_uidx` ON `runtime_vms` (`execution_id`,`runtime_vm_name`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `scenario_assignments_org_scenario_uidx` ON `scenario_assignments` (`organization_id`,`scenario_id`);--> statement-breakpoint
CREATE TABLE `scenario_course_catalogs` (
	`scope_key` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`courses_json` text NOT NULL,
	`source_revision` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "scenario_course_catalogs_scope_check" CHECK(("scenario_course_catalogs"."scope_key" = 'public' AND "scenario_course_catalogs"."organization_id" IS NULL) OR ("scenario_course_catalogs"."scope_key" = 'organization:' || "scenario_course_catalogs"."organization_id" AND "scenario_course_catalogs"."organization_id" IS NOT NULL)),
	CONSTRAINT "scenario_course_catalogs_courses_json_check" CHECK(json_valid("scenario_course_catalogs"."courses_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_course_catalogs_organization_uidx` ON `scenario_course_catalogs` (`organization_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `scenario_run_session_transcripts_session_uidx` ON `scenario_run_session_transcripts` (`run_id`,`vm_id`,`session_index`);--> statement-breakpoint
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
	`organization_id` text,
	`runtime_execution_id` text,
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
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`runtime_execution_id`) REFERENCES `runtime_executions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_runs_active_key_uidx` ON `scenario_runs` (`active_key`);--> statement-breakpoint
CREATE INDEX `scenario_runs_user_scenario_idx` ON `scenario_runs` (`user_id`,`scenario_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `scenario_runs_host_idx` ON `scenario_runs` (`host_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `scenario_runs_organization_idx` ON `scenario_runs` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_runs_runtime_execution_uidx` ON `scenario_runs` (`runtime_execution_id`);--> statement-breakpoint
CREATE TABLE `scenario_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`scenario_id` text NOT NULL,
	`organization_id` text,
	`hcl` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenario_sources_scenario_uidx` ON `scenario_sources` (`scenario_id`);--> statement-breakpoint
CREATE INDEX `scenario_sources_organization_idx` ON `scenario_sources` (`organization_id`,`updated_at`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `sso_provider_provider_id_unique` ON `sso_provider` (`provider_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sso_provider_provider_id_uidx` ON `sso_provider` (`provider_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sso_provider_organization_id_uidx` ON `sso_provider` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sso_provider_domain_uidx` ON `sso_provider` (`domain`);--> statement-breakpoint
CREATE INDEX `sso_provider_user_id_idx` ON `sso_provider` (`user_id`);--> statement-breakpoint
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
	`title` text,
	`body_markdown` text,
	`hints_json` text NOT NULL,
	`phase` text DEFAULT 'scenario' NOT NULL,
	`kind` text DEFAULT 'probe' NOT NULL,
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
	`image_format` text NOT NULL,
	`image_virtual_size_bytes` integer NOT NULL,
	`kernel_sha256` text NOT NULL,
	`initrd_sha256` text NOT NULL,
	`boot_cmdline` text NOT NULL,
	`cpu_millis` integer DEFAULT 1000 NOT NULL,
	`vcpu_count` integer DEFAULT 1 NOT NULL,
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
	`organization_id` text,
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
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `vm_scenarios_enabled_idx` ON `vm_scenarios` (`enabled`,`enabled_at`);--> statement-breakpoint
CREATE INDEX `vm_scenarios_organization_enabled_idx` ON `vm_scenarios` (`organization_id`,`enabled`,`enabled_at`);--> statement-breakpoint
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
	CONSTRAINT "workshop_assist_grants_duration_valid" CHECK("workshop_assist_grants"."expires_at" > "workshop_assist_grants"."granted_at" AND "workshop_assist_grants"."expires_at" <= "workshop_assist_grants"."granted_at" + 1800000),
	CONSTRAINT "workshop_assist_grants_terminal_routes_json_valid" CHECK(json_valid("workshop_assist_grants"."terminal_route_usernames_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_assist_grants_help_request_uidx` ON `workshop_assist_grants` (`help_request_id`);--> statement-breakpoint
CREATE INDEX `workshop_assist_grants_helper_expiry_idx` ON `workshop_assist_grants` (`helper_user_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `workshop_assist_grants_workspace_expiry_idx` ON `workshop_assist_grants` (`workspace_id`,`expires_at`);--> statement-breakpoint
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
	CONSTRAINT "workshop_events_payload_json_valid" CHECK(json_valid("workshop_events"."payload_json"))
);
--> statement-breakpoint
CREATE INDEX `workshop_events_session_created_idx` ON `workshop_events` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `workshop_events_org_created_idx` ON `workshop_events` (`organization_id`,`created_at`);--> statement-breakpoint
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
	CONSTRAINT "workshop_help_requests_status_valid" CHECK("workshop_help_requests"."status" in ('open', 'claimed', 'resolved', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_help_requests_active_key_uidx` ON `workshop_help_requests` (`active_key`);--> statement-breakpoint
CREATE INDEX `workshop_help_requests_session_status_idx` ON `workshop_help_requests` (`session_id`,`status`,`created_at`);--> statement-breakpoint
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
	CONSTRAINT "workshop_module_progress_technical_status_valid" CHECK("workshop_module_progress"."technical_status" in ('not_started', 'working', 'verified', 'caught_up', 'manually_completed', 'skipped')),
	CONSTRAINT "workshop_module_progress_current_health_valid" CHECK("workshop_module_progress"."current_health" in ('unknown', 'passing', 'failing')),
	CONSTRAINT "workshop_module_progress_explain_back_status_valid" CHECK("workshop_module_progress"."explain_back_status" in ('not_required', 'pending', 'completed')),
	CONSTRAINT "workshop_module_progress_revealed_hints_json_valid" CHECK(json_valid("workshop_module_progress"."revealed_hint_ids_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_module_progress_session_user_module_uidx` ON `workshop_module_progress` (`session_id`,`user_id`,`module_id`);--> statement-breakpoint
CREATE INDEX `workshop_module_progress_session_module_idx` ON `workshop_module_progress` (`session_id`,`module_id`,`technical_status`);--> statement-breakpoint
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
	CONSTRAINT "workshop_publication_checkpoints_status_valid" CHECK("workshop_publication_checkpoints"."status" in ('pending', 'building', 'verified', 'failed')),
	CONSTRAINT "workshop_publication_checkpoints_images_json_valid" CHECK("workshop_publication_checkpoints"."vm_images_json" is null OR json_valid("workshop_publication_checkpoints"."vm_images_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_publication_checkpoints_uidx` ON `workshop_publication_checkpoints` (`publication_id`,`checkpoint_id`);--> statement-breakpoint
CREATE INDEX `workshop_publication_checkpoints_status_idx` ON `workshop_publication_checkpoints` (`publication_id`,`status`);--> statement-breakpoint
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
	`claim_expires_at` integer,
	`runtime_profile_resolutions_json` text DEFAULT '[]' NOT NULL,
	`certification_state` text,
	`finished_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`registry_token_id`) REFERENCES `workshop_registry_tokens`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`builder_host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`published_revision_id`) REFERENCES `workshop_template_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "workshop_publications_status_valid" CHECK("workshop_publications"."status" in ('queued', 'building', 'failed', 'published')),
	CONSTRAINT "workshop_publications_manifest_json_valid" CHECK(json_valid("workshop_publications"."compiled_manifest_json")),
	CONSTRAINT "workshop_publications_checkpoints_json_valid" CHECK(json_valid("workshop_publications"."required_checkpoint_ids_json")),
	CONSTRAINT "workshop_publications_certification_state_valid" CHECK("workshop_publications"."certification_state" is null OR "workshop_publications"."certification_state" in ('verifying', 'verified', 'failed', 'cleanup_pending')),
	CONSTRAINT "workshop_publications_runtime_profiles_json_valid" CHECK(json_valid("workshop_publications"."runtime_profile_resolutions_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_publications_org_hash_active_uidx` ON `workshop_publications` (`organization_id`,`content_hash`) WHERE "workshop_publications"."status" <> 'failed';--> statement-breakpoint
CREATE INDEX `workshop_publications_status_created_idx` ON `workshop_publications` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `workshop_publications_builder_status_idx` ON `workshop_publications` (`builder_host_id`,`status`);--> statement-breakpoint
CREATE INDEX `workshop_publications_claim_lease_idx` ON `workshop_publications` (`status`,`claim_expires_at`,`created_at`);--> statement-breakpoint
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
	CONSTRAINT "workshop_registry_tokens_expiry_valid" CHECK("workshop_registry_tokens"."expires_at" is null OR "workshop_registry_tokens"."expires_at" > "workshop_registry_tokens"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_registry_tokens_hash_uidx` ON `workshop_registry_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `workshop_registry_tokens_org_created_idx` ON `workshop_registry_tokens` (`organization_id`,`created_at`);--> statement-breakpoint
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
	CONSTRAINT "workshop_route_issuance_intents_kind_valid" CHECK("workshop_route_issuance_intents"."kind" in ('terminal', 'application')),
	CONSTRAINT "workshop_route_issuance_intents_state_valid" CHECK("workshop_route_issuance_intents"."state" in ('pending', 'issued', 'cancelled')),
	CONSTRAINT "workshop_route_issuance_intents_expiry_valid" CHECK("workshop_route_issuance_intents"."capability_expires_at" >= "workshop_route_issuance_intents"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_route_issuance_intents_route_uidx` ON `workshop_route_issuance_intents` (`kind`,`route_key`);--> statement-breakpoint
CREATE INDEX `workshop_route_issuance_intents_member_idx` ON `workshop_route_issuance_intents` (`organization_id`,`actor_user_id`,`state`,`created_at`);--> statement-breakpoint
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
	FOREIGN KEY (`runtime_profile_id`) REFERENCES `workshop_runtime_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "workshop_runtime_profile_certifications_state_valid" CHECK("workshop_runtime_profile_certifications"."state" in ('pending', 'verifying', 'verified', 'failed', 'cleanup_pending')),
	CONSTRAINT "workshop_runtime_profile_certifications_evidence_valid" CHECK(json_valid("workshop_runtime_profile_certifications"."evidence_json")),
	CONSTRAINT "workshop_runtime_profile_certifications_verified_valid" CHECK("workshop_runtime_profile_certifications"."state" != 'verified' OR ("workshop_runtime_profile_certifications"."verified_at" is not null AND "workshop_runtime_profile_certifications"."deletion_confirmed_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_runtime_profile_certifications_profile_uidx` ON `workshop_runtime_profile_certifications` (`runtime_profile_id`);--> statement-breakpoint
CREATE INDEX `workshop_runtime_profile_certifications_state_idx` ON `workshop_runtime_profile_certifications` (`state`,`updated_at`);--> statement-breakpoint
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
	FOREIGN KEY (`template_revision_id`) REFERENCES `workshop_template_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workshop_runtime_profiles_provider_valid" CHECK("workshop_runtime_profiles"."provider_kind" in ('agent_kvm', 'hetzner_cloud', 'gcp_compute')),
	CONSTRAINT "workshop_runtime_profiles_shape_valid" CHECK("workshop_runtime_profiles"."architecture" = 'x86_64' AND "workshop_runtime_profiles"."cpu_millis" > 0 AND "workshop_runtime_profiles"."memory_mib" > 0 AND "workshop_runtime_profiles"."disk_mib" > 0),
	CONSTRAINT "workshop_runtime_profiles_json_valid" CHECK(json_valid("workshop_runtime_profiles"."locations_json") AND json_valid("workshop_runtime_profiles"."configuration_json")),
	CONSTRAINT "workshop_runtime_profiles_provider_fields_valid" CHECK(("workshop_runtime_profiles"."provider_kind" = 'agent_kvm') OR ("workshop_runtime_profiles"."machine_type" is not null AND "workshop_runtime_profiles"."resolved_image_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_runtime_profiles_revision_profile_uidx` ON `workshop_runtime_profiles` (`template_revision_id`,`profile_id`);--> statement-breakpoint
CREATE INDEX `workshop_runtime_profiles_revision_provider_idx` ON `workshop_runtime_profiles` (`template_revision_id`,`provider_kind`);--> statement-breakpoint
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
	FOREIGN KEY (`forecast_id`) REFERENCES `workshop_session_cost_forecasts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`price_line_item_id`) REFERENCES `provider_price_line_items`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "workshop_session_cost_forecast_line_items_scenario_valid" CHECK("workshop_session_cost_forecast_line_items"."scenario" in ('expected', 'lease_ceiling', 'one_restore')),
	CONSTRAINT "workshop_session_cost_forecast_line_items_values_valid" CHECK("workshop_session_cost_forecast_line_items"."participant_count" >= 0 AND "workshop_session_cost_forecast_line_items"."generation_count" > 0 AND "workshop_session_cost_forecast_line_items"."lifetime_seconds" >= 0 AND "workshop_session_cost_forecast_line_items"."billed_quantity_nanos" >= 0 AND "workshop_session_cost_forecast_line_items"."calculated_cost_nanos" >= 0),
	CONSTRAINT "workshop_session_cost_forecast_line_items_calculation_valid" CHECK(json_valid("workshop_session_cost_forecast_line_items"."calculation_json"))
);
--> statement-breakpoint
CREATE INDEX `workshop_session_cost_forecast_line_items_scenario_idx` ON `workshop_session_cost_forecast_line_items` (`forecast_id`,`scenario`);--> statement-breakpoint
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
	`exceeds_budget_ceiling` integer DEFAULT false NOT NULL,
	`assumptions_json` text NOT NULL,
	`exclusions_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`price_observation_id`) REFERENCES `provider_price_observations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "workshop_session_cost_forecasts_provider_valid" CHECK("workshop_session_cost_forecasts"."provider_kind" in ('agent_kvm', 'hetzner_cloud', 'gcp_compute')),
	CONSTRAINT "workshop_session_cost_forecasts_values_valid" CHECK("workshop_session_cost_forecasts"."version" > 0 AND "workshop_session_cost_forecasts"."participant_count" >= 0 AND "workshop_session_cost_forecasts"."expected_cost_nanos" >= 0 AND "workshop_session_cost_forecasts"."lease_ceiling_cost_nanos" >= 0 AND "workshop_session_cost_forecasts"."one_restore_cost_nanos" >= 0),
	CONSTRAINT "workshop_session_cost_forecasts_json_valid" CHECK(json_valid("workshop_session_cost_forecasts"."assumptions_json") AND json_valid("workshop_session_cost_forecasts"."exclusions_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_session_cost_forecasts_version_uidx` ON `workshop_session_cost_forecasts` (`session_id`,`version`);--> statement-breakpoint
CREATE INDEX `workshop_session_cost_forecasts_expiry_idx` ON `workshop_session_cost_forecasts` (`session_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `workshop_session_cost_summaries` (
	`session_id` text PRIMARY KEY NOT NULL,
	`currency` text NOT NULL,
	`final_cost_nanos` integer,
	`forecast_variance_nanos` integer,
	`generation_count` integer DEFAULT 0 NOT NULL,
	`restore_count` integer DEFAULT 0 NOT NULL,
	`cleanup_pending_count` integer DEFAULT 0 NOT NULL,
	`manual_cleanup_unverified` integer DEFAULT false NOT NULL,
	`finalized_at` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workshop_session_cost_summaries_counts_valid" CHECK("workshop_session_cost_summaries"."generation_count" >= 0 AND "workshop_session_cost_summaries"."restore_count" >= 0 AND "workshop_session_cost_summaries"."cleanup_pending_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `workshop_session_members` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`workspace_enabled` integer DEFAULT false NOT NULL,
	`checked_in_at` integer,
	`last_seen_at` integer,
	`provision_state` text DEFAULT 'not_ready' NOT NULL,
	`provision_error` text,
	`assigned_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assigned_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "workshop_session_members_role_valid" CHECK("workshop_session_members"."role" in ('participant', 'helper', 'facilitator')),
	CONSTRAINT "workshop_session_members_provision_state_valid" CHECK("workshop_session_members"."provision_state" in ('not_ready', 'queued', 'provisioning', 'ready', 'failed', 'ended')),
	CONSTRAINT "workshop_session_members_workspace_enabled_valid" CHECK("workshop_session_members"."workspace_enabled" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_session_members_session_user_uidx` ON `workshop_session_members` (`session_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `workshop_session_members_session_role_idx` ON `workshop_session_members` (`session_id`,`role`,`provision_state`);--> statement-breakpoint
CREATE INDEX `workshop_session_members_session_workspace_idx` ON `workshop_session_members` (`session_id`,`workspace_enabled`,`provision_state`);--> statement-breakpoint
CREATE INDEX `workshop_session_members_session_last_seen_idx` ON `workshop_session_members` (`session_id`,`last_seen_at`);--> statement-breakpoint
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
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runtime_profile_id`) REFERENCES `workshop_runtime_profiles`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`gross_ceiling_override_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "workshop_session_runtime_selections_provider_valid" CHECK("workshop_session_runtime_selections"."provider_kind" in ('agent_kvm', 'hetzner_cloud', 'gcp_compute')),
	CONSTRAINT "workshop_session_runtime_selections_connection_valid" CHECK(("workshop_session_runtime_selections"."provider_kind" = 'agent_kvm' AND "workshop_session_runtime_selections"."connection_id" is null) OR ("workshop_session_runtime_selections"."provider_kind" in ('hetzner_cloud', 'gcp_compute') AND "workshop_session_runtime_selections"."connection_id" is not null)),
	CONSTRAINT "workshop_session_runtime_selections_profile_valid" CHECK(json_valid("workshop_session_runtime_selections"."resolved_profile_json")),
	CONSTRAINT "workshop_session_runtime_selections_preflight_json_valid" CHECK(json_valid("workshop_session_runtime_selections"."preflight_reasons_json")),
	CONSTRAINT "workshop_session_runtime_selections_preflight_valid" CHECK(("workshop_session_runtime_selections"."preflight_checked_at" is null AND "workshop_session_runtime_selections"."preflight_expires_at" is null AND "workshop_session_runtime_selections"."preflight_requested_seats" is null AND "workshop_session_runtime_selections"."preflight_available_seats" is null AND "workshop_session_runtime_selections"."preflight_ok" is null) OR ("workshop_session_runtime_selections"."preflight_checked_at" is not null AND "workshop_session_runtime_selections"."preflight_expires_at" >= "workshop_session_runtime_selections"."preflight_checked_at" AND "workshop_session_runtime_selections"."preflight_requested_seats" >= 0 AND "workshop_session_runtime_selections"."preflight_available_seats" >= 0 AND "workshop_session_runtime_selections"."preflight_available_seats" <= "workshop_session_runtime_selections"."preflight_requested_seats" AND "workshop_session_runtime_selections"."preflight_ok" in (0, 1)))
);
--> statement-breakpoint
CREATE INDEX `workshop_session_runtime_selections_connection_idx` ON `workshop_session_runtime_selections` (`connection_id`,`provider_kind`);--> statement-breakpoint
CREATE TABLE `workshop_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`template_revision_id` text NOT NULL,
	`title` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`scheduled_start_at` integer NOT NULL,
	`lobby_opens_at` integer NOT NULL,
	`current_agenda_item_id` text,
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
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`template_revision_id`) REFERENCES `workshop_template_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "workshop_sessions_state_valid" CHECK("workshop_sessions"."state" in ('draft', 'lobby', 'live', 'ended', 'cancelled')),
	CONSTRAINT "workshop_sessions_version_positive" CHECK("workshop_sessions"."version" > 0),
	CONSTRAINT "workshop_sessions_lobby_before_start" CHECK("workshop_sessions"."lobby_opens_at" <= "workshop_sessions"."scheduled_start_at"),
	CONSTRAINT "workshop_sessions_released_modules_json_valid" CHECK(json_valid("workshop_sessions"."released_module_ids_json")),
	CONSTRAINT "workshop_sessions_revealed_hints_json_valid" CHECK(json_valid("workshop_sessions"."revealed_hint_ids_json")),
	CONSTRAINT "workshop_sessions_revealed_solutions_json_valid" CHECK(json_valid("workshop_sessions"."revealed_solution_module_ids_json"))
);
--> statement-breakpoint
CREATE INDEX `workshop_sessions_org_state_start_idx` ON `workshop_sessions` (`organization_id`,`state`,`scheduled_start_at`);--> statement-breakpoint
CREATE INDEX `workshop_sessions_revision_idx` ON `workshop_sessions` (`template_revision_id`);--> statement-breakpoint
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
	CONSTRAINT "workshop_template_revisions_revision_positive" CHECK("workshop_template_revisions"."revision" > 0),
	CONSTRAINT "workshop_template_revisions_manifest_json_valid" CHECK(json_valid("workshop_template_revisions"."manifest_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_template_revisions_number_uidx` ON `workshop_template_revisions` (`template_id`,`revision`);--> statement-breakpoint
CREATE INDEX `workshop_template_revisions_content_idx` ON `workshop_template_revisions` (`template_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `workshop_template_revisions_template_published_idx` ON `workshop_template_revisions` (`template_id`,`published_at`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `workshop_templates_org_slug_uidx` ON `workshop_templates` (`organization_id`,`slug`);--> statement-breakpoint
CREATE INDEX `workshop_templates_org_updated_idx` ON `workshop_templates` (`organization_id`,`updated_at`);--> statement-breakpoint
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
	CONSTRAINT "workshop_workspace_generations_ordinal_positive" CHECK("workshop_workspace_generations"."ordinal" > 0),
	CONSTRAINT "workshop_workspace_generations_state_valid" CHECK("workshop_workspace_generations"."state" in ('queued', 'provisioning', 'ready', 'archiving', 'archived', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_workspace_generations_ordinal_uidx` ON `workshop_workspace_generations` (`workspace_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_workspace_generations_execution_uidx` ON `workshop_workspace_generations` (`runtime_execution_id`);--> statement-breakpoint
CREATE INDEX `workshop_workspace_generations_workspace_state_idx` ON `workshop_workspace_generations` (`workspace_id`,`state`);--> statement-breakpoint
CREATE TABLE `workshop_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`current_generation_id` text,
	`last_checkpoint_id` text,
	`recovery_message` text,
	`terminal_route_usernames_json` text DEFAULT '[]' NOT NULL,
	`application_route_ids_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "workshop_workspaces_state_valid" CHECK("workshop_workspaces"."state" in ('queued', 'provisioning', 'ready', 'recovering', 'ending', 'ended', 'failed')),
	CONSTRAINT "workshop_workspaces_terminal_routes_json_valid" CHECK(json_valid("workshop_workspaces"."terminal_route_usernames_json")),
	CONSTRAINT "workshop_workspaces_application_routes_json_valid" CHECK(json_valid("workshop_workspaces"."application_route_ids_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_workspaces_session_user_uidx` ON `workshop_workspaces` (`session_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `workshop_workspaces_session_state_idx` ON `workshop_workspaces` (`session_id`,`state`);