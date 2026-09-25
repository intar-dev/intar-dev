CREATE TABLE `organization_member_removals` (
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`removed_by` text NOT NULL,
	`removed_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `user_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "organization_member_removals_audit_valid" CHECK(length("organization_member_removals"."removed_by") BETWEEN 1 AND 255 AND "organization_member_removals"."removed_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `organization_member_removals_user_idx` ON `organization_member_removals` (`user_id`);--> statement-breakpoint
CREATE TABLE `organization_member_removed_logins` (
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	PRIMARY KEY(`organization_id`, `issuer`, `subject`),
	FOREIGN KEY (`organization_id`,`user_id`) REFERENCES `organization_member_removals`(`organization_id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `organization_member_removed_logins_removal_idx` ON `organization_member_removed_logins` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `sso_provider_policies` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`allow_external_email_signups` integer DEFAULT false NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `sso_provider`(`provider_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sso_provider_policies_audit_valid" CHECK(length("sso_provider_policies"."updated_by") BETWEEN 1 AND 255 AND "sso_provider_policies"."updated_at" >= 0)
);
--> statement-breakpoint
ALTER TABLE `access_events` ADD `sso_provider_id` text;--> statement-breakpoint
ALTER TABLE `access_events` ADD `sso_account_id` text;--> statement-breakpoint
ALTER TABLE `user` ADD `signup_organization_id` text;--> statement-breakpoint
CREATE INDEX `session_impersonated_by_idx` ON `session` (`impersonated_by`) WHERE "session"."impersonated_by" IS NOT NULL;