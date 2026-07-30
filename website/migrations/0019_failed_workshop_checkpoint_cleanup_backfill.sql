-- Failed provider checkpoint summaries created before this migration omitted
-- their cleanup timestamp even after every verifier attempt was confirmed
-- deleted. Repair only those terminal summaries. A checkpoint with no attempts,
-- an in-flight attempt, or any unconfirmed deletion remains unchanged.
UPDATE `workshop_publication_provider_checkpoints`
SET `deletion_confirmed_at` = (
	SELECT max(attempt.`deletion_confirmed_at`)
	FROM `workshop_publication_provider_attempts` attempt
	WHERE attempt.`provider_checkpoint_id` =
		`workshop_publication_provider_checkpoints`.`id`
)
WHERE `verification_status` = 'failed'
	AND `deletion_confirmed_at` IS NULL
	AND EXISTS (
		SELECT 1
		FROM `workshop_publication_provider_attempts` attempt
		WHERE attempt.`provider_checkpoint_id` =
			`workshop_publication_provider_checkpoints`.`id`
	)
	AND NOT EXISTS (
		SELECT 1
		FROM `workshop_publication_provider_attempts` attempt
		WHERE attempt.`provider_checkpoint_id` =
			`workshop_publication_provider_checkpoints`.`id`
			AND (
				attempt.`state` != 'deleted'
				OR attempt.`deletion_confirmed_at` IS NULL
			)
	);
--> statement-breakpoint
