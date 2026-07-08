DROP TABLE `invitation`;--> statement-breakpoint
DELETE FROM `member` WHERE rowid NOT IN (SELECT MIN(rowid) FROM `member` GROUP BY `organization_id`, `user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_org_user_uidx` ON `member` (`organization_id`,`user_id`);--> statement-breakpoint
ALTER TABLE `session` DROP COLUMN `active_organization_id`;
