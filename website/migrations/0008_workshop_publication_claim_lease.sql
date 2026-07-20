ALTER TABLE `workshop_publications` ADD COLUMN `claim_expires_at` integer;
--> statement-breakpoint
-- NULL legacy building claims are intentionally reclaimable. Their assigned
-- builder can still win the race by resuming the claim before another builder.
CREATE INDEX `workshop_publications_claim_lease_idx` ON `workshop_publications` (`status`, `claim_expires_at`, `created_at`);
