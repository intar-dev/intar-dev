CREATE TABLE IF NOT EXISTS `image_build_coordination_locks` (
	`key` text PRIMARY KEY NOT NULL,
	`owner_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `image_build_coordination_locks_expiry_idx` ON `image_build_coordination_locks` (`expires_at`);
