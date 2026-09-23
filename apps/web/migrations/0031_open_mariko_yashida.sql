PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
DROP TABLE `access_allowlist`;--> statement-breakpoint
DROP TABLE `access_invite_codes`;--> statement-breakpoint
DROP TABLE `access_invite_removals`;--> statement-breakpoint
ALTER TABLE `host_enrollments` DROP COLUMN `source_invite_id`;--> statement-breakpoint
ALTER TABLE `host_enrollments` DROP COLUMN `source_lease_id`;--> statement-breakpoint
ALTER TABLE `host_enrollments` DROP COLUMN `granted_at`;--> statement-breakpoint
ALTER TABLE `personal_image_preparations` DROP COLUMN `beta_json`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
