CREATE TABLE `user_ssh_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text,
	`key_type` text NOT NULL,
	`comment` text,
	`public_key_openssh` text NOT NULL,
	`fingerprint_sha256` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_ssh_keys_user_idx` ON `user_ssh_keys` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_ssh_keys_user_fingerprint_uidx` ON `user_ssh_keys` (`user_id`,`fingerprint_sha256`);