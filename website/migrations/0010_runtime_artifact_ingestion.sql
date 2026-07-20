-- Complete the domain-neutral archive ledger. The VM-level seal is separate
-- from execution lifecycle state because a superseded workshop generation can
-- be logically archived while its host is still uploading the final archive.
ALTER TABLE `runtime_vms` ADD COLUMN `artifact_writes_sealed` integer DEFAULT 0 NOT NULL
  CHECK (`artifact_writes_sealed` IN (0, 1));
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
-- Preserve in-flight scenario multipart uploads during the drain migration.
INSERT OR IGNORE INTO `runtime_artifact_uploads` (
	`artifact_id`, `r2_upload_id`, `uploaded_parts_json`,
	`next_expected_part`, `updated_at`
)
SELECT
	upload.`artifact_id`, upload.`r2_upload_id`, upload.`uploaded_parts_json`,
	upload.`next_expected_part`, upload.`updated_at`
FROM `scenario_run_artifact_uploads` upload
JOIN `runtime_artifacts` artifact ON artifact.`id` = upload.`artifact_id`;
--> statement-breakpoint
-- Existing scenario VM seals remain projected from scenario state at request
-- time. This backfill is an optimization and makes the generic ledger accurate
-- before the first idempotent archive retry.
UPDATE `runtime_vms`
SET `artifact_writes_sealed` = 1
WHERE EXISTS (
	SELECT 1
	FROM `runtime_executions` execution
	JOIN `scenario_runs` run ON run.`runtime_execution_id` = execution.`id`
	JOIN json_each(run.`state_json`, '$.vms') vm
	WHERE execution.`id` = `runtime_vms`.`execution_id`
		AND execution.`domain_kind` = 'scenario'
		AND json_extract(vm.value, '$.id') = `runtime_vms`.`vm_id`
		AND json_extract(vm.value, '$.phase') = 'completed'
);
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
