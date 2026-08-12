CREATE TABLE `access_invite_codes_0003_new` (
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
	CONSTRAINT `access_invite_codes_hash_valid` CHECK (length(`code_hash`) = 64 AND `code_hash` NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT `access_invite_codes_kind_valid` CHECK (`kind` IN ('standard', 'bootstrap_admin')),
	CONSTRAINT `access_invite_codes_creator_valid` CHECK ((`kind` = 'standard' AND `created_by` IS NOT NULL) OR (`kind` = 'bootstrap_admin' AND `created_by` IS NULL)),
	CONSTRAINT `access_invite_codes_expiry_valid` CHECK (`expires_at` IN (`created_at` + 172800000, `created_at` + 1209600000)),
	CONSTRAINT `access_invite_codes_version_valid` CHECK (`version` > 0),
	CONSTRAINT `access_invite_codes_replacement_valid` CHECK ((`replaces_invite_id` IS NULL AND `replaces_invite_version` IS NULL) OR (`replaces_invite_id` IS NOT NULL AND `replaces_invite_version` > 0)),
	CONSTRAINT `access_invite_codes_state_valid` CHECK (
		(`state` = 'pending'
			AND `lease_id` IS NULL AND `leased_at` IS NULL AND `lease_expires_at` IS NULL
			AND `redeemer_user_id` IS NULL AND `redeemer_github_account_id` IS NULL
			AND `redeemer_github_username` IS NULL AND `redeemed_at` IS NULL
			AND `revoked_by` IS NULL AND `revocation_reason` IS NULL AND `revoked_at` IS NULL
			AND `replaced_by_invite_id` IS NULL)
		OR (`state` = 'leased'
			AND `lease_id` IS NOT NULL AND `leased_at` IS NOT NULL
			AND `lease_expires_at` = `leased_at` + 600000
			AND `redeemer_user_id` IS NULL AND `redeemer_github_account_id` IS NULL
			AND `redeemer_github_username` IS NULL AND `redeemed_at` IS NULL
			AND `revoked_by` IS NULL AND `revocation_reason` IS NULL AND `revoked_at` IS NULL
			AND `replaced_by_invite_id` IS NULL)
		OR (`state` = 'redeemed'
			AND `lease_id` IS NOT NULL AND `leased_at` IS NOT NULL
			AND `lease_expires_at` = `leased_at` + 600000
			AND `redeemer_user_id` IS NOT NULL AND `redeemer_github_account_id` IS NOT NULL
			AND `redeemer_github_username` IS NOT NULL AND `redeemed_at` IS NOT NULL
			AND `revoked_by` IS NULL AND `revocation_reason` IS NULL AND `revoked_at` IS NULL
			AND `replaced_by_invite_id` IS NULL)
		OR (`state` = 'revoked'
			AND `lease_id` IS NULL AND `leased_at` IS NULL AND `lease_expires_at` IS NULL
			AND `redeemer_user_id` IS NULL AND `redeemer_github_account_id` IS NULL
			AND `redeemer_github_username` IS NULL AND `redeemed_at` IS NULL
			AND `revoked_by` IS NOT NULL AND `revocation_reason` IS NOT NULL AND `revoked_at` IS NOT NULL)
	)
);
--> statement-breakpoint
INSERT INTO `access_invite_codes_0003_new` (
	`id`, `code_hash`, `code_prefix`, `kind`, `state`, `label`, `created_by`,
	`created_at`, `expires_at`, `lease_id`, `leased_at`, `lease_expires_at`,
	`redeemer_user_id`, `redeemer_github_account_id`, `redeemer_github_username`,
	`redeemed_at`, `revoked_by`, `revocation_reason`, `revoked_at`,
	`replaces_invite_id`, `replaces_invite_version`, `replaced_by_invite_id`,
	`version`, `updated_at`
)
SELECT
	`id`, `code_hash`, `code_prefix`, `kind`, `state`, `label`, `created_by`,
	`created_at`, `expires_at`, `lease_id`, `leased_at`, `lease_expires_at`,
	`redeemer_user_id`, `redeemer_github_account_id`, `redeemer_github_username`,
	`redeemed_at`, `revoked_by`, `revocation_reason`, `revoked_at`,
	`replaces_invite_id`, `replaces_invite_version`, `replaced_by_invite_id`,
	`version`, `updated_at`
FROM `access_invite_codes`;
--> statement-breakpoint
CREATE TABLE `access_allowlist_0003_backup` AS
SELECT
	`user_id`, `state`, `github_account_id`, `github_username`,
	`source_invite_id`, `source_lease_id`, `granted_by`, `grant_reason`,
	`granted_at`, `revocation_id`, `revoked_by`, `revocation_reason`,
	`revoked_at`, `revocation_cleanup_attempt_id`,
	`revocation_cleanup_started_at`, `revocation_cleanup_completed_at`
FROM `access_allowlist`;
--> statement-breakpoint
DROP TRIGGER `access_allowlist_claim_invite`;
--> statement-breakpoint
DROP TRIGGER `access_allowlist_active_delete_guard`;
--> statement-breakpoint
DROP TRIGGER `access_allowlist_granted_event`;
--> statement-breakpoint
DELETE FROM `access_allowlist`;
--> statement-breakpoint
DROP TABLE `access_invite_codes`;
--> statement-breakpoint
ALTER TABLE `access_invite_codes_0003_new` RENAME TO `access_invite_codes`;
--> statement-breakpoint
CREATE UNIQUE INDEX `access_invite_codes_hash_uidx` ON `access_invite_codes` (`code_hash`);
--> statement-breakpoint
CREATE INDEX `access_invite_codes_state_expiry_idx` ON `access_invite_codes` (`state`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `access_invite_codes_creator_idx` ON `access_invite_codes` (`created_by`,`created_at`);
--> statement-breakpoint
CREATE INDEX `access_invite_codes_lease_idx` ON `access_invite_codes` (`state`,`lease_expires_at`);
--> statement-breakpoint
CREATE TRIGGER `access_invite_codes_issuer_guard`
BEFORE INSERT ON `access_invite_codes`
WHEN NEW.`kind` = 'standard'
BEGIN
	SELECT CASE
		WHEN NOT EXISTS (
			SELECT 1
			FROM `access_allowlist` AS access
			JOIN `user` AS identity ON identity.`id` = access.`user_id`
			WHERE access.`user_id` = NEW.`created_by`
				AND access.`state` = 'active'
				AND coalesce(identity.`banned`, 0) = 0
				AND instr(
					',' || replace(lower(coalesce(identity.`role`, '')), ' ', '') || ',',
					',admin,'
				) > 0
		)
		THEN RAISE(ABORT, 'access invite issuer must be an active unbanned administrator')
	END;
END;
--> statement-breakpoint
CREATE TRIGGER `access_invite_codes_replacement_insert`
BEFORE INSERT ON `access_invite_codes`
WHEN NEW.`replaces_invite_id` IS NOT NULL
BEGIN
	SELECT CASE
		WHEN NEW.`kind` <> 'standard' OR NEW.`created_by` IS NULL
		THEN RAISE(ABORT, 'only an administrator can replace a standard invite')
	END;

	UPDATE `access_invite_codes`
	SET `state` = 'revoked',
		`lease_id` = NULL,
		`leased_at` = NULL,
		`lease_expires_at` = NULL,
		`revoked_by` = NEW.`created_by`,
		`revocation_reason` = 'replaced',
		`revoked_at` = NEW.`created_at`,
		`replaced_by_invite_id` = NEW.`id`,
		`version` = `version` + 1,
		`updated_at` = NEW.`created_at`
	WHERE `id` = NEW.`replaces_invite_id`
		AND `kind` = 'standard'
		AND `state` IN ('pending', 'leased')
		AND `version` = NEW.`replaces_invite_version`;

	SELECT CASE
		WHEN changes() <> 1
		THEN RAISE(ABORT, 'invite replacement lost its version race')
	END;
END;
--> statement-breakpoint
CREATE TRIGGER `access_invite_codes_revoker_guard`
BEFORE UPDATE OF `state` ON `access_invite_codes`
WHEN OLD.`state` IN ('pending', 'leased')
	AND NEW.`state` = 'revoked'
BEGIN
	SELECT CASE
		WHEN NOT EXISTS (
			SELECT 1
			FROM `access_allowlist` AS access
			JOIN `user` AS identity ON identity.`id` = access.`user_id`
			WHERE access.`user_id` = NEW.`revoked_by`
				AND access.`state` = 'active'
				AND coalesce(identity.`banned`, 0) = 0
				AND instr(
					',' || replace(lower(coalesce(identity.`role`, '')), ' ', '') || ',',
					',admin,'
				) > 0
		)
		THEN RAISE(ABORT, 'access invite revoker must be an active unbanned administrator')
	END;
END;
--> statement-breakpoint
CREATE TRIGGER `access_invite_codes_transition_guard`
BEFORE UPDATE ON `access_invite_codes`
WHEN NEW.`id` IS NOT OLD.`id`
	OR NEW.`code_hash` IS NOT OLD.`code_hash`
	OR NEW.`code_prefix` IS NOT OLD.`code_prefix`
	OR NEW.`kind` IS NOT OLD.`kind`
	OR NEW.`label` IS NOT OLD.`label`
	OR NEW.`created_by` IS NOT OLD.`created_by`
	OR NEW.`created_at` IS NOT OLD.`created_at`
	OR NEW.`expires_at` IS NOT OLD.`expires_at`
	OR NEW.`replaces_invite_id` IS NOT OLD.`replaces_invite_id`
	OR NEW.`replaces_invite_version` IS NOT OLD.`replaces_invite_version`
	OR NEW.`version` <> OLD.`version` + 1
	OR NEW.`updated_at` < OLD.`updated_at`
	OR NOT (
		(OLD.`state` = 'pending' AND NEW.`state` IN ('leased', 'revoked'))
		OR (OLD.`state` = 'leased' AND NEW.`state` IN ('pending', 'redeemed', 'revoked'))
		OR (OLD.`state` = 'leased' AND NEW.`state` = 'leased'
			AND OLD.`lease_expires_at` <= NEW.`leased_at`
			AND OLD.`lease_id` <> NEW.`lease_id`)
	)
BEGIN
	SELECT RAISE(ABORT, 'invalid access invite transition');
END;
--> statement-breakpoint
CREATE TRIGGER `access_invite_codes_delete_guard`
BEFORE DELETE ON `access_invite_codes`
BEGIN
	SELECT RAISE(ABORT, 'access invites must be retained in the audit timeline');
END;
--> statement-breakpoint
CREATE TRIGGER `access_invite_codes_created_event`
AFTER INSERT ON `access_invite_codes`
BEGIN
	INSERT INTO `access_events` (
		`id`, `event_type`, `invite_id`, `actor_user_id`, `reason`, `created_at`
	) VALUES (
		lower(hex(randomblob(16))), 'invite.created', NEW.`id`, NEW.`created_by`,
		NEW.`kind`, NEW.`created_at`
	);
END;
--> statement-breakpoint
CREATE TRIGGER `access_invite_codes_transition_event`
AFTER UPDATE OF `state` ON `access_invite_codes`
BEGIN
	INSERT INTO `access_events` (
		`id`, `event_type`, `invite_id`, `subject_user_id`,
		`github_account_id`, `actor_user_id`, `reason`, `created_at`
	) VALUES (
		lower(hex(randomblob(16))),
		CASE
			WHEN NEW.`state` = 'leased' THEN 'invite.leased'
			WHEN NEW.`state` = 'pending' THEN 'invite.lease_released'
			WHEN NEW.`state` = 'redeemed' THEN 'invite.redeemed'
			WHEN NEW.`state` = 'revoked' AND NEW.`replaced_by_invite_id` IS NOT NULL
				THEN 'invite.replaced'
			ELSE 'invite.revoked'
		END,
		NEW.`id`,
		NEW.`redeemer_user_id`,
		NEW.`redeemer_github_account_id`,
		CASE
			WHEN NEW.`state` = 'redeemed' THEN NEW.`redeemer_user_id`
			WHEN NEW.`state` = 'revoked' THEN NEW.`revoked_by`
			ELSE NULL
		END,
		CASE
			WHEN NEW.`state` = 'revoked' THEN NEW.`revocation_reason`
			ELSE NULL
		END,
		NEW.`updated_at`
	);
END;
--> statement-breakpoint
INSERT INTO `access_allowlist` (
	`user_id`, `state`, `github_account_id`, `github_username`,
	`source_invite_id`, `source_lease_id`, `granted_by`, `grant_reason`,
	`granted_at`, `revocation_id`, `revoked_by`, `revocation_reason`,
	`revoked_at`, `revocation_cleanup_attempt_id`,
	`revocation_cleanup_started_at`, `revocation_cleanup_completed_at`
)
SELECT
	`user_id`, `state`, `github_account_id`, `github_username`,
	`source_invite_id`, `source_lease_id`, `granted_by`, `grant_reason`,
	`granted_at`, `revocation_id`, `revoked_by`, `revocation_reason`,
	`revoked_at`, `revocation_cleanup_attempt_id`,
	`revocation_cleanup_started_at`, `revocation_cleanup_completed_at`
FROM `access_allowlist_0003_backup`;
--> statement-breakpoint
DROP TABLE `access_allowlist_0003_backup`;
--> statement-breakpoint
CREATE TRIGGER `access_allowlist_claim_invite`
BEFORE INSERT ON `access_allowlist`
BEGIN
	SELECT CASE
		WHEN NEW.`state` <> 'active'
		THEN RAISE(ABORT, 'beta access can only be inserted as active')
	END;

	SELECT CASE
		WHEN NOT EXISTS (
			SELECT 1 FROM `account`
			WHERE `provider_id` = 'github'
				AND `account_id` = NEW.`github_account_id`
				AND `user_id` = NEW.`user_id`
		)
		THEN RAISE(ABORT, 'GitHub account does not belong to the Better Auth user')
	END;

	SELECT CASE
		WHEN EXISTS (
			SELECT 1
			FROM `access_events` AS reinvite
			JOIN `access_invite_codes` AS candidate
				ON candidate.`id` = NEW.`source_invite_id`
			WHERE reinvite.`event_type` = 'access.reinvite_allowed'
				AND reinvite.`subject_user_id` = NEW.`user_id`
				AND reinvite.`created_at` >= candidate.`created_at`
		)
		THEN RAISE(ABORT, 'fresh beta invite required after block clear')
	END;

	UPDATE `access_invite_codes`
	SET `state` = 'redeemed',
		`redeemer_user_id` = NEW.`user_id`,
		`redeemer_github_account_id` = NEW.`github_account_id`,
		`redeemer_github_username` = NEW.`github_username`,
		`redeemed_at` = NEW.`granted_at`,
		`version` = `version` + 1,
		`updated_at` = NEW.`granted_at`
	WHERE `id` = NEW.`source_invite_id`
		AND `state` = 'leased'
		AND `lease_id` = NEW.`source_lease_id`
		AND `leased_at` <= NEW.`granted_at`
		AND `lease_expires_at` > NEW.`granted_at`
		AND `created_by` IS NEW.`granted_by`
		AND `kind` = NEW.`grant_reason`
		AND (
			`kind` <> 'bootstrap_admin'
			OR EXISTS (
				SELECT 1 FROM `user`
				WHERE `id` = NEW.`user_id`
					AND instr(
						',' || replace(lower(coalesce(`role`, '')), ' ', '') || ',',
						',admin,'
					) > 0
			)
		);

	SELECT CASE
		WHEN changes() <> 1
		THEN RAISE(ABORT, 'invite lease is invalid, expired, or already claimed')
	END;
END;
--> statement-breakpoint
CREATE TRIGGER `access_allowlist_active_delete_guard`
BEFORE DELETE ON `access_allowlist`
WHEN OLD.`state` <> 'blocked'
	OR OLD.`revocation_cleanup_completed_at` IS NULL
	OR NOT EXISTS (
		SELECT 1
		FROM `access_events` AS clear_command
		WHERE clear_command.`event_type` = 'access.reinvite_allowed'
			AND clear_command.`subject_user_id` = OLD.`user_id`
			AND clear_command.`revocation_id` = OLD.`revocation_id`
			AND clear_command.`reason` = 'admin_cleared_block'
	)
BEGIN
	SELECT RAISE(ABORT, 'beta access deletion requires an audited completed block clear');
END;
--> statement-breakpoint
CREATE TRIGGER `access_allowlist_granted_event`
AFTER INSERT ON `access_allowlist`
BEGIN
	INSERT INTO `access_events` (
		`id`, `event_type`, `invite_id`, `subject_user_id`, `github_account_id`,
		`actor_user_id`, `reason`, `created_at`
	) VALUES (
		lower(hex(randomblob(16))), 'access.granted', NEW.`source_invite_id`,
		NEW.`user_id`, NEW.`github_account_id`, NEW.`granted_by`,
		NEW.`grant_reason`, NEW.`granted_at`
	);
END;
--> statement-breakpoint
CREATE TABLE `access_invite_removals` (
	`invite_id` text PRIMARY KEY NOT NULL,
	`invite_version` integer NOT NULL,
	`removed_by` text NOT NULL,
	`removed_at` integer NOT NULL,
	FOREIGN KEY (`invite_id`) REFERENCES `access_invite_codes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `access_invite_removals_version_valid` CHECK (`invite_version` > 0),
	CONSTRAINT `access_invite_removals_actor_valid` CHECK (length(`removed_by`) BETWEEN 1 AND 255),
	CONSTRAINT `access_invite_removals_timestamp_valid` CHECK (`removed_at` >= 0)
);
--> statement-breakpoint
CREATE INDEX `access_invite_removals_removed_idx`
ON `access_invite_removals` (`removed_at`);
--> statement-breakpoint
DROP TRIGGER `access_events_insert_guard`;
--> statement-breakpoint
CREATE TRIGGER `access_events_insert_guard`
BEFORE INSERT ON `access_events`
WHEN NEW.`event_type` NOT IN (
	'invite.created',
	'invite.leased',
	'invite.lease_released',
	'invite.redeemed',
	'invite.revoked',
	'invite.replaced',
	'invite.removed',
	'invite.exchange_failed',
	'invite.lease_failed',
	'invite.claim_failed',
	'access.granted',
	'access.blocked',
	'access.revocation_cleanup_failed',
	'access.revocation_cleanup_stalled',
	'access.revocation_cleanup_completed',
	'access.reinvite_allowed'
)
	OR (NEW.`event_type` = 'invite.removed' AND (
		NEW.`invite_id` IS NULL
		OR NEW.`actor_user_id` IS NULL
		OR NEW.`reason` IS NULL
		OR NEW.`reason` <> 'admin_removed'
		OR NEW.`subject_user_id` IS NOT NULL
		OR NEW.`github_account_id` IS NOT NULL
		OR NEW.`revocation_id` IS NOT NULL
	))
	OR (NEW.`event_type` IN (
		'access.revocation_cleanup_failed',
		'access.revocation_cleanup_stalled',
		'access.revocation_cleanup_completed'
	) AND NEW.`cleanup_attempt_id` IS NULL)
	OR (NEW.`event_type` NOT IN (
		'access.revocation_cleanup_failed',
		'access.revocation_cleanup_stalled',
		'access.revocation_cleanup_completed'
	) AND NEW.`cleanup_attempt_id` IS NOT NULL)
	OR (NEW.`reason` IS NOT NULL AND (
		length(NEW.`reason`) > 120
		OR NEW.`reason` GLOB '*[^-a-z0-9._:]*'
	))
BEGIN
	SELECT RAISE(ABORT, 'invalid access audit event');
END;
--> statement-breakpoint
CREATE TRIGGER `access_invite_removals_insert_command`
BEFORE INSERT ON `access_invite_removals`
BEGIN
	SELECT CASE
		WHEN NOT EXISTS (
			SELECT 1
			FROM `access_allowlist` AS access
			JOIN `user` AS identity ON identity.`id` = access.`user_id`
			WHERE access.`user_id` = NEW.`removed_by`
				AND access.`state` = 'active'
				AND coalesce(identity.`banned`, 0) = 0
				AND instr(
					',' || replace(lower(coalesce(identity.`role`, '')), ' ', '') || ',',
					',admin,'
				) > 0
		)
		THEN RAISE(ABORT, 'access invite remover must be an active unbanned administrator')
	END;

	SELECT CASE
		WHEN EXISTS (
			SELECT 1 FROM `access_invite_removals`
			WHERE `invite_id` = NEW.`invite_id`
		)
		THEN RAISE(IGNORE)
	END;

	SELECT CASE
		WHEN NOT EXISTS (
			SELECT 1 FROM `access_invite_codes`
			WHERE `id` = NEW.`invite_id`
				AND `version` = NEW.`invite_version`
		)
		THEN RAISE(ABORT, 'invite removal lost its version race')
	END;

	UPDATE `access_invite_codes`
	SET `state` = 'revoked',
		`lease_id` = NULL,
		`leased_at` = NULL,
		`lease_expires_at` = NULL,
		`revoked_by` = NEW.`removed_by`,
		`revocation_reason` = 'admin_removed',
		`revoked_at` = NEW.`removed_at`,
		`version` = `version` + 1,
		`updated_at` = NEW.`removed_at`
	WHERE `id` = NEW.`invite_id`
		AND `version` = NEW.`invite_version`
		AND `state` IN ('pending', 'leased');
END;
--> statement-breakpoint
CREATE TRIGGER `access_invite_removals_append_only_update`
BEFORE UPDATE ON `access_invite_removals`
BEGIN
	SELECT RAISE(ABORT, 'access invite removals are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `access_invite_removals_append_only_delete`
BEFORE DELETE ON `access_invite_removals`
BEGIN
	SELECT RAISE(ABORT, 'access invite removals are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `access_invite_removals_event`
AFTER INSERT ON `access_invite_removals`
BEGIN
	INSERT INTO `access_events` (
		`id`, `event_type`, `invite_id`, `actor_user_id`, `reason`, `created_at`
	) VALUES (
		lower(hex(randomblob(16))), 'invite.removed', NEW.`invite_id`,
		NEW.`removed_by`, 'admin_removed', NEW.`removed_at`
	);
END;
--> statement-breakpoint
PRAGMA foreign_key_check;
