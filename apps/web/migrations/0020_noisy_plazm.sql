CREATE TABLE `host_enrollments` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`role` text NOT NULL,
	`source_invite_id` text NOT NULL,
	`source_lease_id` text NOT NULL,
	`granted_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer,
	`credential_hash` text,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_enrollments_host_id_unique` ON `host_enrollments` (`host_id`);