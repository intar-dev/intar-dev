ALTER TABLE `machine_builds` ADD `arm64_asked` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `machine_builds` ADD `arm64_state` text;--> statement-breakpoint
ALTER TABLE `machine_builds` ADD `arm64_image_digest` text;--> statement-breakpoint
ALTER TABLE `machine_builds` ADD `arm64_error` text;