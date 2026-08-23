ALTER TABLE `access_invite_codes` ADD `claim_expires_at` integer;
--> statement-breakpoint
UPDATE `access_invite_codes`
SET
	`state` = 'revoked',
	`lease_id` = null,
	`leased_at` = null,
	`lease_expires_at` = null,
	`redeemer_user_id` = null,
	`redeemer_github_account_id` = null,
	`redeemer_github_username` = null,
	`redeemed_at` = null,
	`revoked_by` = coalesce(`created_by`, 'system:invite-cutover'),
	`revocation_reason` = 'security_simplification_cutover',
	`revoked_at` = cast(unixepoch('subsecond') * 1000 as integer),
	`version` = `version` + 1,
	`updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
WHERE `state` in ('pending', 'leased')
	AND `token_ciphertext` is null;
--> statement-breakpoint
INSERT INTO `access_events` (
	`id`,
	`event_type`,
	`invite_id`,
	`actor_user_id`,
	`reason`,
	`created_at`
)
SELECT
	'invite-cutover-' || `invite`.`id`,
	'invite.revoked',
	`invite`.`id`,
	`invite`.`revoked_by`,
	`invite`.`revocation_reason`,
	`invite`.`revoked_at`
FROM `access_invite_codes` AS `invite`
WHERE `invite`.`state` = 'revoked'
	AND `invite`.`revocation_reason` = 'security_simplification_cutover'
	AND NOT EXISTS (
		SELECT 1
		FROM `access_events` AS `event`
		WHERE `event`.`invite_id` = `invite`.`id`
			AND `event`.`event_type` = 'invite.revoked'
			AND `event`.`reason` = 'security_simplification_cutover'
	);
