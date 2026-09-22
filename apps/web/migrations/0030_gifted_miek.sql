CREATE TABLE `support_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`author_id` text,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `support_topics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `support_comments_topic_idx` ON `support_comments` (`topic_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `support_comments_author_idx` ON `support_comments` (`author_id`);--> statement-breakpoint
CREATE TABLE `support_topics` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_activity_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`solved_at` integer,
	`solved_by_id` text,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`solved_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "support_topic_type" CHECK("support_topics"."type" in ('bug', 'help', 'feedback')),
	CONSTRAINT "support_topic_status" CHECK("support_topics"."status" in ('open', 'solved')),
	CONSTRAINT "support_topic_resolution" CHECK(("support_topics"."status" = 'open' and "support_topics"."solved_at" is null and "support_topics"."solved_by_id" is null) or ("support_topics"."status" = 'solved' and "support_topics"."solved_at" is not null))
);
--> statement-breakpoint
CREATE INDEX `support_topics_activity_idx` ON `support_topics` (`last_activity_at`,`id`);--> statement-breakpoint
CREATE INDEX `support_topics_author_idx` ON `support_topics` (`author_id`,`last_activity_at`);--> statement-breakpoint
CREATE INDEX `support_topics_status_idx` ON `support_topics` (`status`,`last_activity_at`);