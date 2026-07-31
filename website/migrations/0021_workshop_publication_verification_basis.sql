ALTER TABLE `workshop_publication_provider_checkpoints`
ADD COLUMN `verification_basis_checkpoint_id` text;
--> statement-breakpoint
CREATE INDEX `workshop_publication_provider_verification_basis_idx`
ON `workshop_publication_provider_checkpoints` (`verification_basis_checkpoint_id`);
