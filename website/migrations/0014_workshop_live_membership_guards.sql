ALTER TABLE `member` ADD `workshop_access_revoking_at` integer;
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
CREATE UNIQUE INDEX `workshop_route_issuance_intents_route_uidx`
ON `workshop_route_issuance_intents` (`kind`, `route_key`);
--> statement-breakpoint
CREATE INDEX `workshop_route_issuance_intents_member_idx`
ON `workshop_route_issuance_intents` (`organization_id`, `actor_user_id`, `state`, `created_at`);
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
		AND roster.`role` = 'participant'
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
		AND roster.`role` = 'participant'
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
CREATE TRIGGER `workshop_workspaces_org_member_update_guard`
BEFORE UPDATE OF `session_id`, `user_id` ON `workshop_workspaces`
WHEN NOT EXISTS (
	SELECT 1
	FROM `workshop_sessions` session
	JOIN `member` organization_member
		ON organization_member.`organization_id` = session.`organization_id`
	JOIN `workshop_session_members` roster
		ON roster.`session_id` = session.`id`
		AND roster.`user_id` = NEW.`user_id`
		AND roster.`role` = 'participant'
	WHERE session.`id` = NEW.`session_id`
		AND organization_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop workspace owner is not an active organization participant');
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
		AND roster.`role` = 'participant'
	WHERE workspace.`id` = NEW.`workspace_id`
		AND organization_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop generation owner is not an active organization participant');
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
		AND roster.`role` = 'participant'
	WHERE workspace.`id` = NEW.`workspace_id`
		AND organization_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop generation owner is not an active organization participant');
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
CREATE TRIGGER `workshop_session_members_org_member_update_guard`
BEFORE UPDATE OF `session_id`, `user_id`, `role` ON `workshop_session_members`
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
		AND requester_roster.`role` = 'participant'
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
		AND requester_roster.`role` = 'participant'
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
		AND learner_roster.`role` = 'participant'
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
		AND learner_roster.`role` = 'participant'
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
		AND learner_member.`workshop_access_revoking_at` IS NULL
		AND helper_member.`workshop_access_revoking_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'workshop assistance identities are no longer authorized');
END;
