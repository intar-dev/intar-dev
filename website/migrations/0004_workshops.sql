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
CREATE UNIQUE INDEX `workshop_templates_org_slug_uidx` ON `workshop_templates` (`organization_id`, `slug`);
CREATE INDEX `workshop_templates_org_updated_idx` ON `workshop_templates` (`organization_id`, `updated_at`);

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
CREATE UNIQUE INDEX `workshop_template_revisions_number_uidx` ON `workshop_template_revisions` (`template_id`, `revision`);
CREATE UNIQUE INDEX `workshop_template_revisions_content_uidx` ON `workshop_template_revisions` (`template_id`, `content_hash`);
CREATE INDEX `workshop_template_revisions_template_published_idx` ON `workshop_template_revisions` (`template_id`, `published_at`);

CREATE TRIGGER `workshop_template_revisions_immutable`
BEFORE UPDATE ON `workshop_template_revisions`
BEGIN
	SELECT RAISE(ABORT, 'workshop template revisions are immutable');
END;

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
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
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
CREATE INDEX `workshop_sessions_org_state_start_idx` ON `workshop_sessions` (`organization_id`, `state`, `scheduled_start_at`);
CREATE INDEX `workshop_sessions_revision_idx` ON `workshop_sessions` (`template_revision_id`);

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
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assigned_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_session_members_role_valid` CHECK (`role` IN ('participant', 'helper', 'facilitator')),
	CONSTRAINT `workshop_session_members_provision_state_valid` CHECK (`provision_state` IN ('not_ready', 'queued', 'provisioning', 'ready', 'failed', 'ended'))
);
CREATE UNIQUE INDEX `workshop_session_members_session_user_uidx` ON `workshop_session_members` (`session_id`, `user_id`);
CREATE INDEX `workshop_session_members_session_role_idx` ON `workshop_session_members` (`session_id`, `role`, `provision_state`);

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
	`ended_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `workshop_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_workspaces_state_valid` CHECK (`state` IN ('queued', 'provisioning', 'ready', 'recovering', 'ending', 'ended', 'failed')),
	CONSTRAINT `workshop_workspaces_terminal_routes_json_valid` CHECK (json_valid(`terminal_route_usernames_json`))
);
CREATE UNIQUE INDEX `workshop_workspaces_session_user_uidx` ON `workshop_workspaces` (`session_id`, `user_id`);
CREATE INDEX `workshop_workspaces_session_state_idx` ON `workshop_workspaces` (`session_id`, `state`);

CREATE TRIGGER `workshop_workspaces_participant_insert_guard`
BEFORE INSERT ON `workshop_workspaces`
WHEN NOT EXISTS (
	SELECT 1 FROM `workshop_session_members` sm
	WHERE sm.`session_id` = NEW.`session_id`
		AND sm.`user_id` = NEW.`user_id`
		AND sm.`role` = 'participant'
)
BEGIN
	SELECT RAISE(ABORT, 'workshop workspace owner is not a participant');
END;

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
CREATE UNIQUE INDEX `workshop_workspace_generations_ordinal_uidx` ON `workshop_workspace_generations` (`workspace_id`, `ordinal`);
CREATE UNIQUE INDEX `workshop_workspace_generations_execution_uidx` ON `workshop_workspace_generations` (`runtime_execution_id`);
CREATE INDEX `workshop_workspace_generations_workspace_state_idx` ON `workshop_workspace_generations` (`workspace_id`, `state`);

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
CREATE UNIQUE INDEX `workshop_module_progress_session_user_module_uidx` ON `workshop_module_progress` (`session_id`, `user_id`, `module_id`);
CREATE INDEX `workshop_module_progress_session_module_idx` ON `workshop_module_progress` (`session_id`, `module_id`, `technical_status`);

CREATE TRIGGER `workshop_module_progress_participant_insert_guard`
BEFORE INSERT ON `workshop_module_progress`
WHEN NOT EXISTS (
	SELECT 1 FROM `workshop_session_members` sm
	WHERE sm.`session_id` = NEW.`session_id`
		AND sm.`user_id` = NEW.`user_id`
		AND sm.`role` = 'participant'
)
BEGIN
	SELECT RAISE(ABORT, 'workshop progress owner is not a participant');
END;

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
CREATE UNIQUE INDEX `workshop_help_requests_active_key_uidx` ON `workshop_help_requests` (`active_key`);
CREATE INDEX `workshop_help_requests_session_status_idx` ON `workshop_help_requests` (`session_id`, `status`, `created_at`);

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
CREATE UNIQUE INDEX `workshop_assist_grants_help_request_uidx` ON `workshop_assist_grants` (`help_request_id`);
CREATE INDEX `workshop_assist_grants_helper_expiry_idx` ON `workshop_assist_grants` (`helper_user_id`, `expires_at`);
CREATE INDEX `workshop_assist_grants_workspace_expiry_idx` ON `workshop_assist_grants` (`workspace_id`, `expires_at`);

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
CREATE INDEX `workshop_events_session_created_idx` ON `workshop_events` (`session_id`, `created_at`);
CREATE INDEX `workshop_events_org_created_idx` ON `workshop_events` (`organization_id`, `created_at`);

CREATE TRIGGER `workshop_events_append_only_update`
BEFORE UPDATE ON `workshop_events`
BEGIN
	SELECT RAISE(ABORT, 'workshop events are append-only');
END;

CREATE TRIGGER `workshop_events_append_only_delete`
BEFORE DELETE ON `workshop_events`
BEGIN
	SELECT RAISE(ABORT, 'workshop events are append-only');
END;
