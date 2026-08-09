DROP TRIGGER `workshop_publications_published_immutable`;
--> statement-breakpoint
CREATE TRIGGER `workshop_publications_published_immutable`
BEFORE UPDATE ON `workshop_publications`
WHEN OLD.`status` = 'published'
  AND (
    OLD.`builder_host_id` IS NULL
    OR NEW.`builder_host_id` IS NOT NULL
    OR NEW.`id` IS NOT OLD.`id`
    OR NEW.`organization_id` IS NOT OLD.`organization_id`
    OR NEW.`workshop_slug` IS NOT OLD.`workshop_slug`
    OR NEW.`content_hash` IS NOT OLD.`content_hash`
    OR NEW.`source_r2_key` IS NOT OLD.`source_r2_key`
    OR NEW.`compiled_manifest_json` IS NOT OLD.`compiled_manifest_json`
    OR NEW.`required_checkpoint_ids_json` IS NOT OLD.`required_checkpoint_ids_json`
    OR NEW.`status` IS NOT OLD.`status`
    OR NEW.`submitted_by` IS NOT OLD.`submitted_by`
    OR NEW.`registry_token_id` IS NOT OLD.`registry_token_id`
    OR NEW.`published_revision_id` IS NOT OLD.`published_revision_id`
    OR NEW.`error` IS NOT OLD.`error`
    OR NEW.`claimed_at` IS NOT OLD.`claimed_at`
    OR NEW.`finished_at` IS NOT OLD.`finished_at`
    OR NEW.`created_at` IS NOT OLD.`created_at`
    OR NEW.`updated_at` IS NOT OLD.`updated_at`
    OR NEW.`claim_expires_at` IS NOT OLD.`claim_expires_at`
    OR NEW.`runtime_profile_resolutions_json` IS NOT OLD.`runtime_profile_resolutions_json`
    OR NEW.`certification_state` IS NOT OLD.`certification_state`
  )
BEGIN
  SELECT RAISE(ABORT, 'published workshop publication is immutable');
END;
