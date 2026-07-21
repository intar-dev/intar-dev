CREATE TABLE `workshop_registry_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`token_prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_registry_tokens_expiry_valid` CHECK (`expires_at` IS NULL OR `expires_at` > `created_at`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_registry_tokens_hash_uidx` ON `workshop_registry_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `workshop_registry_tokens_org_created_idx` ON `workshop_registry_tokens` (`organization_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `workshop_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`workshop_slug` text NOT NULL,
	`content_hash` text NOT NULL,
	`source_r2_key` text NOT NULL,
	`compiled_manifest_json` text NOT NULL,
	`required_checkpoint_ids_json` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`submitted_by` text NOT NULL,
	`registry_token_id` text NOT NULL,
	`builder_host_id` text,
	`published_revision_id` text,
	`error` text,
	`claimed_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`registry_token_id`) REFERENCES `workshop_registry_tokens`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`builder_host_id`) REFERENCES `agent_hosts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`published_revision_id`) REFERENCES `workshop_template_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `workshop_publications_status_valid` CHECK (`status` IN ('queued', 'building', 'failed', 'published')),
	CONSTRAINT `workshop_publications_manifest_json_valid` CHECK (json_valid(`compiled_manifest_json`)),
	CONSTRAINT `workshop_publications_checkpoints_json_valid` CHECK (json_valid(`required_checkpoint_ids_json`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_publications_org_hash_uidx` ON `workshop_publications` (`organization_id`, `content_hash`);
--> statement-breakpoint
CREATE INDEX `workshop_publications_status_created_idx` ON `workshop_publications` (`status`, `created_at`);
--> statement-breakpoint
CREATE INDEX `workshop_publications_builder_status_idx` ON `workshop_publications` (`builder_host_id`, `status`);
--> statement-breakpoint
CREATE TABLE `workshop_publication_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`publication_id` text NOT NULL,
	`checkpoint_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`vm_images_json` text,
	`sanitized` integer DEFAULT false NOT NULL,
	`cold_boot_verified` integer DEFAULT false NOT NULL,
	`error` text,
	`verified_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`publication_id`) REFERENCES `workshop_publications`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `workshop_publication_checkpoints_status_valid` CHECK (`status` IN ('pending', 'building', 'verified', 'failed')),
	CONSTRAINT `workshop_publication_checkpoints_images_json_valid` CHECK (`vm_images_json` IS NULL OR json_valid(`vm_images_json`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workshop_publication_checkpoints_uidx` ON `workshop_publication_checkpoints` (`publication_id`, `checkpoint_id`);
--> statement-breakpoint
CREATE INDEX `workshop_publication_checkpoints_status_idx` ON `workshop_publication_checkpoints` (`publication_id`, `status`);
--> statement-breakpoint
CREATE TRIGGER `workshop_publications_published_immutable`
BEFORE UPDATE ON `workshop_publications`
WHEN OLD.`status` = 'published'
BEGIN
	SELECT RAISE(ABORT, 'published workshop publication is immutable');
END;
