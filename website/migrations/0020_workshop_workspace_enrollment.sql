ALTER TABLE `workshop_session_members`
ADD `workspace_enabled` integer DEFAULT 0 NOT NULL
CHECK (`workspace_enabled` IN (0, 1));
--> statement-breakpoint
UPDATE `workshop_session_members`
SET `workspace_enabled` = 1
WHERE `role` = 'participant';
--> statement-breakpoint
CREATE INDEX `workshop_session_members_session_workspace_idx`
ON `workshop_session_members` (`session_id`, `workspace_enabled`, `provision_state`);
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
DROP TRIGGER `workshop_session_members_runtime_update_guard`;
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
DROP TRIGGER `workshop_workspaces_participant_insert_guard`;
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
DROP TRIGGER `workshop_module_progress_participant_insert_guard`;
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
DROP TRIGGER `runtime_executions_workshop_member_insert_guard`;
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
DROP TRIGGER `runtime_executions_workshop_member_update_guard`;
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
DROP TRIGGER `workshop_workspaces_org_member_update_guard`;
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
DROP TRIGGER `workshop_workspace_generations_org_member_insert_guard`;
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
DROP TRIGGER `workshop_workspace_generations_org_member_update_guard`;
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
DROP TRIGGER `workshop_session_members_org_member_update_guard`;
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
DROP TRIGGER `workshop_help_requests_live_requester_insert_guard`;
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
DROP TRIGGER `workshop_help_requests_live_claim_update_guard`;
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
DROP TRIGGER `workshop_assist_grants_live_identity_insert_guard`;
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
DROP TRIGGER `workshop_assist_grants_live_identity_update_guard`;
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
-- Recreate the provider-connection fences last so the workspace entitlement
-- trigger replacement above does not change the established validation order.
DROP TRIGGER `runtime_executions_provider_connection_insert_guard`;
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
DROP TRIGGER `runtime_executions_provider_connection_update_guard`;
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
