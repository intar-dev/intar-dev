ALTER TABLE `workshop_session_members` ADD `last_seen_at` integer;
--> statement-breakpoint
CREATE INDEX `workshop_session_members_session_last_seen_idx` ON `workshop_session_members` (`session_id`, `last_seen_at`);
