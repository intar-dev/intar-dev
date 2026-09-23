CREATE TABLE `access_revocations` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revocation_id` text NOT NULL,
	`revoked_by` text NOT NULL,
	`reason` text NOT NULL,
	`revoked_at` integer NOT NULL,
	`cleanup_attempt_id` text,
	`cleanup_started_at` integer,
	`cleanup_completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "access_revocations_audit_valid" CHECK(length("access_revocations"."revoked_by") BETWEEN 1 AND 255 AND length("access_revocations"."reason") BETWEEN 1 AND 120 AND "access_revocations"."revoked_at" >= 0),
	CONSTRAINT "access_revocations_cleanup_valid" CHECK(
        ("access_revocations"."cleanup_attempt_id" is null
          AND "access_revocations"."cleanup_started_at" is null
          AND "access_revocations"."cleanup_completed_at" is null)
        OR
        ("access_revocations"."cleanup_attempt_id" is not null
          AND "access_revocations"."cleanup_started_at" is not null
          AND ("access_revocations"."cleanup_completed_at" is null
            OR "access_revocations"."cleanup_completed_at" >= "access_revocations"."cleanup_started_at")))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_revocations_revocation_uidx` ON `access_revocations` (`revocation_id`);--> statement-breakpoint
CREATE TABLE `signup_reservations` (
	`user_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "signup_reservations_window_valid" CHECK("signup_reservations"."expires_at" > "signup_reservations"."created_at")
);
--> statement-breakpoint
CREATE INDEX `signup_reservations_expires_idx` ON `signup_reservations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `signup_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`signup_limit` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "signup_settings_singleton" CHECK("signup_settings"."id" = 1),
	CONSTRAINT "signup_settings_limit_valid" CHECK("signup_settings"."signup_limit" BETWEEN 0 AND 1000000),
	CONSTRAINT "signup_settings_version_valid" CHECK("signup_settings"."version" > 0)
);
